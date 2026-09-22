// dsh-chat-attachments, host half.
//
// DSH 0.1.1 has a durable image attachment path but no arbitrary-file upload.
// This route stores a general file beneath the authoritative live session cwd;
// the browser never supplies a destination path. The returned path is inserted
// into the draft so the model can read it with ordinary workspace tools.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

export const name = 'chat-attachments'
export const inject = []

const ROUTE_PREFIX = '/plugin/chat-attachments/upload/'
const DEFAULTS = {
  maxFileBytes: 50 * 1024 * 1024,
  maxFilesPerPick: 8,
  uploadDirectory: '.dsh-uploads',
}

// The model's Read tool refuses binary files, so a PDF alone is a dead end.
// Its text is saved beside it and that path is what the draft points at.
// Git for Windows ships pdftotext but DSH's PATH usually does not include it.
const PDFTOTEXT_CANDIDATES = [
  'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe',
  '/usr/bin/pdftotext',
  '/opt/homebrew/bin/pdftotext',
  '/usr/local/bin/pdftotext',
]

function pdftotextBinary() {
  return PDFTOTEXT_CANDIDATES.find((candidate) => existsSync(candidate)) ?? 'pdftotext'
}

function isPdf(name, mediaType, data) {
  return mediaType === 'application/pdf' || /\.pdf$/i.test(name) ||
    data.subarray(0, 5).toString('latin1') === '%PDF-'
}

async function extractPdfText(pdfPath, binary = pdftotextBinary()) {
  const textPath = pdfPath + '.txt'
  try {
    if ((await stat(textPath)).size > 0) return { textPath }
  } catch {}
  return new Promise((done) => {
    execFile(binary, ['-layout', '-enc', 'UTF-8', pdfPath, textPath], { timeout: 120000 }, (error) => {
      if (error) {
        done({ textError: `pdftotext failed: ${error.code === 'ENOENT' ? 'not installed' : error.message}` })
        return
      }
      stat(textPath).then(
        (info) => done(info.size > 0 ? { textPath } : { textError: 'the PDF has no text layer (scanned?)' }),
        () => done({ textError: 'pdftotext wrote no output' }),
      )
    })
  })
}

function safeFileName(value) {
  const leaf = basename(String(value || '').replaceAll('\\', '/'))
  const cleaned = leaf
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  const fallback = cleaned || 'attachment'
  return fallback.length <= 140 ? fallback : fallback.slice(-140)
}

function sessionIdFromUrl(rawUrl) {
  let path
  try {
    path = new URL(rawUrl || '', 'http://localhost').pathname
  } catch {
    return null
  }
  if (!path.startsWith(ROUTE_PREFIX)) return null
  const encoded = path.slice(ROUTE_PREFIX.length)
  if (!encoded || encoded.includes('/')) return null
  try {
    const decoded = decodeURIComponent(encoded)
    return decoded && decoded.length <= 256 ? decoded : null
  } catch {
    return null
  }
}

function decodeFileName(header) {
  if (typeof header !== 'string' || header.length === 0 || header.length > 1024) return 'attachment'
  try {
    return safeFileName(decodeURIComponent(header))
  } catch {
    return safeFileName(header)
  }
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readRequest(req, limit) {
  const declared = Number(req.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    const error = new Error('file exceeds upload limit')
    error.statusCode = 413
    throw error
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > limit) {
      const error = new Error('file exceeds upload limit')
      error.statusCode = 413
      throw error
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, bytes)
}

function assertConfig(config) {
  if (!Number.isInteger(config.maxFileBytes) || config.maxFileBytes < 1) {
    throw new Error('dsh-chat-attachments: maxFileBytes must be a positive integer')
  }
  if (!Number.isInteger(config.maxFilesPerPick) || config.maxFilesPerPick < 1 || config.maxFilesPerPick > 64) {
    throw new Error('dsh-chat-attachments: maxFilesPerPick must be an integer from 1 to 64')
  }
  if (typeof config.uploadDirectory !== 'string' || !/^[A-Za-z0-9._-]+$/.test(config.uploadDirectory)) {
    throw new Error('dsh-chat-attachments: uploadDirectory must be one safe directory name')
  }
}

function registerUploadRoute(scope, config) {
  return scope.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX.slice(0, -1),
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      const sessionId = sessionIdFromUrl(req.url)
      if (sessionId === null) {
        sendJson(res, 400, { error: 'invalid session id' })
        return
      }
      const agents = scope.get?.('agents')
      const sessions = scope.get?.('sessions')
      const agent = agents?.get?.(sessionId)
      // A restored browser chat can be attached without a live Agent until its
      // next send. Authorize against that attached Session as the cold path so
      // the paperclip works before the user wakes the model.
      const session = agent?.session ?? sessions?.get?.(sessionId)
      const header = session?.header
      const cwd = header?.cwd
      if (typeof cwd !== 'string' || cwd.trim() === '') {
        sendJson(res, 409, { error: 'the session has no live workspace' })
        return
      }
      if (header?.origin === 'subagent') {
        sendJson(res, 403, { error: 'uploads to subagent sessions are not allowed' })
        return
      }
      try {
        const data = await readRequest(req, config.maxFileBytes)
        const originalName = decodeFileName(req.headers?.['x-dsh-file-name'])
        const digest = createHash('sha256').update(data).digest('hex')
        const directory = resolve(cwd, config.uploadDirectory)
        const cwdRoot = resolve(cwd) + sep
        if (!(directory + sep).startsWith(cwdRoot)) throw new Error('unsafe upload directory')
        await mkdir(directory, { recursive: true })
        const savedName = `${digest.slice(0, 12)}-${originalName}`
        const target = join(directory, savedName)
        try {
          await writeFile(target, data, { flag: 'wx' })
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
        }
        const mediaType = typeof req.headers?.['content-type'] === 'string'
          ? req.headers['content-type'].split(';', 1)[0]
          : 'application/octet-stream'
        const extracted = isPdf(originalName, mediaType, data) ? await extractPdfText(target) : {}
        sendJson(res, 201, {
          path: target,
          name: originalName,
          bytes: data.byteLength,
          mediaType,
          ...extracted,
        })
      } catch (error) {
        sendJson(res, error?.statusCode || 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}

export function apply(ctx, config = {}) {
  const resolved = { ...DEFAULTS, ...config }
  assertConfig(resolved)
  ctx.inject(['webServer', 'agents', 'sessions'], (scope) => {
    scope.effect(() => registerUploadRoute(scope, resolved), 'dsh-chat-attachments: upload route')
  })
}

export const _internal = {
  ROUTE_PREFIX,
  DEFAULTS,
  safeFileName,
  sessionIdFromUrl,
  decodeFileName,
  readRequest,
  assertConfig,
  registerUploadRoute,
  isPdf,
  extractPdfText,
}
