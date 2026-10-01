import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import { fireRawRead } from './rawRead.js'
import { MDM_SUBPROCESS_TIMEOUT_MS, WINDOWS_REGISTRY_KEY_PATH_HKCU, WINDOWS_REGISTRY_KEY_PATH_HKLM, WINDOWS_REGISTRY_VALUE_NAME } from './constants.js'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const restores: Array<() => void> = []
afterEach(() => {
  for (const restore of restores.splice(0)) restore()
  Object.defineProperty(process, 'platform', platform)
})

function onPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { ...platform, value })
}

function fakeExec(failHive?: string) {
  const spy = spyOn(childProcess, 'execFile').mockImplementation(((_file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    // Never read a real registry or managed policy in this fixture.
    queueMicrotask(() => callback(args[1] === failHive ? new Error('fixture unavailable') : null, `fixture:${args[1]}`))
    return {} as childProcess.ChildProcess
  }) as typeof childProcess.execFile)
  restores.push(() => spy.mockRestore())
  return spy
}

describe('startup managed-policy reads never open a Windows console', () => {
  it('hides both registry reads while retaining separate machine and user results', async () => {
    onPlatform('win32')
    const spy = fakeExec()
    const promise = fireRawRead()
    // Both reads must begin before yielding; serializing them slows startup.
    expect(spy).toHaveBeenCalledTimes(2)
    for (const [index, hive] of [WINDOWS_REGISTRY_KEY_PATH_HKLM, WINDOWS_REGISTRY_KEY_PATH_HKCU].entries()) {
      expect(spy.mock.calls[index]).toEqual([
        'reg', ['query', hive, '/v', WINDOWS_REGISTRY_VALUE_NAME],
        expect.objectContaining({ windowsHide: true, encoding: 'utf-8', timeout: MDM_SUBPROCESS_TIMEOUT_MS }),
        expect.any(Function),
      ])
    }
    expect(await promise).toEqual({ plistStdouts: null, hklmStdout: `fixture:${WINDOWS_REGISTRY_KEY_PATH_HKLM}`, hkcuStdout: `fixture:${WINDOWS_REGISTRY_KEY_PATH_HKCU}` })
  })

  it.each([WINDOWS_REGISTRY_KEY_PATH_HKLM, WINDOWS_REGISTRY_KEY_PATH_HKCU])('keeps failures isolated to %s without disabling the other policy source', async hive => {
    onPlatform('win32')
    fakeExec(hive)
    const result = await fireRawRead()
    expect(result.hklmStdout).toBe(hive === WINDOWS_REGISTRY_KEY_PATH_HKLM ? null : `fixture:${WINDOWS_REGISTRY_KEY_PATH_HKLM}`)
    expect(result.hkcuStdout).toBe(hive === WINDOWS_REGISTRY_KEY_PATH_HKCU ? null : `fixture:${WINDOWS_REGISTRY_KEY_PATH_HKCU}`)
  })

  it('does not spawn a process on Linux', async () => {
    onPlatform('linux')
    const spy = fakeExec()
    expect(await fireRawRead()).toEqual({ plistStdouts: null, hklmStdout: null, hkcuStdout: null })
    expect(spy).not.toHaveBeenCalled()
  })

  it('retains the missing-plist fast path on macOS', async () => {
    onPlatform('darwin')
    const exists = spyOn(fs, 'existsSync').mockReturnValue(false)
    restores.push(() => exists.mockRestore())
    const spy = fakeExec()
    expect(await fireRawRead()).toEqual({ plistStdouts: [], hklmStdout: null, hkcuStdout: null })
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps fresh periodic reads hidden without disabling policy refresh', async () => {
    onPlatform('win32')
    const spy = fakeExec()
    await fireRawRead()
    await fireRawRead()
    expect(spy).toHaveBeenCalledTimes(4)
    for (const call of spy.mock.calls) expect(call[2]).toMatchObject({ windowsHide: true })
  })
})
