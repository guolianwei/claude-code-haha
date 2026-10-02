import { createHash } from 'node:crypto'
import type { HostManagementResult } from '../../../src/features/managed-resources/api/hostManagementApi.js'
import { getHostSshAccounts } from '../../../src/features/managed-resources/types/hostSshAccounts.js'
import type { CredentialRecord, Host, ResourceDocument } from '../../../src/features/managed-resources/types/resourceTypes.js'
import type { ResourceDocumentStore } from './repositories/resourceDocumentStore.js'
import type { CredentialVault } from './vault/credentialVault.js'
import type { CredentialRevealAuthorizer } from './windowsCredentialReauth.js'

export type TagConnectionsClipboard = { writeText(text: string): void }
export type TagConnectionsCopyResult = { hostCount: number; accountCount: number }

type CopyOptions = {
  store: Pick<ResourceDocumentStore, 'load'>
  vault: Pick<CredentialVault, 'decrypt'>
  credentialRevealAuthorizer?: CredentialRevealAuthorizer
  clipboard?: TagConnectionsClipboard
}

type AccountRow = {
  host: Host
  username: string
  authType: 'password' | 'privateKey'
  credential: CredentialRecord | null
  tagNames: string[]
}

function failure(code: string, messageKey = 'managedResources.tagCopy.failed'): HostManagementResult<never> {
  return { ok: false, error: { code, messageKey } }
}

type CopyScope = { rows: AccountRow[]; hostCount: number; fingerprint: string }

function collectScope(document: ResourceDocument, tagId: string): CopyScope | { error: HostManagementResult<never> } {
  const tag = document.tags.find(value => value.id === tagId && value.namespace === 'host')
  if (!tag) return { error: failure('RESOURCE_NOT_FOUND') } as const
  const hosts = document.hosts.filter(host => host.tagIds.includes(tagId))
  if (hosts.length === 0) return { error: failure('TAG_CONNECTIONS_EMPTY', 'managedResources.tagCopy.empty') } as const

  const credentials = new Map(document.credentials.map(value => [value.id, value]))
  const referencedCredentials = new Map<string, CredentialRecord>()
  const referencedTagIds = new Set(hosts.flatMap(host => host.tagIds))
  const tags = document.tags.filter(value => value.namespace === 'host' && referencedTagIds.has(value.id))
  const tagNames = new Map(tags.map(value => [value.id, value.name]))
  const rows: AccountRow[] = []
  for (const host of hosts) {
    for (const account of getHostSshAccounts(host)) {
      const credential = account.auth.credentialId ? credentials.get(account.auth.credentialId) : null
      if (account.auth.credentialId && !credential) return { error: failure('CREDENTIAL_NOT_FOUND') } as const
      if (credential) {
        const expectedKind = account.auth.type === 'password' ? 'ssh-password' : 'ssh-private-key'
        if (credential.kind !== expectedKind) return { error: failure('CREDENTIAL_KIND_MISMATCH') } as const
        referencedCredentials.set(credential.id, credential)
      }
      rows.push({
        host,
        username: account.username,
        authType: account.auth.type,
        credential: credential ?? null,
        tagNames: host.tagIds.flatMap(id => tagNames.has(id) ? [tagNames.get(id)!] : []),
      })
    }
  }

  // Fingerprint only this tag's scope. A revision change elsewhere in the
  // resource library does not invalidate the unchanged export scope.
  const fingerprint = createHash('sha256').update(JSON.stringify({
    tag, hosts, tags, credentials: [...referencedCredentials.values()],
  })).digest('hex')
  return { rows, hostCount: hosts.length, fingerprint } as const
}

/** Escape cell content so names and passwords cannot create extra rows or HTML. */
function markdownCell(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_~[\]|]/g, '\\$&')
    .replace(/\r\n|\r|\n/g, '<br>')
}

function passwordCell(password: string): string {
  // GFM trims cell edges and renders control whitespace ambiguously. Give
  // these passwords explicit string boundaries and reversible JSON escapes.
  return password.trim() !== password || /[\t\r\n\v\f]/.test(password)
    ? `JSON 字符串：${JSON.stringify(password)}`
    : password
}

function sshConnection(host: Host, username: string): string {
  const address = host.address.includes(':') && !host.address.startsWith('[') ? `[${host.address}]` : host.address
  return `ssh://${encodeURIComponent(username)}@${address}:${host.port}`
}

/** Secrets stay in the main process and go only to a user-requested clipboard write. */
export function createCopyTagHostConnections(options: CopyOptions) {
  const clipboard = options.clipboard ?? {
    writeText(text: string) { require('electron').clipboard.writeText(text) },
  }

  return async function copyTagConnections(
    tagId: string,
    isCurrentCaller: () => boolean = () => true,
  ): Promise<HostManagementResult<TagConnectionsCopyResult>> {
    try {
      const loaded = await options.store.load()
      if (loaded.status !== 'ready') return failure('RESOURCE_DOCUMENT_UNAVAILABLE')
      let scope = collectScope(loaded.document, tagId)
      if ('error' in scope) return scope.error
      if (scope.rows.some(row => row.authType === 'password' && row.credential)) {
        let authorization
        try { authorization = await options.credentialRevealAuthorizer?.authorize() }
        catch { return failure('OS_AUTH_UNAVAILABLE', 'managedResources.errors.OS_AUTH_UNAVAILABLE') }
        if (authorization?.status !== 'authorized') {
          const code = authorization?.status === 'cancelled' ? 'OS_AUTH_CANCELLED'
            : authorization?.status === 'denied' ? 'OS_AUTH_FAILED' : 'OS_AUTH_UNAVAILABLE'
          return failure(code, `managedResources.errors.${code}`)
        }
        const current = await options.store.load()
        if (current.status !== 'ready') return failure('TAG_CONNECTIONS_CHANGED', 'managedResources.tagCopy.changed')
        const currentScope = collectScope(current.document, tagId)
        if ('error' in currentScope || currentScope.fingerprint !== scope.fingerprint) {
          return failure('TAG_CONNECTIONS_CHANGED', 'managedResources.tagCopy.changed')
        }
        scope = currentScope
      }
      if (!isCurrentCaller()) return failure('UNAUTHORIZED_OWNER')

      const rows: string[] = []
      const passwords = new Map<string, string>()
      for (const row of scope.rows) {
        let password = row.authType === 'privateKey' ? '私钥认证' : '未保存'
        if (row.authType === 'password' && row.credential) {
          if (!passwords.has(row.credential.id)) {
            const decrypted = options.vault.decrypt(row.credential)
            if (decrypted.status !== 'decrypted') return failure(decrypted.code)
            if (decrypted.payload.kind !== 'ssh-password' || !('password' in decrypted.payload)) {
              return failure('CREDENTIAL_KIND_MISMATCH')
            }
            passwords.set(row.credential.id, decrypted.payload.password)
          }
          password = passwordCell(passwords.get(row.credential.id)!)
        }
        rows.push(`| ${[
          row.tagNames.join('、'), row.host.name, row.host.address, row.username,
          String(row.host.port), password, sshConnection(row.host, row.username),
        ].map(markdownCell).join(' | ')} |`)
      }
      clipboard.writeText([
        '| 标签 | 服务器 | IP或地址 | 用户 | 端口 | 密码 | SSH连接 |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
      ].join('\n'))
      return { ok: true, data: { hostCount: scope.hostCount, accountCount: scope.rows.length } }
    } catch {
      // Never forward clipboard/vault exception messages, which may contain the
      // input table or secret material from an adapter.
      return failure('TAG_CONNECTIONS_COPY_FAILED')
    }
  }
}
