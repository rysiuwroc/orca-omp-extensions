// Why: no package-specific type import here. Pi and OMP expose the same
// extension API, but publish their types under different package names.
// Why: warn-once so a recurring parse error on a malformed endpoint
// file does not spam stderr inside the pi TUI on every event.
let warnedBadEndpoint = false
// Why: Pi awaits extension handlers. Status delivery stays off that
// critical path. Keep a bounded ordered queue so terminal completion
// events cannot be coalesced away behind transient activity.
const HOOK_POST_TIMEOUT_MS = 1000
const PENDING_LIMIT = 8
let activePost = false
type PendingPost = { hookEventName: string; extra: Record<string, unknown>; metadata: Record<string, unknown>; ompRuntime: boolean }
const pending: PendingPost[] = []
let agentEndRetried = false
let sessionMetadata: Record<string, unknown> = {}

function updateSessionMetadata(ctx: unknown): void {
  try {
    const sessionManager = (ctx as { sessionManager?: { getSessionId?: () => unknown; getSessionFile?: () => unknown } } | null)?.sessionManager
    const sessionId = sessionManager?.getSessionId?.()
    const sessionFile = sessionManager?.getSessionFile?.()
    sessionMetadata = typeof sessionId === 'string' && sessionId && typeof sessionFile === 'string' && sessionFile ? { session_id: sessionId } : {}
  } catch {
    // keep last known metadata
  }
}

function updateRuntimeOmpSessionMetadata(ctx: unknown): void {
  updateSessionMetadata(ctx)
}

function getPostSessionMetadata(_ompRuntime: boolean): Record<string, unknown> {
  return sessionMetadata
}


// Why: re-reading the endpoint file on every event is cheap (small file,
// rare changes) but stat+mtime caching avoids re-parsing on every event
// during streaming tool execution. Mirrors the OpenCode plugin cache shape.
let cachedEndpointKey = ''
let cachedEndpointValues: Record<string, string> | null = null

function readEndpointFile(): Record<string, string> | null {
  const path = process.env.ORCA_AGENT_HOOK_ENDPOINT
  if (!path) return null
  try {
    const fs = require('fs')
    try {
      const stat = fs.statSync(path)
      const cacheKey = stat.mtimeMs + ':' + stat.size + ':' + stat.ino
      if (cacheKey === cachedEndpointKey && cachedEndpointValues) {
        return cachedEndpointValues
      }
      const contents: string = fs.readFileSync(path, 'utf8')
      const out: Record<string, string> = {}
      for (const line of contents.split(/\r?\n/)) {
        // Why: parse `KEY=VALUE` (POSIX endpoint.env) and `set KEY=VALUE`
        // (Windows endpoint.cmd) with one regex; strip a trailing CR so
        // mixed-EOL files do not leak \r into the value.
        const m = line.match(/^(?:set\s+)?([A-Z0-9_]+)=(.*)$/)
        if (m) out[m[1]] = m[2].replace(/\r$/, '')
      }
      cachedEndpointKey = cacheKey
      cachedEndpointValues = out
      return out
    } catch (ioErr) {
      cachedEndpointKey = ''
      cachedEndpointValues = null
      throw ioErr
    }
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code
    if (err && code !== 'ENOENT' && !warnedBadEndpoint) {
      warnedBadEndpoint = true
      console.warn('[orca-pi-status] failed to parse endpoint file:', (err as Error).message)
    }
    return null
  }
}

function resolveHookCoords() {
  const fileEnv = readEndpointFile() || {}
  return {
    port: fileEnv.ORCA_AGENT_HOOK_PORT || process.env.ORCA_AGENT_HOOK_PORT,
    token: fileEnv.ORCA_AGENT_HOOK_TOKEN || process.env.ORCA_AGENT_HOOK_TOKEN,
    env: fileEnv.ORCA_AGENT_HOOK_ENV || process.env.ORCA_AGENT_HOOK_ENV || '',
    version: fileEnv.ORCA_AGENT_HOOK_VERSION || process.env.ORCA_AGENT_HOOK_VERSION || '',
  }
}

function processName(value: unknown): string {
  return String(value || '').split(/[\\/]/).pop()?.toLowerCase() || ''
}

