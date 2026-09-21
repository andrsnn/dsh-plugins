import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { _internal } from '../dsh/index.js'

test('safeFileName strips paths and Windows-unsafe characters', () => {
  assert.equal(_internal.safeFileName('../../bad:<name>.txt'), 'bad__name_.txt')
  assert.equal(_internal.safeFileName('C:\\temp\\report.pdf'), 'report.pdf')
})

test('sessionIdFromUrl decodes exactly one path segment', () => {
  assert.equal(_internal.sessionIdFromUrl('/plugin/chat-attachments/upload/a%3Ab'), 'a:b')
  assert.equal(_internal.sessionIdFromUrl('/plugin/chat-attachments/upload/a/b'), null)
  assert.equal(_internal.sessionIdFromUrl('/elsewhere/a'), null)
})

test('readRequest enforces its byte ceiling', async () => {
  const req = Readable.from([Buffer.from('123'), Buffer.from('456')])
  req.headers = {}
  await assert.rejects(_internal.readRequest(req, 5), /exceeds upload limit/)
})

test('config validation rejects unsafe upload directories', () => {
  assert.throws(() => _internal.assertConfig({ ..._internal.DEFAULTS, uploadDirectory: '../outside' }), /safe directory/)
})

test('upload route accepts an attached cold session and writes only below its cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-chat-attachments-'))
  let route
  const scope = {
    webServer: { register(definition) { route = definition; return () => {} } },
    get(name) {
      if (name === 'agents') return { get() { return undefined } }
      if (name === 'sessions') return { get() { return { header: { cwd } } } }
      return undefined
    },
  }
  _internal.registerUploadRoute(scope, _internal.DEFAULTS)
  const req = Readable.from([Buffer.from('cold session upload')])
  req.method = 'POST'
  req.url = '/plugin/chat-attachments/upload/session-test'
  req.headers = { 'content-type': 'text/plain', 'x-dsh-file-name': 'note.txt' }
  let status
  let body
  const res = {
    writeHead(next) { status = next },
    end(next) { body = next },
  }
  try {
    await route.handler(req, res)
    assert.equal(status, 201)
    const result = JSON.parse(Buffer.from(body).toString('utf8'))
    assert.ok(result.path.startsWith(join(cwd, '.dsh-uploads')))
    assert.equal(await readFile(result.path, 'utf8'), 'cold session upload')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
