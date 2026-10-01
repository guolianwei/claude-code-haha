import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment'

if (process.platform !== 'win32') { console.log('SKIPPED: Windows startup console probe'); process.exit(0) }
const root = resolve(import.meta.dir, '../..')
const out = resolve(root, process.argv[2] ?? 'artifacts/windows-startup-flash-20260927/native')
const sandbox = mkdtempSync(join(tmpdir(), 'cc-startup-console-'))
const env = createSandboxedTestEnvironment(sandbox)
const windows = env.SYSTEMROOT || 'C:\\Windows'
const compiler = ['Framework64', 'Framework'].map(arch => join(windows, 'Microsoft.NET', arch, 'v4.0.30319', 'csc.exe')).find(existsSync)
assert(compiler, 'Native probe requires the Windows .NET Framework compiler')
const probe = join(sandbox, 'startup-console-probe.exe')
const worker = join(import.meta.dir, 'fixtures/windows-background-process/startupWorker.ts')
mkdirSync(out, { recursive: true })
try {
  const compiled = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${probe}`, join(import.meta.dir, 'fixtures/windows-background-process/StartupConsoleProbe.cs')], { windowsHide: true, env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr)
  const direct = spawnSync(probe, [], { windowsHide: true, env, encoding: 'utf8', timeout: 10_000 })
  assert.equal(direct.status, 0, `Native probe startup: ${direct.error ?? ''} ${direct.stderr ?? ''} ${direct.stdout ?? ''}`)
  const actual = join(root, 'src/utils/settings/mdm/rawRead.ts')
  const old = join(root, 'artifacts/windows-startup-flash-20260927/before/src/utils/settings/mdm/rawRead.ts')
  const reports: Record<string, any> = {}
  for (const [name, modulePath] of [['before', old], ['after', actual]]) {
    if (!existsSync(modulePath)) continue
    const base = join(sandbox, name); mkdirSync(base)
    const entry = join(base, 'rawRead.ts')
    const source = readFileSync(modulePath, 'utf8')
    const importLine = "import { execFile } from 'child_process'"
    assert.equal(source.split(importLine).length, 2)
    writeFileSync(entry, source.replace(importLine, "import { execFile } from './fixture-exec.ts'"))
    copyFileSync(join(root, 'src/utils/settings/mdm/constants.ts'), join(base, 'constants.ts'))
    writeFileSync(join(base, 'fixture-exec.ts'), `
      import assert from 'node:assert/strict'
      import { execFile as nativeExecFile } from 'node:child_process'
      export function execFile(file, args, options, callback) {
        assert.equal(file, 'reg')
        assert(process.env.CC_STARTUP_REG_PROBE)
        return nativeExecFile(process.env.CC_STARTUP_REG_PROBE, args, options, (error, stdout, stderr) => {
          if (error) console.error('native fixture execution:', error.code, stderr)
          callback(error, stdout)
        })
      }
    `)
    const result = join(sandbox, name + '.json')
    const child = spawnSync(process.execPath, ['--no-env-file', worker, entry, probe, result], { windowsHide: true, cwd: root, env, encoding: 'utf8', timeout: 15_000 })
    assert.equal(child.status, 0, child.stderr || child.stdout)
    reports[name] = JSON.parse(readFileSync(result, 'utf8'))
  }
  assert(reports.after)
  const values = [reports.after.startup.machine, reports.after.startup.user, reports.after.refresh.machine, reports.after.refresh.user]
  for (const value of values) {
    assert.equal(value.visible, false)
    assert.equal(value.useShowWindow, true, 'Native STARTUPINFO must request a show-state override')
    assert.equal(value.showWindow, 0, 'Native STARTUPINFO must request SW_HIDE, even on a headless runner')
  }
  const beforeValues = reports.before ? [reports.before.startup.machine, reports.before.startup.user] : []
  const changedNativeFlag = beforeValues.some(value => values.some(after => value.useShowWindow !== after.useShowWindow || value.showWindow !== after.showWindow || value.hasConsole !== after.hasConsole))
  const report = { functionalStatus: 'passed', nativeFlagDifferenceObserved: changedNativeFlag,
    visualStatus: beforeValues.some(value => value.visible) ? 'before-visible-after-hidden' : 'not-reproduced-on-runner',
    realRegistryAccess: false, reports }
  writeFileSync(join(out, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { rmSync(sandbox, { recursive: true, force: true, maxRetries: 5 }) }
