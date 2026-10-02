import { describe, expect, it, vi } from 'vitest'
import { createElectronHost } from './electronHost'
import { browserHost } from './browserHost'
import { ELECTRON_IPC_CHANNELS } from '../../../electron/ipc/channels'
import { isElectronIpcChannelAllowedForPetWindow, validateElectronIpcPayload } from '../../../electron/ipc/capabilities'

const tagId = '22222222-2222-4222-8222-222222222222'
const channel = ELECTRON_IPC_CHANNELS.mrCopyTagConnections

describe('tag connection clipboard bridge', () => {
  it('sends only a tag identity and receives counts from the native clipboard operation', async () => {
    const result = { ok: true, data: { hostCount: 2, accountCount: 3 } }
    const invoke = vi.fn(async () => result)
    const host = createElectronHost({ invoke: invoke as any, subscribe: async () => () => {} })
    await expect(host.hostManagement.copyTagConnections(tagId)).resolves.toEqual(result)
    expect(invoke).toHaveBeenCalledExactlyOnceWith(channel, { tagId })
  })

  it('rejects malformed identities and renderer supplied export data', () => {
    expect(validateElectronIpcPayload(channel, { tagId })).toBe(true)
    for (const payload of [
      null, {}, { tagId: '' }, { tagId: '../escape' }, { tagId: ['any'] },
      { tagId, hostIds: [] }, { tagId, markdown: 'untrusted' },
      { tagId, password: 'fake-secret' }, { tagId, command: 'arbitrary' },
    ]) expect(validateElectronIpcPayload(channel, payload)).toBe(false)
    expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
  })

  it('does not advertise a successful copy outside the native desktop', async () => {
    await expect(browserHost.hostManagement.copyTagConnections(tagId)).resolves.toEqual({
      ok: false, error: { code: 'UNAVAILABLE', messageKey: 'managedResources.errors.desktopOnly' },
    })
  })
})
