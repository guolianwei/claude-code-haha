import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { copyFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SearchService } from '../../../../src/server/services/searchService'
import { WorkspaceService } from '../../../../src/server/services/workspaceService'
import { ReviewService } from '../../../../src/server/services/reviewService'
import { execFileNoThrowWithCwd } from '../../../../src/utils/execFileNoThrow'

const [probe, resultPath] = process.argv.slice(2)
assert(probe && resultPath, 'fixture arguments required')
const evidence: Array<{ operation: string; hasConsole: boolean; visible: boolean }> = []
function record(operation: string, output: string) {
  const state = JSON.parse(output.trim()) as { hasConsole: boolean; visible: boolean }
  evidence.push({ operation, ...state })
  return state
}

try {
  // This worker itself is spawned with windowsHide from the parent, reproducing
  // an Electron-launched console-less sidecar. Bun can suppress consoles even
  // without the flag, so an explicit AllocConsole control calibrates the Win32
  // visibility probe; it does not claim to reproduce the reported UI flash.
  const before = record('explicit-visible-control', await new Promise<string>((resolve, reject) => {
    execFile(probe, ['--allocate-console'], { encoding: 'utf8', windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))
  }))

  const search = new SearchService() as unknown as {
    runCommand: (command: string, args: string[]) => Promise<string>
    runCommandRecords: (command: string, args: string[], signal: undefined, onRecord: (line: string) => void) => Promise<void>
  }
  record('search-buffered', await search.runCommand(probe, []))
  const lines: string[] = []
  await search.runCommandRecords(probe, [], undefined, line => lines.push(line))
  record('search-streamed', lines.join('\n'))
  await assert.rejects(() => search.runCommand(probe, ['--fail']), /code 7.*fixture-stderr/s)

  // A fixture git.exe instruments the actual service spawn path; no repository
  // or user configuration is changed and no real Git operation is executed.
  copyFileSync(probe, join(dirname(probe), 'git.exe'))
  for (const key of Object.keys(process.env)) if (key.toLowerCase() === 'path') delete process.env[key]
  process.env.PATH = `${dirname(probe)};${process.env.CC_HAHA_FIXTURE_ORIGINAL_PATH ?? ''}`
  type GitService = { runGit: (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }> }
  const workspace = new WorkspaceService(async () => dirname(probe)) as unknown as GitService
  const review = new ReviewService(async () => dirname(probe)) as unknown as GitService
  const workspaceResult = await workspace.runGit(dirname(probe), ['status'])
  const reviewResult = await review.runGit(dirname(probe), ['diff'])
  assert.equal(workspaceResult.code, 0)
  assert.equal(reviewResult.code, 0)
  record('workspace-git', workspaceResult.stdout)
  record('review-git', reviewResult.stdout)
  assert.match(reviewResult.stderr, /fixture-stderr/)

  const execaResult = await execFileNoThrowWithCwd(probe, [], { cwd: dirname(probe) })
  assert.equal(execaResult.code, 0)
  record('existing-execa-wrapper', execaResult.stdout)
  const failure = await execFileNoThrowWithCwd(probe, ['--fail'], { cwd: dirname(probe) })
  assert.equal(failure.code, 7)
  assert.match(failure.stderr, /fixture-stderr/)

  const native = Bun.spawn([probe], { windowsHide: true, stdout: 'pipe', stderr: 'pipe' })
  record('bun-spawn', await new Response(native.stdout).text())
  await new Response(native.stderr).text()
  assert.equal(await native.exited, 0)
  record('node-spawn-sync', spawnSync(probe, [], { windowsHide: true, encoding: 'utf8' }).stdout)

  for (const item of evidence.slice(1)) assert.equal(item.visible, false, `${item.operation} created a visible console`)
  writeFileSync(resultPath, JSON.stringify({
    status: before.visible ? 'passed' : 'inconclusive',
    functionalChecks: 'passed',
    visibilityControl: before.visible ? 'calibrated' : 'runner-could-not-create-visible-console',
    evidence,
  }, null, 2))
  process.exit(before.visible ? 0 : 2)
} catch (error) {
  writeFileSync(resultPath, JSON.stringify({ status: 'failed', evidence, error: String(error) }, null, 2))
  process.exit(1)
}
