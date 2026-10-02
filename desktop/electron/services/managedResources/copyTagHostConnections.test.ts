import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { marked } from 'marked'
import type { CredentialRecord, Host, ResourceDocument, ResourceTag } from '../../../src/features/managed-resources/types/resourceTypes.js'
import type { ResourceDocumentLoadResult } from './repositories/resourceDocumentRepository.js'
import type { CredentialRevealAuthorization } from './windowsCredentialReauth.js'
import { createCredentialVault } from './vault/credentialVault.js'
import { createCopyTagHostConnections } from './copyTagHostConnections.js'

const SECRET = 'fixture-password-only'
const meta = () => ({ id: randomUUID(), revision: 1, createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' })
const tag = (name: string): ResourceTag => ({ ...meta(), namespace: 'host', name, normalizedName: name.toLowerCase(), colorToken: null })
const host = (tagIds: string[], overrides: Partial<Host> = {}): Host => ({
  ...meta(), name: 'server', address: '10.0.0.20', port: 2222, username: 'root',
  auth: { type: 'password', credentialId: null }, sshAccounts: [], tagIds,
  initialDirectory: null, applications: [], notes: '', ...overrides,
})

function fixture() {
  const selected = tag('生产')
  const shared = tag('共享')
  const outside = tag('测试')
  const document: ResourceDocument = {
    schemaVersion: 2, revision: 1, hosts: [host([selected.id, shared.id]), host([outside.id], { name: 'excluded' })],
    tags: [selected, shared, outside], credentials: [], concepts: [], dataConnections: [], knownHostKeys: [],
  }
  const vault = createCredentialVault({ safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(text, 'utf8'),
    decryptString: value => value.toString('utf8'),
  } })
  function addPassword(password = SECRET) {
    const credential: CredentialRecord = { ...meta(), kind: 'ssh-password', label: 'fixture', backend: 'electron-safe-storage-v1', ciphertextBase64: '' }
    const encrypted = vault.encrypt(credential, { kind: 'ssh-password', password })
    if (encrypted.status !== 'encrypted') throw new Error('Fixture encryption failed')
    credential.ciphertextBase64 = encrypted.ciphertextBase64
    document.credentials.push(credential)
    return credential
  }
  const ready = (): ResourceDocumentLoadResult => ({ status: 'ready', source: 'disk', readOnly: false, filePath: 'fixture-only.json', document: structuredClone(document) })
  const load = vi.fn(async () => ready())
  const authorize = vi.fn(async (): Promise<CredentialRevealAuthorization> => ({ status: 'authorized' }))
  const decrypt = vi.spyOn(vault, 'decrypt')
  const writeText = vi.fn((_text: string) => {})
  const copy = createCopyTagHostConnections({ store: { load }, vault, credentialRevealAuthorizer: { authorize }, clipboard: { writeText } })
  return { document, selected, shared, outside, load, ready, authorize, decrypt, writeText, copy, addPassword }
}

describe('copyTagHostConnections', () => {
  it('copies all hosts in a tag and all SSH accounts in one table without returning secrets', async () => {
    const f = fixture()
    const credential = f.addPassword()
    const first = f.document.hosts[0]!
    first.auth.credentialId = credential.id
    first.sshAccounts = [{ id: randomUUID(), username: 'operator', auth: { type: 'password', credentialId: credential.id } }]
    f.document.hosts.push(host([f.selected.id], { name: 'another', address: '10.0.0.21', auth: { type: 'privateKey', credentialId: null } }))
    const result = await f.copy(f.selected.id)
    expect(result).toEqual({ ok: true, data: { hostCount: 2, accountCount: 3 } })
    expect(f.authorize).toHaveBeenCalledTimes(1)
    expect(f.decrypt).toHaveBeenCalledTimes(1)
    expect(f.writeText).toHaveBeenCalledTimes(1)
    const markdown = f.writeText.mock.calls[0]![0]
    expect(markdown.split('\n')).toHaveLength(5)
    expect(markdown).toContain('| 生产、共享 | server | 10.0.0.20 | root | 2222 | fixture-password-only | ssh://root@10.0.0.20:2222 |')
    expect(markdown).toContain('| operator | 2222 | fixture-password-only | ssh://operator@10.0.0.20:2222 |')
    expect(markdown).toContain('私钥认证')
    expect(markdown).not.toContain('excluded')
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain('ssh://')
  })

  it('marks unsaved credentials and private-key authentication without decrypting or authorizing', async () => {
    const f = fixture()
    f.document.hosts[0]!.sshAccounts = [{ id: randomUUID(), username: 'key-user', auth: { type: 'privateKey', credentialId: null } }]
    expect(await f.copy(f.selected.id)).toEqual({ ok: true, data: { hostCount: 1, accountCount: 2 } })
    expect(f.writeText.mock.calls[0]![0]).toContain('未保存')
    expect(f.writeText.mock.calls[0]![0]).toContain('私钥认证')
    expect(f.authorize).not.toHaveBeenCalled()
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  it('never reads private-key material even when the stored key has a passphrase', async () => {
    const f = fixture()
    const key: CredentialRecord = { ...meta(), kind: 'ssh-private-key', label: 'key', backend: 'electron-safe-storage-v1', ciphertextBase64: 'fixture-key-and-passphrase' }
    f.document.credentials.push(key)
    f.document.hosts[0]!.auth = { type: 'privateKey', credentialId: key.id }
    expect((await f.copy(f.selected.id)).ok).toBe(true)
    expect(f.decrypt).not.toHaveBeenCalled()
    expect(f.writeText.mock.calls[0]![0]).not.toContain(key.ciphertextBase64)
  })

  it.each([
    ['cancelled', 'OS_AUTH_CANCELLED'], ['denied', 'OS_AUTH_FAILED'], ['unavailable', 'OS_AUTH_UNAVAILABLE'],
  ] as const)('preserves the clipboard and does not decrypt when OS authorization is %s', async (status, code) => {
    const f = fixture()
    f.document.hosts[0]!.auth.credentialId = f.addPassword().id
    f.authorize.mockResolvedValue({ status })
    expect(await f.copy(f.selected.id)).toMatchObject({ ok: false, error: { code } })
    expect(f.decrypt).not.toHaveBeenCalled()
    expect(f.writeText).not.toHaveBeenCalled()
  })

  it.each(['membership', 'host', 'credential', 'tag'] as const)('rejects %s changes made while the OS prompt is open', async change => {
    const f = fixture()
    f.document.hosts[0]!.auth.credentialId = f.addPassword().id
    f.authorize.mockImplementation(async () => {
      if (change === 'membership') f.document.hosts.push(host([f.selected.id]))
      if (change === 'host') f.document.hosts[0]!.username = 'changed'
      if (change === 'credential') f.document.credentials[0]!.ciphertextBase64 = 'changed'
      if (change === 'tag') f.shared.name = 'changed'
      return { status: 'authorized' }
    })
    expect(await f.copy(f.selected.id)).toMatchObject({ ok: false, error: { code: 'TAG_CONNECTIONS_CHANGED' } })
    expect(f.decrypt).not.toHaveBeenCalled()
    expect(f.writeText).not.toHaveBeenCalled()
  })

  it('allows unrelated resource changes during authorization without expanding the selected scope', async () => {
    const f = fixture()
    f.document.hosts[0]!.auth.credentialId = f.addPassword().id
    f.authorize.mockImplementation(async () => {
      f.document.revision += 1
      f.document.hosts[1]!.name = 'changed-outside'
      return { status: 'authorized' }
    })
    expect((await f.copy(f.selected.id)).ok).toBe(true)
    expect(f.writeText.mock.calls[0]![0]).not.toContain('changed-outside')
  })

  it.each(['missing', 'wrong-kind', 'corrupt'] as const)('preserves the clipboard for a %s credential anywhere in the batch', async problem => {
    const f = fixture()
    const good = f.addPassword()
    const bad = f.addPassword('second-fixture-secret')
    f.document.hosts[0]!.auth.credentialId = good.id
    f.document.hosts[0]!.sshAccounts = [{ id: randomUUID(), username: 'second', auth: { type: 'password', credentialId: bad.id } }]
    if (problem === 'missing') f.document.credentials = f.document.credentials.filter(value => value.id !== bad.id)
    if (problem === 'wrong-kind') bad.kind = 'application-password'
    if (problem === 'corrupt') bad.ciphertextBase64 = Buffer.from('corrupt').toString('base64')
    expect((await f.copy(f.selected.id)).ok).toBe(false)
    expect(f.writeText).not.toHaveBeenCalled()
  })

  it('escapes Markdown cells and emits an encoded IPv6 SSH URL rather than shell instructions', async () => {
    const f = fixture()
    f.document.hosts[0]!.name = 'one|two\n<img src=x>'
    f.document.hosts[0]!.address = '2001:db8::1'
    f.document.hosts[0]!.username = 'a b;$(x)'
    f.document.hosts[0]!.auth.credentialId = f.addPassword('a|b<&_`\\ab~~cd~~ef').id
    expect((await f.copy(f.selected.id)).ok).toBe(true)
    const markdown = f.writeText.mock.calls[0]![0]
    expect(markdown.split('\n')).toHaveLength(3)
    expect(markdown).toContain('one\\|two<br>&lt;img src=x&gt;')
    expect(markdown).toContain('a\\|b&lt;&amp;\\_\\`\\\\')
    expect(markdown).toContain('ab\\~\\~cd\\~\\~ef')
    expect(markdown).toContain('ssh://a%20b%3B%24(x)@\\[2001:db8::1\\]:2222')
    expect(markdown).not.toContain('<img')
  })

  it.each([
    ['leading space', ' leading'],
    ['trailing space', 'trailing '],
    ['only spaces', '   '],
    ['tab', 'one\ttwo'],
    ['line breaks', 'one\r\ntwo\nthree\rfour'],
    ['other control whitespace', 'one\vtwo\fthree'],
    ['combined Markdown and JSON characters', ' a|b\n"<&_`\\ab~~cd~~ef '],
  ])('round-trips a password containing %s through rendered Markdown and JSON', async (_description, password) => {
    const f = fixture()
    f.document.hosts[0]!.auth.credentialId = f.addPassword(password).id
    expect((await f.copy(f.selected.id)).ok).toBe(true)
    const markdown = f.writeText.mock.calls[0]![0]
    expect(markdown.split('\n')).toHaveLength(3)
    const table = document.createElement('div')
    table.innerHTML = marked.parse(markdown, { async: false })
    const cells = table.querySelectorAll('tbody tr td')
    expect(cells).toHaveLength(7)
    const renderedPassword = cells[5]!.textContent!
    expect(renderedPassword).toBe(`JSON 字符串：${JSON.stringify(password)}`)
    expect(JSON.parse(renderedPassword.slice('JSON 字符串：'.length))).toBe(password)
  })

  it('keeps a normal password directly readable after Markdown rendering', async () => {
    const f = fixture()
    const password = 'a|b"<&_`\\ab~~cd~~ef'
    f.document.hosts[0]!.auth.credentialId = f.addPassword(password).id
    expect((await f.copy(f.selected.id)).ok).toBe(true)
    const table = document.createElement('div')
    table.innerHTML = marked.parse(f.writeText.mock.calls[0]![0], { async: false })
    expect(table.querySelectorAll('tbody tr td')[5]!.textContent).toBe(password)
  })

  it('rejects absent, non-host, and empty tags without changing the clipboard', async () => {
    const f = fixture()
    expect((await f.copy(randomUUID())).ok).toBe(false)
    f.selected.namespace = 'concept'
    expect((await f.copy(f.selected.id)).ok).toBe(false)
    f.selected.namespace = 'host'
    f.document.hosts = []
    expect(await f.copy(f.selected.id)).toMatchObject({ ok: false, error: { code: 'TAG_CONNECTIONS_EMPTY' } })
    expect(f.writeText).not.toHaveBeenCalled()
  })

  it('checks caller ownership again after authorization before any decryption', async () => {
    const f = fixture()
    f.document.hosts[0]!.auth.credentialId = f.addPassword().id
    expect(await f.copy(f.selected.id, () => false)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED_OWNER' } })
    expect(f.decrypt).not.toHaveBeenCalled()
    expect(f.writeText).not.toHaveBeenCalled()
  })

  it('does not expose adapter exception text in the result', async () => {
    const f = fixture()
    f.document.hosts[0]!.auth.credentialId = f.addPassword().id
    f.writeText.mockImplementation(() => { throw new Error(SECRET) })
    const result = await f.copy(f.selected.id)
    expect(result).toMatchObject({ ok: false, error: { code: 'TAG_CONNECTIONS_COPY_FAILED' } })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})
