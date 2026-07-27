# orca-omp-extensions

Extensions for [OMP](https://github.com/oh-my-pi/pi-coding-agent) running in the Orca terminal.

## Install

Clone the repository, then use the installer for your platform. Prerequisite: OMP is installed.

```sh
git clone https://github.com/rysiuwroc/orca-omp-extensions.git
cd orca-omp-extensions
```

The installer locates its own directory, so you may also invoke it from elsewhere after cloning.

## Windows (PowerShell 5.1+)

From PowerShell, after cloning the repository:

```powershell
.\install.ps1
```

If your execution policy blocks local scripts, run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\install.ps1
```

The installer creates
`$HOME\.omp\agent\extensions` when needed, copies only the three distributed
files, and reports the target path.

## macOS/Linux (POSIX `sh`)

From a POSIX shell, after cloning the repository:

```sh
sh ./install.sh
```

The installer creates `$HOME/.omp/agent/extensions` when needed, copies only the
three distributed files, and reports the target path.

OMP loads direct `.ts` files from that directory at startup. Restart OMP after
installation (and after any later extension update) for changes to take effect.

## Copy/paste prompt for an agent

```text
Install the Orca OMP extensions for my current user. Clone
https://github.com/rysiuwroc/orca-omp-extensions.git, enter that checkout, and
detect whether this is Windows PowerShell or macOS/Linux. Run the repository's
install.ps1 or install.sh, report the target directory and copied files, then
remind me to restart OMP. Do not copy any other files or use another user's
home directory.
```

# Maintainer notes

This repository mirrors the extensions distributed by Orca:

| file | owner | purpose |
|---|---|---|
| `orca-agent-status.ts` | Orca-managed | POSTs agent lifecycle state to Orca's `/hook/omp` endpoint (pane rows and dashboard state) |
| `orca-titlebar-spinner.ts` | Orca-managed | Drives the terminal title that Orca classifies as working, idle, or needs-input and uses for notifications |
| `orca-prefill.ts` | Orca-managed | Prefills the editor from `ORCA_OMP_PREFILL` on session start |

Files marked Orca-managed carry an `// @orca-managed-pi-extension` header. Orca
may overwrite them on update, so maintainers should keep this checkout in sync
with the live copies when preserving local changes.
