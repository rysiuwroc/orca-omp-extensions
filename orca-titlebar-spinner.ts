const BRAILLE_FRAMES = [
  '\u280b',
  '\u2819',
  '\u2839',
  '\u2838',
  '\u283c',
  '\u2834',
  '\u2826',
  '\u2827',
  '\u2807',
  '\u280f'
]

type SpinnerState = 'idle' | 'working' | 'attention'

function getBaseTitle(pi) {
  const cwd = process.cwd().split(/[\\/]/).filter(Boolean).at(-1) || process.cwd()
  const session = pi.getSessionName()
  return session ? `\u03c0 - ${session} - ${cwd}` : `\u03c0 - ${cwd}`
}

export default function (pi) {
  if (!process.env.ORCA_PANE_KEY) return

  const TITLE_OWNER_KEY = '__orcaOmpTitleOwner'
  // cross-process: a nested omp process inherits the pane env and must not fight for the title
  const ownerPid = process.env.ORCA_PI_TITLE_OWNED
  const selfPid = String(process.pid)
  if (ownerPid && ownerPid !== selfPid) return
  process.env.ORCA_PI_TITLE_OWNED = selfPid
  // in-process: task subagents re-run this factory with their own runner
  if ((globalThis as Record<string, unknown>)[TITLE_OWNER_KEY]) return
  ;(globalThis as Record<string, unknown>)[TITLE_OWNER_KEY] = { pid: selfPid }

  let state: SpinnerState = 'idle'
  let timer: unknown = null
  let usingManagedTimer = false
  let frameIndex = 0
  let lastTitle = ''
  let baseTitle = ''

  function writeTitle(ctx, title: string): void {
    if (title === lastTitle) return
    try {
      ctx.ui.setTitle(title)
      lastTitle = title
    } catch {
      // title is best-effort
    }
  }

  function renderFrame(ctx): void {
    const title = `${BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length]} ${baseTitle}`
    writeTitle(ctx, title)
    frameIndex++
  }

  function clearFrameTimer(ctx): void {
    if (timer === null) return
    if (usingManagedTimer && typeof ctx.clearTimer === 'function') {
      ctx.clearTimer(timer)
    } else {
      clearInterval(timer as number)
    }
    timer = null
    usingManagedTimer = false
  }

  function applyState(ctx, next: SpinnerState): void {
    if (next === state) return
    if (state === 'working') clearFrameTimer(ctx)
    state = next

    if (next === 'working') {
      baseTitle = getBaseTitle(pi)
      frameIndex = 0
      renderFrame(ctx)
      const tick = () => {
        try {
          renderFrame(ctx)
        } catch {
          // title is best-effort
        }
      }
      if (typeof ctx.setInterval === 'function') {
        timer = ctx.setInterval(tick, 120)
        usingManagedTimer = true
      } else {
        const rawTimer = setInterval(tick, 120)
        rawTimer.unref?.()
        timer = rawTimer
      }
      return
    }

    if (next === 'idle') {
      writeTitle(ctx, baseTitle || getBaseTitle(pi))
      return
    }

    writeTitle(ctx, 'omp - action required')
  }

  pi.on('agent_start', (_event, ctx) => {
    applyState(ctx, 'working')
  })

  pi.on('agent_end', (event: { willContinue?: boolean }, ctx) => {
    if (event.willContinue === true) return
    applyState(ctx, 'idle')
  })

  pi.on('tool_approval_requested', (_event, ctx) => {
    applyState(ctx, 'attention')
  })

  pi.on('tool_approval_resolved', (_event, ctx) => {
    applyState(ctx, 'working')
  })

  pi.on('session_shutdown', (_event, ctx) => {
    applyState(ctx, 'idle')
  })
}
