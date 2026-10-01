import { describe, expect, it } from 'vitest'
import { validateElectronIpcPayload } from './capabilities'
import { ELECTRON_IPC_CHANNELS } from './channels'
import { CreateConnectionInputSchema } from '../../src/features/managed-resources/api/hostManagementApi'

const input = { hostId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', accountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expectedRevision: 2, cols: 80, rows: 24 }
describe('SSH account preload and main-process contract', () => {
  it('accepts an account id without accepting arbitrary credentials or malformed ids', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.mrCreateConnection, input)).toBe(true)
    expect(CreateConnectionInputSchema.safeParse(input).success).toBe(true)
    for (const extra of [{ accountId: '' }, { accountId: null }, { accountId: 'not-a-uuid' }, { password: 'SHOULD_NOT_CROSS_THIS_CHANNEL' }]) {
      expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.mrCreateConnection, { ...input, ...extra })).toBe(false)
      expect(CreateConnectionInputSchema.safeParse({ ...input, ...extra }).success).toBe(false)
    }
    const { accountId: _accountId, ...oldInput } = input
    expect(CreateConnectionInputSchema.safeParse(oldInput).success).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.mrCreateConnection, oldInput)).toBe(true)
  })
})
