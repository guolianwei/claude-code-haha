import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as cwd from './cwd.js'
import { tryFindGitBashPath } from './windowsPaths.js'

const configuredBash = process.env.CLAUDE_CODE_GIT_BASH_PATH
const restores: Array<() => void> = []
const repo = 'C:\\fixture-project'
const installedGit = 'C:\\Program Files\\Git\\cmd\\git.exe'
const installedBash = 'C:\\Program Files\\Git\\bin\\bash.exe'

beforeEach(() => {
  delete process.env.CLAUDE_CODE_GIT_BASH_PATH
  tryFindGitBashPath.cache.clear?.()
})
afterEach(() => {
  for (const restore of restores.splice(0)) restore()
  tryFindGitBashPath.cache.clear?.()
  if (configuredBash === undefined) delete process.env.CLAUDE_CODE_GIT_BASH_PATH
  else process.env.CLAUDE_CODE_GIT_BASH_PATH = configuredBash
})

function probes(existing: string[], lookup = '') {
  // No real Git installation, user configuration or executable is read/run.
  const exists = spyOn(fs, 'existsSync').mockImplementation(value => existing.includes(String(value)))
  const exec = spyOn(childProcess, 'execFileSync').mockReturnValue(lookup)
  const shell = spyOn(childProcess, 'execSync').mockImplementation(() => { throw new Error('Unexpected startup shell') })
  const directory = spyOn(cwd, 'getCwd').mockReturnValue(repo)
  restores.push(() => exists.mockRestore(), () => exec.mockRestore(), () => shell.mockRestore(), () => directory.mockRestore())
  return { exists, exec, shell }
}

describe('startup Git Bash discovery without console windows', () => {
  it('checks an explicit path literally without starting cmd, even with spaces and metacharacters', () => {
    const literal = 'C:\\fixture & tools\\Git (portable)\\bin\\bash.exe'
    process.env.CLAUDE_CODE_GIT_BASH_PATH = literal
    const spy = probes([literal])
    expect(tryFindGitBashPath()).toBe(literal)
    expect(spy.exists).toHaveBeenCalledWith(literal)
    expect(spy.shell).not.toHaveBeenCalled()
    expect(spy.exec).not.toHaveBeenCalled()
  })

  it('retains the explicit missing path result without falling back or spawning', () => {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = 'C:\\fixture-missing\\bash.exe'
    const spy = probes([])
    expect(tryFindGitBashPath()).toBeNull()
    expect(spy.shell).not.toHaveBeenCalled()
    expect(spy.exec).not.toHaveBeenCalled()
  })

  it('resolves the standard installation using filesystem checks only', () => {
    const spy = probes([installedGit, installedBash])
    expect(tryFindGitBashPath()).toBe(installedBash)
    expect(spy.shell).not.toHaveBeenCalled()
    expect(spy.exec).not.toHaveBeenCalled()
    expect(tryFindGitBashPath()).toBe(installedBash)
    expect(spy.exists).toHaveBeenCalledTimes(2)
  })

  it.skipIf(process.platform !== 'win32')('keeps fallback lookup hidden and excludes executables inside the current project', () => {
    const fallback = 'D:\\fixture-safe-git\\bin\\bash.exe'
    const spy = probes([fallback], `${repo}\\git.exe\r\n${repo}\\tools\\git.exe\r\nD:\\fixture-safe-git\\cmd\\git.exe\r\n`)
    expect(tryFindGitBashPath()).toBe(fallback)
    expect(spy.exec).toHaveBeenCalledTimes(1)
    const call = spy.exec.mock.calls[0]
    expect(String(call[0])).toMatch(/(?:^|[\\/])where\.exe$/i)
    expect(call[1]).toEqual(['git'])
    expect(call[2]).toMatchObject({ windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    expect(spy.shell).not.toHaveBeenCalled()
  })

  it('returns null when no safe executable is found', () => {
    const spy = probes([])
    expect(tryFindGitBashPath()).toBeNull()
    expect(spy.shell).not.toHaveBeenCalled()
  })
})
