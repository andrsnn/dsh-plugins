/**
 * dsh-plan-file, host half.
 *
 * Stock plan mode (`@deepseek-ai/dsh-plan-mode`) holds the plan in the model's
 * context until `exit_plan_mode` presents the whole thing at once. Two things
 * follow from that and both hurt an iterative review: changing one step costs a
 * full re-emission of the plan, and between turns there is nothing to look at.
 *
 * This plugin gives the working document a file. `doc_write` lays down the
 * first draft, `doc_edit` makes surgical string replacements afterwards, and
 * `doc_read` hands back what is actually on disk (authoritative after a
 * compaction, a resume, or a hand edit). A read-only route serves the same file
 * to the browser so the web panel can render it live beside the chat.
 *
 * Two modes use the same machinery:
 *
 *   plan mode   - DSH's own mode. The document is PLAN.md and the end of it is
 *                 an approved plan that gets implemented.
 *   refine mode - this plugin's mode, entered with `/refine [file.md]`. The
 *                 document is whatever the conversation is about, and there is
 *                 no implementation step at all: the deliverable IS the file.
 *
 * The document lives in the SESSION WORKSPACE, resolved from the live or
 * restored Session's `cwd` — a caller names a workspace-relative file at most,
 * so nothing can point the document outside the workspace it belongs to.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

export const name = 'plan-file'
// `tools` is a hard dependency (the plugin is pointless without it) and is
// declared the way dsh-image-finder declares it, which is the shape this
// deployment has already proven. Everything else is optional: a headless
// profile has no web server, and a composition may mount no command registry.
export const inject = ['tools']

const STATE_ROUTE_PREFIX = '/plugin/plan-file/state/'
const MODE_ROUTE_PREFIX = '/plugin/plan-file/mode/'

const DEFAULTS = {
  fileName: 'PLAN.md',
  maxBytes: 512 * 1024,
}

/** Typed error with a machine-routable code (the llmhub plugin convention). */
class PlanFileError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'PlanFileError'
    this.code = code
  }
}

function assertConfig(config) {
  if (typeof config.fileName !== 'string' || config.fileName.trim() === '') {
    throw new Error('dsh-plan-file: fileName must be a non-empty string')
  }
  if (isAbsolute(config.fileName) || /[\\/]/.test(config.fileName) || config.fileName.includes('..')) {
    throw new Error('dsh-plan-file: fileName must be one workspace-relative file name')
  }
  if (!Number.isInteger(config.maxBytes) || config.maxBytes < 1024) {
    throw new Error('dsh-plan-file: maxBytes must be an integer of at least 1024')
  }
}

/**
 * Normalize a caller-supplied document name to a workspace-relative markdown
 * path. Subdirectories are allowed (`notes/strategy.md`) because that is where
 * documents actually live; absolute paths, traversal, and non-markdown files
 * are not.
 */
function normalizeDocName(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/')
  if (raw === '') throw new PlanFileError('the document name is empty', 'INVALID_ARGS')
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new PlanFileError('name the document relative to the workspace, not by absolute path', 'UNSAFE_PATH')
  }
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    throw new PlanFileError('the document name may not step outside the workspace', 'UNSAFE_PATH')
  }
  const cleaned = parts.join('/')
  if (!/\.mdx?$/i.test(cleaned)) {
    throw new PlanFileError('the document must be a markdown file (.md)', 'NOT_MARKDOWN')
  }
  if (cleaned.length > 200) throw new PlanFileError('the document name is too long', 'INVALID_ARGS')
  return cleaned
}

/**
 * Absolute path of one document in one workspace. Containment is a property of
 * the normalized name, but the join is checked anyway: a name that normalizes
 * cleanly and still escapes would be a bug worth failing on.
 */
function docPathFor(cwd, docName) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new PlanFileError('this session has no workspace directory', 'NO_WORKSPACE')
  }
  const root = resolve(cwd)
  const target = resolve(root, docName)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new PlanFileError('the document would fall outside the workspace', 'UNSAFE_PATH')
  }
  return target
}

