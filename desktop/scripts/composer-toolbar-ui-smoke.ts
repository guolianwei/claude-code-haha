import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment'
if (process.platform !== 'win32') { console.log('SKIPPED: Windows composer UI fixture'); process.exit(0) }
const desktop = path.resolve(import.meta.dir, '..')
const source = path.join(import.meta.dir, 'fixtures', 'composer-toolbar-ui')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-composer-toolbar-'))
const output = path.resolve(process.argv[2] ?? path.join(desktop, '..', 'artifacts', 'composer-toolbar-fix-20260927', 'ui'))
let result = 1
try {
  await build({ configFile: false, root: source, base: './', plugins: [react(), tailwindcss()], resolve: { alias: { '@': path.join(desktop, 'src') } }, build: { outDir: path.join(sandbox, 'ui'), emptyOutDir: false, target: 'es2021', chunkSizeWarningLimit: 3000 } })
  const bundle = await Bun.build({ entrypoints: [path.join(source, 'main.ts')], target: 'node', format: 'cjs', outdir: sandbox, naming: 'main.cjs', external: ['electron'] })
  if (!bundle.success) throw new Error('Fixture main build failed')
  const env = createSandboxedTestEnvironment(sandbox, { TOOLBAR_UI_SANDBOX: sandbox, TOOLBAR_UI_OUTPUT: output })
  delete env.ELECTRON_RUN_AS_NODE
  const child = Bun.spawn([path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe'), path.join(sandbox, 'main.cjs')], { cwd: desktop, env, windowsHide: true, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => { Bun.spawn(['taskkill.exe', '/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdout: 'ignore', stderr: 'ignore' }) }, 115_000)
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'process.log'), stdout + stderr)
  console.log(stdout); if (code !== 0) console.error(stderr.slice(-4000)); result = code
} finally { await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }) }
process.exit(result)
