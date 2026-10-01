import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import treeKill from 'tree-kill'

type KillCallback = (error?: Error) => void

/** Terminate the owned command tree without opening cmd.exe on Windows. */
export function killProcessTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGKILL',
  callback?: KillCallback,
): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    const error = new Error('pid must be a positive safe integer')
    if (callback) callback(error)
    else throw error
    return
  }
  if (process.platform !== 'win32') {
    treeKill(pid, signal, callback)
    return
  }

  // tree-kill's Windows branch uses exec('taskkill ...') without windowsHide,
  // creating a visible cmd/taskkill console on every timeout/cancellation.
  // Keep /T /F semantics, but invoke the system binary directly with literal argv.
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
  execFile(win32.join(systemRoot, 'System32', 'taskkill.exe'), [
    '/PID', String(pid), '/T', '/F',
  ], { windowsHide: true, timeout: 10_000 }, error => {
    callback?.(error ?? undefined)
  })
}
