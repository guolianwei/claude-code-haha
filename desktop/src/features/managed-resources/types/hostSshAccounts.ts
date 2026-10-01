import type { Host, HostSshAccount } from './resourceTypes.js'

export const MAX_SSH_ACCOUNTS = 32

/** The host id is the stable default-account id, including pre-upgrade hosts. */
export function getHostSshAccounts(host: Pick<Host, 'id' | 'username' | 'auth' | 'sshAccounts'>): HostSshAccount[] {
  return [{ id: host.id, username: host.username, auth: host.auth }, ...(host.sshAccounts ?? [])]
}

export function findHostSshAccount(host: Host, accountId = host.id): HostSshAccount | undefined {
  return getHostSshAccounts(host).find(account => account.id === accountId)
}

/** Never fall back to another user's credentials for a stale or foreign id. */
export function requireHostSshAccount(host: Host, accountId = host.id): HostSshAccount {
  const account = findHostSshAccount(host, accountId)
  if (!account) throw new Error('SSH_ACCOUNT_NOT_FOUND')
  return account
}
