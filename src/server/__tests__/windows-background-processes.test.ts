import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'acorn'
import { simple } from 'acorn-walk'

type Expression = {
  type: string
  name?: string
  value?: unknown
  object?: Expression
  property?: Expression
  elements?: Expression[]
  properties?: Array<{ type: string; key: Expression; value: Expression }>
}
type Call = { callee: Expression; arguments: Expression[] }

function processCalls(file: string, method: string): Call[] {
  const source = readFileSync(resolve(import.meta.dir, '../..', file), 'utf8')
  // Inspect executable syntax rather than comments or a string that mentions windowsHide.
  const javascript = new Bun.Transpiler({ loader: file.endsWith('tsx') ? 'tsx' : 'ts' }).transformSync(source)
  const tree = parse(javascript, { ecmaVersion: 'latest', sourceType: 'module' })
  const calls: Call[] = []
  simple(tree, { CallExpression(node: unknown) {
    const call = node as Call
    const callee = call.callee
    const name = callee.type === 'Identifier' ? callee.name : `${callee.object?.name}.${callee.property?.name}`
    if (name === method) calls.push(call)
  } })
  return calls
}

const sites = [
  ['server/services/repositoryLaunchService.ts', 'execFile', 1],
  ['server/services/reviewService.ts', 'execFile', 1],
  ['server/services/workspaceService.ts', 'execFile', 1],
  ['server/services/searchService.ts', 'spawn', 3],
  ['server/api/sessions.ts', 'Bun.spawn', 1],
  ['server/api/computer-use.ts', 'Bun.spawn', 1],
  ['utils/ripgrep.ts', 'execFile', 1],
  ['utils/ripgrep.ts', 'Bun.spawn', 1],
  ['utils/Shell.ts', 'execFileSync', 1],
  ['utils/Shell.ts', 'spawn', 1],
  ['utils/bash/ShellSnapshot.ts', 'execFile', 1],
  ['utils/killProcessTree.ts', 'execFile', 1],
  ['utils/settings/mdm/rawRead.ts', 'execFile', 1],
  ['utils/windowsPaths.ts', 'execFileSync', 1],
] as const

describe('background processes never request Windows console windows', () => {
  it('only detaches tool shells on POSIX, with Windows using owned tree cleanup', () => {
    const source = readFileSync(resolve(import.meta.dir, '../../utils/Shell.ts'), 'utf8')
    expect(source).toContain("detached: process.platform !== 'win32' && provider.detached")
  })

  it.each(sites)('%s: %s explicitly hides all %d background calls', (file, method, count) => {
    const calls = processCalls(file, method)
    expect(calls).toHaveLength(count)
    for (const call of calls) {
      const options = call.arguments.find(argument => argument.type === 'ObjectExpression')
      const hidden = options?.properties?.find(property => property.key?.name === 'windowsHide')
      expect(hidden?.value.value).toBe(true)
    }
  })

  it('hides only the cmd wrapper when the user opens the diagnostic folder', () => {
    const calls = processCalls('server/services/diagnosticsService.ts', 'Bun.spawn')
      .filter(call => call.arguments[0]?.elements?.[0]?.value === 'cmd')
    expect(calls).toHaveLength(1)
    const hidden = calls[0]!.arguments[1]?.properties?.find(property => property.key?.name === 'windowsHide')
    expect(hidden?.value.value).toBe(true)
    expect(calls[0]!.arguments[0]?.elements?.[2]?.value).toBe('start')
  })
})