const CONFIGURED_HOOK_PATH = '/hook/omp'
let cachedOmpRuntime: boolean | null = null

function isOmpRuntime(): boolean {
  if (cachedOmpRuntime !== null) return cachedOmpRuntime
  if (CONFIGURED_HOOK_PATH === '/hook/omp') {
    cachedOmpRuntime = true
    return true
  }
  const executableNames = [
    processName(process.title),
    processName(process.env._),
    processName(process.argv[1]),
    processName(process.argv[0])
  ]
  cachedOmpRuntime = executableNames.some((name) =>
    ['omp', 'omp.js', 'omp.sh', 'omp.cmd', 'omp.exe', 'omp.bat'].includes(name)
  )
  return cachedOmpRuntime
}

function resolveHookPath(ompRuntime: boolean): string {
  // Why: runtime detection keeps a bare-shell OMP launch from reporting as Pi.
  if (ompRuntime) return '/hook/omp'
  return CONFIGURED_HOOK_PATH
}

function post(hookEventName: string, extra: Record<string, unknown> = {}): void {
  const ompRuntime = isOmpRuntime()
  pending.push({
    hookEventName,
    extra,
    metadata: getPostSessionMetadata(ompRuntime),
    ompRuntime,
  })
  if (pending.length > PENDING_LIMIT) {
    const obsoleteIndex = pending.findIndex((entry) => entry.hookEventName !== 'agent_end')
    if (obsoleteIndex !== -1) pending.splice(obsoleteIndex, 1)
  }
  drainPosts()
}

function drainPosts(): void {
  if (activePost) return
  const next = pending.shift()
  if (!next) return
  activePost = true
  void postOnce(next.hookEventName, next.extra, next.metadata, next.ompRuntime)
    .catch(() => {})
    .finally(() => {
      activePost = false
      drainPosts()
    })
}

async function postOnce(
  hookEventName: string,
  extra: Record<string, unknown>,
  metadata: Record<string, unknown>,
  ompRuntime: boolean
): Promise<void> {
  const coords = resolveHookCoords()
  const paneKey = process.env.ORCA_PANE_KEY
  if (!coords.port || !coords.token || !paneKey) return
  const url = `http://127.0.0.1:${coords.port}${resolveHookPath(ompRuntime)}`
  const body = JSON.stringify({
    paneKey,
    launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN || '',
    tabId: process.env.ORCA_TAB_ID || '',
    worktreeId: process.env.ORCA_WORKTREE_ID || '',
    env: coords.env,
    version: coords.version,
    payload: { hook_event_name: hookEventName, ...metadata, ...extra },
  })
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller?.abort()
      reject(new Error('Orca hook delivery timed out'))
    }, HOOK_POST_TIMEOUT_MS)
    if (typeof timeout.unref === 'function') timeout.unref()
  })
  try {
    const response = await Promise.race([
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': coords.token,
        },
        body,
        ...(controller ? { signal: controller.signal } : {}),
      }),
      timeoutPromise,
    ])
    if (!response.ok) throw new Error(`Orca hook delivery failed: ${response.status}`)
  } catch {
    // Why: status reporting must never fail the pi run just because Orca
    // is unavailable or the loopback request failed (e.g. Orca restart).
    if (hookEventName === 'agent_end' && !agentEndRetried) {
      agentEndRetried = true
      const retryTimer = setTimeout(() => post('agent_end'), 250)
      retryTimer.unref?.()
    }
    if (!isWslRuntime()) return
    postViaWindowsCurl(url, coords, body)
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

// Why: WSL-ness and curl.exe presence cannot change within a process
// lifetime; re-probing /proc and /mnt/c on every failed event would add
// filesystem work to the per-event path.
let cachedIsWslRuntime: boolean | null = null
let cachedWindowsCurlPath: string | null | undefined

function isWslRuntime(): boolean {
  if (cachedIsWslRuntime !== null) return cachedIsWslRuntime
  cachedIsWslRuntime = detectWslRuntime()
  return cachedIsWslRuntime
}

function detectWslRuntime(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true
  try {
    const fs = require('fs')
    for (const path of ['/proc/sys/kernel/osrelease', '/proc/version']) {
      try {
        const contents = String(fs.readFileSync(path, 'utf8'))
        if (/microsoft|wsl/i.test(contents)) return true
      } catch {
        // Why: probe the next runtime hint when a proc file is absent or unreadable.
      }
    }
  } catch {
    return false
  }
  return false
}

function resolveWindowsCurlPath(): string | null {
  if (cachedWindowsCurlPath !== undefined) return cachedWindowsCurlPath
  try {
    const fs = require('fs')
    const curlPath = '/mnt/c/Windows/System32/curl.exe'
    cachedWindowsCurlPath = fs.existsSync(curlPath) ? curlPath : null
  } catch {
    cachedWindowsCurlPath = null
  }
  return cachedWindowsCurlPath
}

// Why: WSL loopback is not the Windows loopback, so a WSL-side POST cannot
// reach Orca. curl.exe runs on the Windows side, where 127.0.0.1 IS the
// listener Orca binds. Fire-and-forget: blocking on the spawn would stall
// the pi event loop (and the TUI) on every hook event.
function postViaWindowsCurl(url: string, coords: { token: string }, body: string): void {
  const curlPath = resolveWindowsCurlPath()
  if (!curlPath) return
  try {
    const { spawn } = require('child_process')
    const child = spawn(
      curlPath,
      [
        '-sS',
        // Why: the spawn is detached from the event loop, so these bounds
        // size a background process, not TUI latency. WSL->Win32 interop
        // connects can exceed 0.5s on loaded machines (observed 3/3 drops
        // to a healthy listener); size for delivery, not snappiness.
        '--connect-timeout', '3',
        '--max-time', '10',
        '--noproxy', '127.0.0.1',
        '-o', 'NUL',
        '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '-H', `X-Orca-Agent-Hook-Token: ${coords.token}`,
        '--data-binary', '@-',
        url
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] }
    )
    child.on('error', () => {})
    child.stdin.on('error', () => {})
    child.stdin.end(body)
  } catch {
    // Why: the bridge is best-effort; a failed spawn must not surface
    // inside the pi TUI.
  }
}

