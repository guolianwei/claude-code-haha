import type { Client } from 'ssh2'

/** PAM password compatibility, not an automatic MFA/password-change responder. */
export function enablePasswordKeyboardInteractive(
  client: Client,
  password: string,
  isCurrent: () => boolean,
  fail: (code: string) => void,
): void {
  let rounds = 0
  let passwordSent = false
  client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
    if (!isCurrent()) return
    rounds += 1
    if (prompts.length === 0 && rounds <= 3) {
      finish([])
      return
    }
    const prompt = prompts[0]
    const isPassword = prompts.length === 1 && prompt?.echo === false &&
      /^\s*(?:password|[^\r\n:]{1,128}['’]s password|密码|密碼)\s*[:：]?\s*$/i.test(prompt.prompt)
    if (!isPassword || passwordSent || rounds > 3) {
      // Do not send the stored password as an OTP, new password, or arbitrary
      // echoed prompt. The failure callback closes this authenticated endpoint.
      fail(passwordSent && isPassword ? 'AUTH_FAILED' : 'SSH_INTERACTIVE_AUTH_REQUIRED')
      return
    }
    passwordSent = true
    finish([password])
  })
}

export function sshAuthenticationErrorCode(error: unknown): string {
  const value = error as { level?: string; code?: string; message?: string } | null
  if (value?.level === 'client-authentication' || value?.message?.includes('All configured authentication methods failed')) return 'AUTH_FAILED'
  if (value?.code === 'ETIMEDOUT' || value?.level === 'client-timeout') return 'CONNECT_TIMEOUT'
  if (value?.code === 'ECONNREFUSED') return 'SSH_CONNECTION_REFUSED'
  if (value?.code === 'ENOTFOUND' || value?.code === 'EAI_AGAIN') return 'SSH_HOST_UNREACHABLE'
  return 'SSH_ERROR'
}
