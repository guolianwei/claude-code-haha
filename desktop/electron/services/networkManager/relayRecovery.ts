import path from 'node:path'
import { z } from 'zod'
import type { NetworkRunner } from './powershell'

const code = z.string().regex(/^[A-Z][A-Z0-9_]+$/)
const hash = z.string().regex(/^[A-Fa-f0-9]{64}$/)
const port = z.number().int().min(1).max(65535)
const executable = z.string().max(2048).refine(value => value === '' || (
  /^[a-z]:[\\/]/i.test(value) && !/[\u0000-\u001f"<>|*?]/.test(value)
  && !value.slice(2).includes(':') && /\.exe$/i.test(value)
  && !value.split(/[\\/]/).some(segment => segment === '.' || segment === '..' || /[. ]$/.test(segment))
))
const profileSchema = z.object({
  relayExecutable: executable,
  relayLocalPort: port,
  gatewayAddress: z.ipv4(),
  relayPort: port,
  relayTaskName: z.string().min(1).max(180).regex(/^[^\\/\u0000-\u001f*?]+$/),
  tunnelName: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
})
const presence = z.enum(['present', 'missing', 'unknown'])
const inspectionSchema = z.object({
  checkedAt: z.string().min(1).max(100),
  binary: z.object({ status: presence, path: executable, sha256: hash.nullable(), secureAcl: z.boolean().nullable(), error: code.optional() }),
  task: z.object({ status: presence, fingerprint: hash.nullable(), definitionMatches: z.boolean().nullable(), state: z.string().max(40).nullable(), enabled: z.boolean().nullable(), error: code.optional() }),
  udp: z.object({ status: z.enum(['ready', 'missing', 'conflict', 'unknown']), pid: z.number().int().positive().optional(), executablePath: executable.optional(), processPriority: z.string().max(30).optional(), error: code.optional() }),
  tcp: z.object({ status: z.enum(['ready', 'missing', 'unknown']), pid: z.number().int().positive().optional(), localAddress: z.string().max(100).optional(), remoteAddress: z.string().max(100).optional(), remotePort: port.optional(), error: code.optional() }),
  issues: z.array(code).max(24),
})

export type RelayRecoveryProfile = z.infer<typeof profileSchema>
export type RelayRecoveryInspection = z.infer<typeof inspectionSchema>

function profileInput(profile: RelayRecoveryProfile) {
  const parsed = profileSchema.safeParse(profile)
  if (!parsed.success) throw new Error('RELAY_PROFILE_INVALID')
  return { ...parsed.data, relayExecutable: parsed.data.relayExecutable ? path.win32.normalize(parsed.data.relayExecutable) : '' }
}

/** Only these fixed operations are exposed. No shell arguments or task XML comes from the renderer. */
export function createRelayRecovery(runner: NetworkRunner) {
  return {
    async inspect(profile: RelayRecoveryProfile): Promise<RelayRecoveryInspection> {
      const raw = await runner({ action: 'relayInspect', ...profileInput(profile) })
      const parsed = inspectionSchema.safeParse(raw)
      if (!parsed.success) throw new Error('RELAY_INSPECTION_INVALID')
      return parsed.data
    },
    async create(profile: RelayRecoveryProfile, expectedBinaryHash: string): Promise<{ taskFingerprint: string }> {
      const input = profileInput(profile)
      if (!input.relayExecutable || !hash.safeParse(expectedBinaryHash).success) throw new Error('RELAY_BINARY_IDENTITY_REQUIRED')
      const raw = await runner({ action: 'relayTaskCreate', ...input, expectedBinaryHash: expectedBinaryHash.toUpperCase() })
      const parsed = z.object({ taskFingerprint: hash }).safeParse(raw)
      if (!parsed.success) throw new Error('RELAY_CREATE_RESPONSE_INVALID')
      return parsed.data
    },
    async remove(profile: RelayRecoveryProfile, expectedTaskFingerprint: string): Promise<void> {
      const input = profileInput(profile)
      if (!hash.safeParse(expectedTaskFingerprint).success) throw new Error('RELAY_TASK_IDENTITY_REQUIRED')
      await runner({ action: 'relayTaskRemove', ...input, expectedTaskFingerprint: expectedTaskFingerprint.toUpperCase() })
    },
  }
}
