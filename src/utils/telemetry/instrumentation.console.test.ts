import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { arch } from 'node:os'
import { hostDetector } from '@opentelemetry/resources'
import { getMeterProvider, setMeterProvider } from '../../bootstrap/state.js'
import * as auth from '../auth.js'
import * as cleanup from '../cleanupRegistry.js'
import { initializeTelemetry } from './instrumentation.js'

const envNames = ['USER_TYPE', 'CLAUDE_CODE_ENABLE_TELEMETRY', 'ENABLE_BETA_TRACING_DETAILED', 'CLAUDE_CODE_PERFETTO_TRACE', 'OTEL_RESOURCE_ATTRIBUTES', 'OTEL_METRICS_EXPORTER', 'OTEL_LOGS_EXPORTER', 'OTEL_TRACES_EXPORTER', 'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE']
let previous: Record<string, string | undefined>
let previousProvider: ReturnType<typeof getMeterProvider>
let previousMacro: PropertyDescriptor | undefined
const restore: Array<() => void> = []
let fullHostProbe: ReturnType<typeof spyOn>

beforeEach(() => {
  previousMacro = Object.getOwnPropertyDescriptor(globalThis, 'MACRO')
  Object.defineProperty(globalThis, 'MACRO', { value: { VERSION: 'fixture-test' }, configurable: true, writable: true })
  previous = Object.fromEntries(envNames.map(key => [key, process.env[key]]))
  for (const key of envNames) delete process.env[key]
  previousProvider = getMeterProvider()
  const probes = [
    spyOn(auth, 'is1PApiCustomer').mockReturnValue(false),
    spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(false),
    spyOn(auth, 'getSubscriptionType').mockReturnValue(null),
    spyOn(cleanup, 'registerCleanup').mockReturnValue(() => {}),
  ]
  // This forbidden call itself initiates machine-ID discovery. Throw before it
  // can query the real registry, even in the red regression run.
  fullHostProbe = spyOn(hostDetector, 'detect').mockImplementation(() => {
    throw new Error('Architecture-only telemetry must not run full host discovery')
  })
  restore.push(...probes.map(probe => () => probe.mockRestore()), () => fullHostProbe.mockRestore())
})

afterEach(async () => {
  const provider = getMeterProvider()
  if (provider && provider !== previousProvider) await provider.shutdown()
  setMeterProvider(previousProvider)
  if (previousMacro) Object.defineProperty(globalThis, 'MACRO', previousMacro)
  else Reflect.deleteProperty(globalThis, 'MACRO')
  for (const fn of restore.splice(0)) fn()
  for (const key of envNames) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
})

describe('chat telemetry without host-probe console processes', () => {
  it.each([false, true])('initializes metrics without machine-ID discovery (environment override: %s)', async override => {
    if (override) process.env.OTEL_RESOURCE_ATTRIBUTES = 'host.arch=fixture-override'
    const meter = await initializeTelemetry()
    expect(meter).toBeDefined()
    expect(fullHostProbe).not.toHaveBeenCalled()
    // Inspect the SDK resource at the integration boundary, not merely the
    // helper's return value: env attributes must still take precedence.
    const provider = getMeterProvider() as unknown as {
      _sharedState: { resource: { attributes: Record<string, unknown> } }
    }
    const attrs = provider._sharedState.resource.attributes
    const nodeArch = arch()
    const expected = nodeArch === 'x64' ? 'amd64' : nodeArch === 'arm' ? 'arm32' : nodeArch === 'ppc' ? 'ppc32' : nodeArch
    expect(attrs['host.arch']).toBe(override ? 'fixture-override' : expected)
    expect(attrs['service.name']).toBe('claude-code')
    expect(attrs).not.toHaveProperty('host.id')
    expect(attrs).not.toHaveProperty('host.name')
  })
})
