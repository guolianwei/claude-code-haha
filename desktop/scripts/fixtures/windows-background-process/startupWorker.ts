import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'

const [modulePath, probePath, output] = process.argv.slice(2)
assert(modulePath && probePath && output)
// The copied module's child_process import resolves to a fixture adapter.
// It forwards identical args/options to this absolute native stand-in; Windows
// system executable search order must never cause a real registry read.
process.env.CC_STARTUP_REG_PROBE = probePath
const source = await import(pathToFileURL(modulePath).href)
source.startMdmRawRead()
const promise = source.getMdmRawReadPromise()
source.startMdmRawRead()
assert.equal(promise, source.getMdmRawReadPromise())
const startup = await promise
const refresh = await source.fireRawRead()
const parse = (value: string | null) => { assert(value, 'fixture registry must return evidence'); return JSON.parse(value) }
writeFileSync(output, JSON.stringify({ startup: { machine: parse(startup.hklmStdout), user: parse(startup.hkcuStdout) }, refresh: { machine: parse(refresh.hklmStdout), user: parse(refresh.hkcuStdout) } }, null, 2))
