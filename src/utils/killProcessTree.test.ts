import { afterEach, describe, expect, it } from 'bun:test'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { win32 } from 'node:path'
import { readFileSync } from 'node:fs'
import { killProcessTree } from './killProcessTree.js'

const owned: ChildProcess[] = []
const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch { return false }
}
afterEach(async () => {
  for (const child of owned.splice(0)) {
    if (child.pid && alive(child.pid)) await new Promise<void>(resolve => {
      if (process.platform === 'win32') execFile(win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      else { child.kill(); resolve() }
    })
  }
})

describe('hidden owned process-tree cleanup', () => {
  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid PID %s without invoking taskkill', pid => {
    expect(() => killProcessTree(pid)).toThrow('positive safe integer')
    let received: Error | undefined
    killProcessTree(pid, 'SIGKILL', error => { received = error })
    expect(received).toBeInstanceOf(Error)
  })

  it('routes shell cancellation through the hidden helper, not tree-kill directly', () => {
    const source = readFileSync(new URL('./ShellCommand.ts', import.meta.url), 'utf8')
    expect(source).toContain("killProcessTree(this.#childProcess.pid, 'SIGKILL')")
    expect(source).not.toContain("from 'tree-kill'")
  })

  it.skipIf(process.platform !== 'win32')('kills both a fixture parent and grandchild while retaining /T semantics', async () => {
    const child = spawn(process.execPath, ['-e', `
      const {spawn}=require('node:child_process')
      const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'})
      grandchild.on('spawn',()=>console.log(JSON.stringify({parent:process.pid,grandchild:grandchild.pid})))
      setInterval(()=>{},1000)
    `], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    owned.push(child)
    const pids = await new Promise<{ parent: number; grandchild: number }>((resolve, reject) => {
      let data = ''
      const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 5000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.stdout!.on('data', chunk => {
        data += String(chunk)
        if (data.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(data.trim())) }
      })
    })
    expect(pids.parent).toBe(child.pid!)
    expect(alive(pids.grandchild)).toBe(true)
    await new Promise<void>((resolve, reject) => killProcessTree(child.pid!, 'SIGKILL', error => error ? reject(error) : resolve()))
    for (let attempt = 0; attempt < 100 && (alive(pids.parent) || alive(pids.grandchild)); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(alive(pids.parent)).toBe(false)
    expect(alive(pids.grandchild)).toBe(false)
  }, 15_000)
})
