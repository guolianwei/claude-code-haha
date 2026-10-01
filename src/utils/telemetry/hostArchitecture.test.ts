import { describe, expect, it } from 'bun:test'
import { arch } from 'node:os'
import { getHostArchitecture } from './hostArchitecture.js'

describe('architecture-only telemetry resource', () => {
  it.each([
    ['x64', 'amd64'], ['arm', 'arm32'], ['ppc', 'ppc32'],
    ['arm64', 'arm64'], ['ia32', 'ia32'], ['ppc64', 'ppc64'],
    ['s390x', 's390x'], ['riscv64', 'riscv64'], ['future-arch', 'future-arch'],
  ])('preserves the existing OpenTelemetry mapping of %s to %s', (input, expected) => {
    expect(getHostArchitecture(input)).toBe(expected)
  })

  it('defaults to the in-process OS architecture', () => {
    expect(getHostArchitecture()).toBe(getHostArchitecture(arch()))
  })
})
