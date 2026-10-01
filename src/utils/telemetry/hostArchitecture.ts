import { arch } from 'node:os'

/** The host.arch values used by OpenTelemetry, without its host-ID discovery.
 * A full hostDetector also launches REG.exe on Windows. This application only
 * retains the architecture, so that subprocess is unnecessary and can flash a
 * console each time a chat runtime initializes.
 */
export function getHostArchitecture(nodeArchitecture: string = arch()): string {
  switch (nodeArchitecture) {
    case 'x64': return 'amd64'
    case 'arm': return 'arm32'
    case 'ppc': return 'ppc32'
    default: return nodeArchitecture
  }
}
