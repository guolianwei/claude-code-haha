import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment'

if (process.platform !== 'win32') {
  console.log('[windows-background-process-smoke] skipped: Windows only')
  process.exit(0)
}
const root = resolve(import.meta.dir, '../..')
const output = resolve(root, process.argv[2] ?? 'artifacts/windows-console-fix-20260927/native-smoke')
mkdirSync(output, { recursive: true })
const sandbox = mkdtempSync(join(tmpdir(), 'cc-haha-no-console-'))
const env = createSandboxedTestEnvironment(sandbox)
env.CC_HAHA_FIXTURE_ORIGINAL_PATH = env.PATH ?? ''
const windows = env.SYSTEMROOT || 'C:\\Windows'
const compiler = ['Framework64', 'Framework']
  .map(architecture => join(windows, 'Microsoft.NET', architecture, 'v4.0.30319', 'csc.exe'))
  .find(existsSync)
assert(compiler, 'Windows .NET Framework C# compiler is required for the native visibility probe')
const probe = join(sandbox, 'console-probe.exe')
const worker = resolve(import.meta.dir, 'fixtures/windows-background-process/worker.ts')
try {
  const compiled = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${probe}`, resolve(import.meta.dir, 'fixtures/windows-background-process/ConsoleProbe.cs')], { windowsHide: true, encoding: 'utf8', env, timeout: 30_000 })
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
  const resultPath = join(sandbox, 'result.json')
  const result = spawnSync(process.execPath, ['--no-env-file', worker, probe, resultPath], {
    cwd: root, windowsHide: true, encoding: 'utf8', env, timeout: 60_000,
  })
  writeFileSync(join(output, 'worker.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert(existsSync(resultPath), `Worker did not write evidence: ${result.error ?? result.stderr}`)
  const report = JSON.parse(readFileSync(resultPath, 'utf8'))
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2))
  if (result.status === 2 && report.status === 'inconclusive') {
    process.exitCode = 2
  } else {
    assert.equal(result.status, 0, JSON.stringify(report))
    assert.equal(report.status, 'passed')
  }
  console.log(JSON.stringify(report, null, 2))
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
}
