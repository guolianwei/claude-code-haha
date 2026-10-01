import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { enablePasswordKeyboardInteractive, sshAuthenticationErrorCode } from './sshPasswordAuthentication'

function fixture() {
  const emitter = new EventEmitter()
  const fail = vi.fn()
  const current = vi.fn(() => true)
  const finish = vi.fn()
  enablePasswordKeyboardInteractive(emitter as Client, 'PASSWORD_FIXTURE_ONLY', current, fail)
  const prompt = (prompts: { prompt: string; echo: boolean }[]) => emitter.emit('keyboard-interactive', '', '', '', prompts, finish)
  return { prompt, fail, current, finish }
}

describe('SSH keyboard-interactive password boundary', () => {
  it.each(['Password:', ' password: ', 'operator@localhost\'s password: ', '密码：', '密碼:'])('answers a non-echo password prompt: %s', prompt => {
    const f = fixture()
    f.prompt([{ prompt, echo: false }])
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(['PASSWORD_FIXTURE_ONLY'])
    expect(f.fail).not.toHaveBeenCalled()
  })
  it.each([
    [{ prompt: 'OTP:', echo: false }], [{ prompt: 'Verification code:', echo: false }],
    [{ prompt: 'New password:', echo: false }], [{ prompt: 'Password:', echo: true }],
    [{ prompt: 'Password:', echo: false }, { prompt: 'OTP:', echo: false }],
  ])('never sends a password to other interactive challenges', (...prompts) => {
    const f = fixture()
    f.prompt(prompts)
    expect(f.finish).not.toHaveBeenCalled()
    expect(f.fail).toHaveBeenCalledWith('SSH_INTERACTIVE_AUTH_REQUIRED')
  })
  it('bounds empty and repeated password rounds', () => {
    const f = fixture()
    f.prompt([])
    f.prompt([{ prompt: 'Password:', echo: false }])
    f.prompt([{ prompt: 'Password:', echo: false }])
    expect(f.finish.mock.calls).toEqual([[[]], [['PASSWORD_FIXTURE_ONLY']]])
    expect(f.fail).toHaveBeenCalledWith('AUTH_FAILED')
    const empty = fixture()
    for (let i = 0; i < 4; i++) empty.prompt([])
    expect(empty.finish).toHaveBeenCalledTimes(3)
    expect(empty.fail).toHaveBeenCalledWith('SSH_INTERACTIVE_AUTH_REQUIRED')
  })
  it('ignores stale sessions and emits only safe error codes', () => {
    const f = fixture()
    f.current.mockReturnValue(false)
    f.prompt([{ prompt: 'Password:', echo: false }])
    expect(f.finish).not.toHaveBeenCalled()
    expect(sshAuthenticationErrorCode(new Error('All configured authentication methods failed'))).toBe('AUTH_FAILED')
    expect(sshAuthenticationErrorCode({ code: 'ECONNREFUSED' })).toBe('SSH_CONNECTION_REFUSED')
    expect(sshAuthenticationErrorCode({ code: 'ETIMEDOUT' })).toBe('CONNECT_TIMEOUT')
    expect(sshAuthenticationErrorCode({ code: 'ENOTFOUND' })).toBe('SSH_HOST_UNREACHABLE')
    expect(sshAuthenticationErrorCode(new Error('PASSWORD_FIXTURE_ONLY'))).toBe('SSH_ERROR')
  })
})