/** Read a document. A missing file is a normal state, not a failure. */
async function readDoc(path) {
  try {
    const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    return { exists: true, content, bytes: info.size, mtimeMs: Math.round(info.mtimeMs) }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { exists: false, content: '', bytes: 0, mtimeMs: 0 }
    }
    throw error
  }
}

/**
 * Replace a document's bytes without a window where it is half-written: the
 * browser polls this file continuously, and a partial read renders as a plan
 * that briefly lost half its steps.
 */
async function writeDocAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const staging = `${path}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(staging, content, 'utf8')
  await rename(staging, path)
}

/** Added/removed line counts, which is all the panel and the tool result need. */
function diffStat(before, after) {
  if (before === after) return { added: 0, removed: 0 }
  const kept = new Map()
  for (const line of before.split('\n')) kept.set(line, (kept.get(line) ?? 0) + 1)
  let added = 0
  for (const line of after.split('\n')) {
    const seen = kept.get(line) ?? 0
    if (seen > 0) kept.set(line, seen - 1)
    else added += 1
  }
  let removed = 0
  for (const count of kept.values()) removed += count
  return { added, removed }
}

/** `- [ ]` / `- [x]` progress, so the panel and the model can both see it. */
function checklistProgress(content) {
  let total = 0
  let done = 0
  for (const line of content.split('\n')) {
    const match = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/.exec(line)
    if (match === null) continue
    total += 1
    if (match[1] !== ' ') done += 1
  }
  return { total, done }
}

/**
 * Apply one ordered batch of replacements. An empty `old_str` appends, which is
 * the cheap "add a section" case; anything else must match exactly, and must
 * match exactly once unless the caller opted into `replace_all`. Ambiguity is
 * rejected rather than guessed at: the model can always pass more surrounding
 * text.
 */
function applyEdits(original, edits) {
  let content = original
  const applied = []
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index]
    const oldStr = typeof edit?.old_str === 'string' ? edit.old_str : ''
    const newStr = typeof edit?.new_str === 'string' ? edit.new_str : ''
    const label = `edit ${index + 1}`
    if (oldStr === '') {
      if (newStr === '') throw new PlanFileError(`${label}: old_str and new_str are both empty`, 'INVALID_ARGS')
      const separator = content === '' || content.endsWith('\n') ? '' : '\n'
      content = content + separator + newStr + (newStr.endsWith('\n') ? '' : '\n')
      applied.push({ kind: 'append', occurrences: 1 })
      continue
    }
    let occurrences = 0
    let at = content.indexOf(oldStr)
    while (at !== -1) {
      occurrences += 1
      at = content.indexOf(oldStr, at + oldStr.length)
      if (occurrences > 1 && edit.replace_all !== true) break
    }
    if (occurrences === 0) {
      throw new PlanFileError(`${label}: old_str was not found in the document`, 'NO_MATCH')
    }
    if (occurrences > 1 && edit.replace_all !== true) {
      throw new PlanFileError(
        `${label}: old_str matches more than once; pass more surrounding text or set replace_all`,
        'AMBIGUOUS_MATCH',
      )
    }
    content = edit.replace_all === true ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr)
    applied.push({ kind: edit.replace_all === true ? 'replace_all' : 'replace', occurrences })
  }
  return { content, applied }
}

/**
 * Which document each session is working on, and whether refine mode is on.
 *
 * Durable, because the alternative is worse than it looks: the target is the
 * only thing tying `/refine notes/strategy.md` to the next twenty turns, and a
 * `dsh web` restart mid-review would silently drop every session back to
 * PLAN.md. It is kept in the harness home rather than the workspace so it never
 * shows up in anyone's `git status`.
 */
function createSessionState(options) {
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const storePath = join(dshHome, 'storages', 'plan-file-sessions.json')
  const bySession = new Map()
  const activity = new Map()
  let loaded = false
  let flushing = null
  let dirty = false

  async function load() {
    if (loaded) return
    loaded = true
    try {
      const parsed = JSON.parse(await readFile(storePath, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        for (const [id, row] of Object.entries(parsed)) {
          if (!row || typeof row !== 'object') continue
          bySession.set(id, {
            file: typeof row.file === 'string' ? row.file : options.fileName,
            refine: row.refine === true,
          })
        }
      }
    } catch (error) {
      // A missing or corrupt store is the same as no saved targets: every
      // session falls back to the default document rather than failing to boot.
      void error
    }
  }

  function schedule() {
    dirty = true
    if (flushing !== null) return
    flushing = setTimeout(() => {
      flushing = null
      if (!dirty) return
      dirty = false
      const plain = {}
      for (const [id, row] of bySession) plain[id] = row
      mkdir(dirname(storePath), { recursive: true })
        .then(() => writeFile(storePath, JSON.stringify(plain), 'utf8'))
        .catch(() => {})
    }, 400)
    if (typeof flushing?.unref === 'function') flushing.unref()
  }

  function get(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return { file: options.fileName, refine: false }
    return bySession.get(sessionId) ?? { file: options.fileName, refine: false }
  }

  function patch(sessionId, changes) {
    if (typeof sessionId !== 'string' || sessionId === '') return get(sessionId)
    const next = { ...get(sessionId), ...changes }
    bySession.set(sessionId, next)
    schedule()
    return next
  }

  return {
    storePath,
    load,
    get,
    setFile: (sessionId, file) => patch(sessionId, { file }),
    setRefine: (sessionId, refine) => patch(sessionId, { refine: refine === true }),
    recordEdit(path, entry) {
      const rows = activity.get(path) ?? []
      rows.unshift(entry)
      activity.set(path, rows.slice(0, 12))
      return entry
    },
    recent: (path) => activity.get(path) ?? [],
  }
}

/** The session behind one tool call. */
function sessionForExecution(exec) {
  const session = exec?.agent?.session
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new PlanFileError('this session has no workspace directory', 'NO_WORKSPACE')
  }
  return { id: session?.header?.id, cwd }
}

/**
 * The document one call acts on. An explicit `file` both selects the document
 * AND makes it the session's active one, which is what lets "refine
 * gamma-deck.md" move the panel without a separate targeting tool.
 */
function resolveTarget(state, exec, explicitFile) {
  const session = sessionForExecution(exec)
  let docName
  if (explicitFile !== undefined && explicitFile !== null && String(explicitFile).trim() !== '') {
    docName = normalizeDocName(explicitFile)
    state.setFile(session.id, docName)
  } else {
    docName = state.get(session.id).file
  }
  return { sessionId: session.id, cwd: session.cwd, docName, path: docPathFor(session.cwd, docName) }
}

function assertSize(content, maxBytes) {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxBytes) {
    throw new PlanFileError(`the document would be ${bytes} bytes, over the ${maxBytes}-byte limit`, 'TOO_LARGE')
  }
  return bytes
}

const FILE_PARAMETER = {
  type: 'string',
  description:
    'Workspace-relative markdown file to act on, e.g. "notes/strategy.md". '
    + 'Omit it to use the document this session is already working on (PLAN.md by default). '
    + 'Passing it also switches the panel the user is watching to that file.',
}

function renderSummary(value) {
  const progress = value.checklist.total > 0
    ? `, ${value.checklist.done}/${value.checklist.total} boxes checked`
    : ''
  return `${value.file} — ${value.lines} lines (+${value.added} −${value.removed})${progress}`
}

const RESULT_PROPERTIES = {
  file: { type: 'string' },
  path: { type: 'string' },
  created: { type: 'boolean' },
  bytes: { type: 'integer' },
  lines: { type: 'integer' },
  added: { type: 'integer' },
  removed: { type: 'integer' },
  checklist: {
    type: 'object',
    additionalProperties: false,
    properties: { total: { type: 'integer' }, done: { type: 'integer' } },
    required: ['total', 'done'],
  },
}

function docReadTool(options, state) {
  return {
    name: 'doc_read',
    description:
      'Read the markdown document this session is working on — PLAN.md in plan mode, the refine target in refine mode. '
      + 'It is what the user is watching in the panel beside the conversation, and it is authoritative: '
      + 'read it before editing it, after a compaction or a resume, and whenever the user refers to "the plan", '
      + '"the doc", or "the document". Pass `file` to open a different one and switch the panel to it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { file: FILE_PARAMETER },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          path: { type: 'string' },
          exists: { type: 'boolean' },
          content: { type: 'string' },
          bytes: { type: 'integer' },
          checklist: RESULT_PROPERTIES.checklist,
        },
        required: ['file', 'path', 'exists', 'content', 'bytes', 'checklist'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.exists
          ? `${value.file}\n\n${value.content}`
          : `${value.file} does not exist yet. Create it with doc_write.`,
      }],
    },
    timeoutMs: 30000,
    async execute(args, exec) {
      const target = resolveTarget(state, exec, args?.file)
      const current = await readDoc(target.path)
      return {
        file: target.docName,
        path: target.path,
        exists: current.exists,
        content: current.content,
        bytes: current.bytes,
        checklist: checklistProgress(current.content),
      }
    },
  }
}

function docWriteTool(options, state) {
  return {
    name: 'doc_write',
    description:
      'Create or completely replace a markdown document in the session workspace. '
      + 'Use this ONCE, for the first draft, and then use doc_edit for every later change — '
      + 'rewriting the whole document to adjust one part wastes output and loses the user\'s place in the panel. '
      + 'Write markdown starting with a "# " title. In plan mode write implementation steps as "- [ ] " '
      + 'checklist items so progress is visible. The user sees this file update live; '
      + 'do not also paste its contents into your reply.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: 'The complete markdown document, starting with a "# " title.' },
        file: FILE_PARAMETER,
        summary: { type: 'string', description: 'One short line naming what changed, shown in the panel.' },
      },
      required: ['content'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: RESULT_PROPERTIES,
        required: ['file', 'path', 'created', 'bytes', 'lines', 'added', 'removed', 'checklist'],
      },
      render: (_args, value) => [{ type: 'text', text: renderSummary(value) }],
    },
    timeoutMs: 30000,
    async execute(args, exec) {
      const content = String(args?.content ?? '')
      if (content.trim() === '') throw new PlanFileError('content must not be empty', 'INVALID_ARGS')
      const target = resolveTarget(state, exec, args?.file)
      const normalized = content.endsWith('\n') ? content : content + '\n'
      const bytes = assertSize(normalized, options.maxBytes)
      const before = await readDoc(target.path)
      await writeDocAtomic(target.path, normalized)
      const stats = diffStat(before.content, normalized)
      state.recordEdit(target.path, {
        at: Date.now(),
        kind: before.exists ? 'rewrite' : 'create',
        summary: typeof args?.summary === 'string' ? args.summary.slice(0, 200) : '',
        added: stats.added,
        removed: stats.removed,
      })
      return {
        file: target.docName,
        path: target.path,
        created: !before.exists,
        bytes,
        lines: normalized.split('\n').length - 1,
        added: stats.added,
        removed: stats.removed,
        checklist: checklistProgress(normalized),
      }
    },
  }
}

function docEditTool(options, state) {
  return {
    name: 'doc_edit',
    description:
      'Make surgical edits to an existing markdown document by exact string replacement. '
      + 'This is the normal way to change a document: when the user pushes back on one part, edit that part — '
      + 'do not rewrite it with doc_write and do not restate the whole thing in your reply. '
      + 'Each edit replaces old_str with new_str; old_str must match the file exactly and match exactly once '
      + '(pass more surrounding lines to disambiguate, or set replace_all). An empty old_str appends new_str. '
      + 'In plan mode, use it during implementation to tick a finished step from "- [ ]" to "- [x]".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        edits: {
          type: 'array',
          description: 'Replacements applied in order against the file as it stands after the previous one.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              old_str: { type: 'string', description: 'Exact text to replace. Empty means append new_str to the end.' },
              new_str: { type: 'string', description: 'Replacement text. Empty deletes the matched text.' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
            },
            required: ['old_str', 'new_str'],
          },
        },
        file: FILE_PARAMETER,
        summary: { type: 'string', description: 'One short line naming what changed, shown in the panel.' },
      },
      required: ['edits'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ...RESULT_PROPERTIES, edits: { type: 'integer' } },
        required: ['file', 'path', 'created', 'bytes', 'lines', 'added', 'removed', 'edits', 'checklist'],
      },
      render: (_args, value) => [{ type: 'text', text: `${renderSummary(value)} via ${value.edits} edit(s)` }],
    },
    timeoutMs: 30000,
    async execute(args, exec) {
      const edits = Array.isArray(args?.edits) ? args.edits : []
      if (edits.length === 0) throw new PlanFileError('edits must be a non-empty array', 'INVALID_ARGS')
      if (edits.length > 32) throw new PlanFileError('edits must hold at most 32 replacements', 'INVALID_ARGS')
      const target = resolveTarget(state, exec, args?.file)
      const before = await readDoc(target.path)
      if (!before.exists) {
        throw new PlanFileError(`${target.docName} does not exist yet; create it with doc_write`, 'NO_DOCUMENT')
      }
      const result = applyEdits(before.content, edits)
      const normalized = result.content.endsWith('\n') ? result.content : result.content + '\n'
      const bytes = assertSize(normalized, options.maxBytes)
      await writeDocAtomic(target.path, normalized)
      const stats = diffStat(before.content, normalized)
      state.recordEdit(target.path, {
        at: Date.now(),
        kind: 'edit',
        summary: typeof args?.summary === 'string' ? args.summary.slice(0, 200) : '',
        added: stats.added,
        removed: stats.removed,
      })
      return {
        file: target.docName,
        path: target.path,
        created: false,
        bytes,
        lines: normalized.split('\n').length - 1,
        added: stats.added,
        removed: stats.removed,
        edits: result.applied.length,
        checklist: checklistProgress(normalized),
      }
    },
  }
}

// ----------------------------------------------------------------- refine mode

/**
 * The refine-mode prompt. Plan mode's own section is owned by the agent preset
 * (see ../patch_plan_file_prompt.py); this is the counterpart for a session
 * whose deliverable IS the document, with no implementation step to approve.
 */
function refineSection(docName) {
  return [
    `You are in refine mode. The document ${docName} in the session workspace is the deliverable, and the user`
    + ' is watching it in a panel beside this conversation. There is nothing to implement afterwards: the'
    + ' work of this session is making that document better.',

    `Call doc_read first to see what ${docName} already contains. If it does not exist yet, draft it with`
    + ' doc_write, once. Every change after that is a doc_edit against the exact text being replaced: when the'
    + ' user reacts to one section, edit that section. Do not rewrite the document to change part of it.',

    'Do not restate the document, or any large part of it, in your reply — the user reads the file, not the'
    + ' message. Answer with a sentence or two naming what you changed and what is still open or undecided.'
    + ' Say so plainly when you think an edit makes the document worse.',

    'Refine mode changes the document and nothing else. Do not edit other files, write or run code, change'
    + ' configuration, or commit. These rules override any later tool description that suggests using'
    + ' mutation tools; those tools stay listed to keep the tool catalog unchanged. Do not call exit_plan_mode'
    + ' and do not use todo_write: there is no implementation phase to approve or track. Reading the repository'
    + ' to ground the document in fact is fine and encouraged.',

    'Switch to plan mode when the user wants the document turned into work.',
  ].join('\n\n')
}

/**
 * Contribute refine guidance as one section whose whole text is a variable. A
 * section is a fixed string, but a VARIABLE is resolved per assembly with that
 * assembly's agent, which is what makes this per-session instead of a global
 * flag. An empty value renders an empty section, and empty sections are
 * dropped, so a session that is not refining pays nothing.
 */
function registerRefinePrompt(scope, state) {
  const disposers = [
    scope.systemPrompt.section({
      name: 'plan-file:refine',
      order: 55,
      text: '{{plan_file_refine}}',
    }),
    scope.systemPrompt.variable('plan_file_refine', (context) => {
      const sessionId = context?.agent?.session?.header?.id
      if (typeof sessionId !== 'string') return ''
      const row = state.get(sessionId)
      return row.refine === true ? refineSection(row.file) : ''
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch (error) { void error }
    }
  }
}

/**
 * A user message, built by hand. A profile-linked plugin cannot reliably
 * resolve sibling @deepseek-ai packages, so `createUserMessage` from
 * `@deepseek-ai/dsh-llm` is inlined rather than imported; its whole body is a
 * frozen `{id, role, content, source}`.
 */
function userMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'user' }),
  })
}

// A leading token that is recognisably a file name is taken as the target,
// including one this plugin will go on to refuse. `/refine notes.txt` has to
// say "that is not markdown" - quietly steering it as a prompt instead would
// leave the user watching the wrong document.
const FILE_TOKEN = /^(?:[^\s/\\]*[/\\])*[^\s/\\]+\.(?:mdx?|markdown|txt|rst|adoc|html?|json|ya?ml|docx?|pdf|csv)$/i

/** Split `/refine` input into an optional leading document name and the rest. */
function parseRefineInput(rawInput) {
  const trimmed = String(rawInput ?? '').trim()
  if (trimmed === '') return { action: 'on', file: null, message: '' }
  if (trimmed === 'off') return { action: 'off', file: null, message: '' }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (match !== null && FILE_TOKEN.test(match[1])) {
    return { action: 'on', file: match[1], message: (match[2] ?? '').trim() }
  }
  return { action: 'on', file: null, message: trimmed }
}

function registerRefineCommand(scope, state, options) {
  return scope.commands.register({
    name: 'refine',
    description: 'Iterate on a markdown document, with nothing to implement',
    input: { hint: '[off|<file.md>] [message]', images: false },
    handler: ({ agent, rawInput }) => {
      const sessionId = agent?.session?.header?.id
      const parsed = parseRefineInput(rawInput)
      if (parsed.action === 'off') {
        state.setRefine(sessionId, false)
        return { kind: 'success', text: 'Refine mode off.' }
      }
      let docName = state.get(sessionId).file
      if (parsed.file !== null) {
        try {
          docName = normalizeDocName(parsed.file)
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
        state.setFile(sessionId, docName)
      } else if (docName === options.fileName) {
        // Refining PLAN.md is almost never what is meant, and silently
        // targeting it is the kind of default that quietly edits the wrong
        // file. Ask for the document instead.
        return {
          kind: 'error',
          text: 'Name the document: /refine notes/strategy.md  (it is created if it does not exist yet).',
        }
      }
      state.setRefine(sessionId, true)
      if (parsed.message !== '') {
        try {
          agent.steer(userMessage(parsed.message))
        } catch (error) {
          return {
            kind: 'success',
            text: `Refine mode on for ${docName}. Send your request as an ordinary message `
              + `(steering failed: ${error instanceof Error ? error.message : String(error)}).`,
          }
        }
      }
      return { kind: 'success', text: `Refine mode on for ${docName}. Use /refine off to leave.` }
    },
  })
}

// ---------------------------------------------------------------------- routes

function sessionIdFromUrl(rawUrl, prefix) {
  let path
  try {
    path = new URL(rawUrl || '', 'http://localhost').pathname
  } catch {
    return null
  }
  if (!path.startsWith(prefix)) return null
  const encoded = path.slice(prefix.length)
  if (!encoded || encoded.includes('/')) return null
  try {
    const decoded = decodeURIComponent(encoded)
    return decoded && decoded.length <= 256 ? decoded : null
  } catch {
    return null
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

async function readJsonBody(req, limit = 8192) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > limit) throw new PlanFileError('request body too large', 'TOO_LARGE')
    chunks.push(buffer)
  }
  if (bytes === 0) return {}
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
}

/**
 * The workspace's other markdown documents, so the panel can say what else is
 * there. Shallow and capped: this runs on every poll of an open panel, and a
 * deep walk of a large repository is not worth a dropdown.
 */
async function listDocuments(cwd, limit = 40) {
  const found = []
  async function scan(directory, depth, prefix) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (depth > 0) await scan(join(directory, entry.name), depth - 1, rel)
      } else if (/\.mdx?$/i.test(entry.name)) {
        found.push(rel)
      }
    }
  }
  await scan(cwd, 1, '')
  return found.sort()
}

function sessionFromScope(scope, sessionId) {
  const agents = scope.get?.('agents')
  const sessions = scope.get?.('sessions')
  // A restored browser chat can be attached without a live Agent until its next
  // send. Authorize against that attached Session as the cold path so the panel
  // works before the user wakes the model.
  return agents?.get?.(sessionId)?.session ?? sessions?.get?.(sessionId)
}

function registerStateRoute(scope, options, state) {
  return scope.webServer.register({
    kind: 'prefix',
    path: STATE_ROUTE_PREFIX.slice(0, -1),
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      const sessionId = sessionIdFromUrl(req.url, STATE_ROUTE_PREFIX)
      if (sessionId === null) {
        sendJson(res, 400, { error: 'invalid session id' })
        return
      }
      const session = sessionFromScope(scope, sessionId)
      const cwd = session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.trim() === '') {
        sendJson(res, 409, { error: 'the session has no live workspace' })
        return
      }
      try {
        await state.load()
        const row = state.get(sessionId)
        const path = docPathFor(cwd, row.file)
        const current = await readDoc(path)
        sendJson(res, 200, {
          file: row.file,
          fileName: row.file,
          path,
          refine: row.refine === true,
          isDefault: row.file === options.fileName,
          exists: current.exists,
          content: current.content,
          bytes: current.bytes,
          mtimeMs: current.mtimeMs,
          checklist: checklistProgress(current.content),
          recent: state.recent(path),
          documents: await listDocuments(cwd),
        })
      } catch (error) {
        sendJson(res, error?.code === 'NO_WORKSPACE' ? 409 : 500, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })
}

function registerModeRoute(scope, options, state) {
  return scope.webServer.register({
    kind: 'prefix',
    path: MODE_ROUTE_PREFIX.slice(0, -1),
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      const sessionId = sessionIdFromUrl(req.url, MODE_ROUTE_PREFIX)
      if (sessionId === null) {
        sendJson(res, 400, { error: 'invalid session id' })
        return
      }
      const session = sessionFromScope(scope, sessionId)
      if (session?.header?.cwd === undefined) {
        sendJson(res, 409, { error: 'the session has no live workspace' })
        return
      }
      try {
        await state.load()
        const body = await readJsonBody(req)
        if (typeof body.file === 'string' && body.file.trim() !== '') {
          state.setFile(sessionId, normalizeDocName(body.file))
        }
        if (typeof body.refine === 'boolean') state.setRefine(sessionId, body.refine)
        const row = state.get(sessionId)
        sendJson(res, 200, { file: row.file, refine: row.refine === true })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}

export function apply(ctx, config = {}) {
  const resolved = { ...DEFAULTS, ...config }
  assertConfig(resolved)
  const state = createSessionState(resolved)
  state.load().catch(() => {})

  ctx.tools.register(docReadTool(resolved, state))
  ctx.tools.register(docWriteTool(resolved, state))
  ctx.tools.register(docEditTool(resolved, state))

  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => registerRefinePrompt(scope, state), 'dsh-plan-file: refine prompt')
  })

  ctx.inject(['commands'], (scope) => {
    scope.effect(() => registerRefineCommand(scope, state, resolved), 'dsh-plan-file: /refine')
  })

  ctx.inject(['webServer', 'agents', 'sessions'], (scope) => {
    scope.effect(() => registerStateRoute(scope, resolved, state), 'dsh-plan-file: state route')
    scope.effect(() => registerModeRoute(scope, resolved, state), 'dsh-plan-file: mode route')
  })

  ctx.logger?.info?.(`[plan-file] armed (fileName=${resolved.fileName}, maxBytes=${resolved.maxBytes})`)
}

export const _internal = {
  STATE_ROUTE_PREFIX,
  MODE_ROUTE_PREFIX,
  DEFAULTS,
  PlanFileError,
  assertConfig,
  normalizeDocName,
  docPathFor,
  readDoc,
  writeDocAtomic,
  diffStat,
  checklistProgress,
  applyEdits,
  createSessionState,
  registerRefinePrompt,
  registerRefineCommand,
  resolveTarget,
  sessionIdFromUrl,
  assertSize,
  parseRefineInput,
  refineSection,
  userMessage,
  listDocuments,
  docReadTool,
  docWriteTool,
  docEditTool,
}