// Why: pi assistant messages carry content as an array of parts
// ({ type: 'text', text } / tool_use / tool_result / reasoning). We only
// surface the concatenated text parts as the visible 'last assistant
// message' for the dashboard preview — tool_use / reasoning would be
// noise (the dashboard already shows the active tool name + input).
function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') out += text
    }
  }
  return out
}

// Why: child agents inherit the lead's pane env; only its process may
// register status hooks. PID identity keeps in-process reloads reporting.
export default function (pi): void {
  const ownerPid = process.env.ORCA_PI_STATUS_OWNED
  const selfPid = String(process.pid)
  if (ownerPid && ownerPid !== selfPid) return
  process.env.ORCA_PI_STATUS_OWNED = selfPid
  const STATUS_OWNER_KEY = '__orcaOmpStatusOwner'
  if ((globalThis as Record<string, unknown>)[STATUS_OWNER_KEY]) return
  ;(globalThis as Record<string, unknown>)[STATUS_OWNER_KEY] = { pid: selfPid }

  pi.on('before_agent_start', (event, ctx) => {
    agentEndRetried = false
    updateRuntimeOmpSessionMetadata(ctx)
    post('before_agent_start', { prompt: event.prompt ?? '' })
  })

  pi.on('agent_start', (_event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    post('agent_start')
  })

  pi.on('tool_execution_start', (event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    post('tool_execution_start', {
      tool_name: event.toolName,
      tool_input: event.args,
    })
  })

  pi.on('tool_execution_end', (event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    post('tool_execution_end', {
      tool_name: event.toolName,
    })
  })

  // Why: capture the assistant's final text on each completed message
  // so the dashboard preview reflects the most recent reply even before
  // agent_end fires. message_end is the right hook because pi guarantees
  // it fires after the message is finalized (post-streaming).
  pi.on('message_end', (event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    if (event.message?.role !== 'assistant') return
    const text = extractAssistantText(event.message)
    if (!text) return
    post('message_end', { role: 'assistant', text })
  })

  pi.on('agent_end', (event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    if (event?.willContinue === true) return
    post('agent_end')
  })
}
