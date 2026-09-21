import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('client registers only in the additive shell overlay slot', async () => {
  const source = await readFile(new URL('../dsh/client.js', import.meta.url), 'utf8')
  assert.match(source, /slots\.inject\('shell\.overlay'/)
  assert.doesNotMatch(source, /slots\.inject\('root'/)
  assert.match(source, /requestFullscreen/)
  assert.match(source, /dsh\.compact\.scale/)
})
