import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// The durable target store lives under DSH_HOME. Point it at a throwaway
// directory BEFORE importing the plugin so the suite can never read or write
// the developer's real harness home.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))

const { _internal, apply, name } = await import('../dsh/index.js')

const {
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
  DEFAULTS,
  STATE_ROUTE_PREFIX,
  MODE_ROUTE_PREFIX,
} = _internal

async function workspace() {
  return mkdtemp(join(tmpdir(), 'dsh-plan-file-'))
}

let sessionCounter = 0
function execFor(cwd, id) {
  sessionCounter += 1
  return { agent: { session: { header: { cwd, id: id ?? `s${sessionCounter}` } } } }
}

// The durable store is keyed off DSH_HOME; point it at a temp dir so the suite
// never reads or writes the developer's real harness home.
function freshState(options = DEFAULTS) {
  return createSessionState(options)
}

test('config validation refuses a path instead of a file name', () => {
  assert.doesNotThrow(() => assertConfig({ ...DEFAULTS }))
  assert.throws(() => assertConfig({ ...DEFAULTS, fileName: 'docs/PLAN.md' }), /one workspace-relative file name/)
  assert.throws(() => assertConfig({ ...DEFAULTS, fileName: '../PLAN.md' }), /one workspace-relative file name/)
  assert.throws(() => assertConfig({ ...DEFAULTS, fileName: '' }), /non-empty string/)
  assert.throws(() => assertConfig({ ...DEFAULTS, maxBytes: 10 }), /at least 1024/)
})

test('normalizeDocName allows subdirectories and refuses everything else', () => {
  assert.equal(normalizeDocName('PLAN.md'), 'PLAN.md')
  assert.equal(normalizeDocName('notes/strategy.md'), 'notes/strategy.md')
  assert.equal(normalizeDocName('notes\\strategy.md'), 'notes/strategy.md')
  assert.equal(normalizeDocName('  ./a/b.MD  '), 'a/b.MD')
  assert.throws(() => normalizeDocName('../escape.md'), /outside the workspace/)
  assert.throws(() => normalizeDocName('/etc/passwd.md'), /relative to the workspace/)
  assert.throws(() => normalizeDocName('C:/windows/x.md'), /relative to the workspace/)
  assert.throws(() => normalizeDocName('notes/deck.html'), /markdown file/)
  assert.throws(() => normalizeDocName(''), /empty/)
})

test('the document path stays inside the workspace and a missing cwd is refused', () => {
  assert.ok(docPathFor('/tmp/ws', 'notes/a.md').endsWith('a.md'))
  assert.throws(() => docPathFor('', 'PLAN.md'), /no workspace directory/)
})

test('reading a missing document is a normal empty state', async () => {
  const cwd = await workspace()
  try {
    assert.deepEqual(await readDoc(join(cwd, 'PLAN.md')), { exists: false, content: '', bytes: 0, mtimeMs: 0 })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('writeDocAtomic creates missing directories and leaves no staging file', async () => {
  const cwd = await workspace()
  try {
    const target = join(cwd, 'notes', 'deep', 'doc.md')
    await writeDocAtomic(target, '# hi\n')
    assert.equal(await readFile(target, 'utf8'), '# hi\n')
    const { documents } = { documents: await listDocuments(cwd) }
    assert.ok(documents.every((row) => !row.endsWith('.tmp')))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('diffStat counts added and removed lines', () => {
  assert.deepEqual(diffStat('a\nb\n', 'a\nb\n'), { added: 0, removed: 0 })
  assert.deepEqual(diffStat('a\nb\n', 'a\nb\nc\n'), { added: 1, removed: 0 })
  assert.deepEqual(diffStat('a\nb\nc\n', 'a\nc\n'), { added: 0, removed: 1 })
  assert.deepEqual(diffStat('a\n', 'z\n'), { added: 1, removed: 1 })
})

test('checklistProgress counts every checklist marker shape', () => {
  const text = ['- [ ] one', '* [x] two', '  - [X] three', '1. [ ] four', '- not a task', 'plain [x] text'].join('\n')
  assert.deepEqual(checklistProgress(text), { total: 4, done: 2 })
  assert.deepEqual(checklistProgress(''), { total: 0, done: 0 })
})

test('applyEdits replaces, appends, and refuses ambiguity', () => {
  const original = '# Plan\n\n- [ ] step one\n- [ ] step two\n'
  const once = applyEdits(original, [{ old_str: '- [ ] step one', new_str: '- [x] step one' }])
  assert.match(once.content, /- \[x\] step one/)

  const appended = applyEdits(original, [{ old_str: '', new_str: '- [ ] step three' }])
  assert.match(appended.content, /- \[ \] step three\n$/)
  assert.equal(appended.applied[0].kind, 'append')

  assert.throws(() => applyEdits(original, [{ old_str: 'missing', new_str: 'x' }]), /was not found/)
  assert.throws(() => applyEdits(original, [{ old_str: '- [ ] step', new_str: 'x' }]), /matches more than once/)

  const all = applyEdits(original, [{ old_str: '- [ ] step', new_str: '- [x] step', replace_all: true }])
  assert.equal(all.content.match(/- \[x\] step/g).length, 2)

  const sequential = applyEdits(original, [
    { old_str: 'step one', new_str: 'step ONE' },
    { old_str: 'step ONE', new_str: 'step 1' },
  ])
  assert.match(sequential.content, /step 1/)
})

test('assertSize refuses a document over the limit', () => {
  assert.equal(assertSize('abc', 1024), 3)
  assert.throws(() => assertSize('x'.repeat(2048), 1024), /over the 1024-byte limit/)
})

test('sessionIdFromUrl accepts only one encoded segment on its own route', () => {
  assert.equal(sessionIdFromUrl('/plugin/plan-file/state/abc', STATE_ROUTE_PREFIX), 'abc')
  assert.equal(sessionIdFromUrl('/plugin/plan-file/state/a%20b?x=1', STATE_ROUTE_PREFIX), 'a b')
  assert.equal(sessionIdFromUrl('/plugin/plan-file/state/a/b', STATE_ROUTE_PREFIX), null)
  assert.equal(sessionIdFromUrl('/plugin/plan-file/state/', STATE_ROUTE_PREFIX), null)
  assert.equal(sessionIdFromUrl('/plugin/plan-file/mode/abc', MODE_ROUTE_PREFIX), 'abc')
  // A state URL must not resolve on the mode route, or a GET would flip a mode.
  assert.equal(sessionIdFromUrl('/plugin/plan-file/state/abc', MODE_ROUTE_PREFIX), null)
})

test('session state defaults to the configured document and remembers a target', () => {
  const state = freshState()
  assert.deepEqual(state.get('s1'), { file: 'PLAN.md', refine: false })
  state.setFile('s1', 'notes/strategy.md')
  assert.equal(state.get('s1').file, 'notes/strategy.md')
  state.setRefine('s1', true)
  assert.deepEqual(state.get('s1'), { file: 'notes/strategy.md', refine: true })
  // Sessions do not leak into each other.
  assert.deepEqual(state.get('s2'), { file: 'PLAN.md', refine: false })
})

test('the activity log keeps the newest write first and is per document', () => {
  const state = freshState()
  state.recordEdit('/p', { at: 1 })
  state.recordEdit('/p', { at: 2 })
  assert.deepEqual(state.recent('/p').map((row) => row.at), [2, 1])
  assert.deepEqual(state.recent('/other'), [])
})

test('an explicit file both targets the call and moves the session', async () => {
  const cwd = await workspace()
  try {
    const state = freshState()
    const exec = execFor(cwd, 'sx')
    assert.equal(resolveTarget(state, exec, undefined).docName, 'PLAN.md')
    assert.equal(resolveTarget(state, exec, 'notes/strategy.md').docName, 'notes/strategy.md')
    // The next call with no file follows the session, which is what makes the
    // panel stay on the document the model just opened.
    assert.equal(resolveTarget(state, exec, undefined).docName, 'notes/strategy.md')
    assert.throws(() => resolveTarget(state, exec, '../escape.md'), /outside the workspace/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('doc_write creates the file, doc_read returns it, doc_edit patches it', async () => {
  const cwd = await workspace()
  try {
    const state = freshState()
    const write = docWriteTool(DEFAULTS, state)
    const read = docReadTool(DEFAULTS, state)
    const edit = docEditTool(DEFAULTS, state)
    const exec = execFor(cwd, 'sw')

    const created = await write.execute({ content: '# Plan\n\n- [ ] one\n- [ ] two', summary: 'first draft' }, exec)
    assert.equal(created.created, true)
    assert.equal(created.file, 'PLAN.md')
    assert.deepEqual(created.checklist, { total: 2, done: 0 })
    assert.equal(await readFile(join(cwd, 'PLAN.md'), 'utf8'), '# Plan\n\n- [ ] one\n- [ ] two\n')

    const loaded = await read.execute({}, exec)
    assert.equal(loaded.exists, true)
    assert.match(loaded.content, /- \[ \] one/)

    const edited = await edit.execute({ edits: [{ old_str: '- [ ] one', new_str: '- [x] one' }], summary: 'done one' }, exec)
    assert.deepEqual(edited.checklist, { total: 2, done: 1 })
    assert.equal(edited.edits, 1)
    assert.equal(state.recent(created.path)[0].summary, 'done one')

    await assert.rejects(write.execute({ content: '   ' }, exec), /must not be empty/)
    await assert.rejects(edit.execute({ edits: [] }, exec), /non-empty array/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('naming a file writes that document and leaves the default alone', async () => {
  const cwd = await workspace()
  try {
    const state = freshState()
    const write = docWriteTool(DEFAULTS, state)
    const read = docReadTool(DEFAULTS, state)
    const exec = execFor(cwd, 'sr')

    const made = await write.execute({ file: 'notes/strategy.md', content: '# Strategy' }, exec)
    assert.equal(made.file, 'notes/strategy.md')
    assert.equal(await readFile(join(cwd, 'notes', 'strategy.md'), 'utf8'), '# Strategy\n')
    await assert.rejects(readFile(join(cwd, 'PLAN.md'), 'utf8'), /ENOENT/)

    // A bare read now follows the session to the document just written.
    assert.equal((await read.execute({}, exec)).file, 'notes/strategy.md')
    // And naming the default explicitly moves back.
    assert.equal((await read.execute({ file: 'PLAN.md' }, exec)).file, 'PLAN.md')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('doc_edit refuses to invent a document that does not exist', async () => {
  const cwd = await workspace()
  try {
    const edit = docEditTool(DEFAULTS, freshState())
    await assert.rejects(
      edit.execute({ edits: [{ old_str: 'a', new_str: 'b' }] }, execFor(cwd)),
      /does not exist yet/,
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a tool call from a session with no workspace fails loud', async () => {
  const read = docReadTool(DEFAULTS, freshState())
  await assert.rejects(read.execute({}, { agent: { session: { header: {} } } }), /no workspace directory/)
})

test('a document over the configured limit is refused before it is written', async () => {
  const cwd = await workspace()
  try {
    const write = docWriteTool({ fileName: 'PLAN.md', maxBytes: 1024 }, freshState())
    await assert.rejects(write.execute({ content: 'x'.repeat(4096) }, execFor(cwd)), /over the 1024-byte limit/)
    await assert.rejects(readFile(join(cwd, 'PLAN.md'), 'utf8'), /ENOENT/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('an existing hand-written document is edited, not clobbered', async () => {
  const cwd = await workspace()
  try {
    await writeFile(join(cwd, 'PLAN.md'), '# Mine\n\n- [ ] keep this\n', 'utf8')
    const edit = docEditTool(DEFAULTS, freshState())
    const result = await edit.execute({ edits: [{ old_str: '', new_str: '- [ ] and this' }] }, execFor(cwd))
    assert.equal(result.checklist.total, 2)
    assert.match(await readFile(join(cwd, 'PLAN.md'), 'utf8'), /# Mine/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('listDocuments finds markdown one level deep and skips noise', async () => {
  const cwd = await workspace()
  try {
    await writeDocAtomic(join(cwd, 'PLAN.md'), '#\n')
    await writeDocAtomic(join(cwd, 'notes', 'strategy.md'), '#\n')
    await writeDocAtomic(join(cwd, 'node_modules', 'pkg', 'readme.md'), '#\n')
    await writeDocAtomic(join(cwd, '.hidden', 'secret.md'), '#\n')
    await writeFile(join(cwd, 'deck.html'), '<p>', 'utf8')
    assert.deepEqual(await listDocuments(cwd), ['PLAN.md', 'notes/strategy.md'])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('parseRefineInput splits an optional document name from the message', () => {
  assert.deepEqual(parseRefineInput(''), { action: 'on', file: null, message: '' })
  assert.deepEqual(parseRefineInput('  '), { action: 'on', file: null, message: '' })
  assert.deepEqual(parseRefineInput('off'), { action: 'off', file: null, message: '' })
  assert.deepEqual(parseRefineInput('notes/strategy.md'), { action: 'on', file: 'notes/strategy.md', message: '' })
  assert.deepEqual(parseRefineInput('deck.md make it punchier'),
    { action: 'on', file: 'deck.md', message: 'make it punchier' })
  assert.deepEqual(parseRefineInput('make it punchier'),
    { action: 'on', file: null, message: 'make it punchier' })
  // Recognisably a file, and wrong: the command has to say so rather than
  // steer it as a prompt against whatever document was already targeted.
  assert.deepEqual(parseRefineInput('notes.txt'), { action: 'on', file: 'notes.txt', message: '' })
  assert.deepEqual(parseRefineInput('../escape.md'), { action: 'on', file: '../escape.md', message: '' })
})

test('the refine section names the document and forbids implementation', () => {
  const text = refineSection('notes/strategy.md')
  assert.match(text, /notes\/strategy\.md/)
  assert.match(text, /doc_edit/)
  assert.match(text, /Do not edit other files/)
  assert.match(text, /do not use todo_write/i)
})

test('userMessage matches the frozen shape the agent loop expects', () => {
  const message = userMessage('hello')
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.deepEqual(message.source, { kind: 'user' })
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }])
  assert.ok(Object.isFrozen(message) && Object.isFrozen(message.content))
})

test('apply registers three tools and survives a host with no web server', () => {
  const registered = []
  const ctx = {
    tools: { register: (tool) => registered.push(tool.name) },
    inject: () => {},
    logger: { info: () => {} },
  }
  apply(ctx, {})
  assert.equal(name, 'plan-file')
  assert.deepEqual(registered, ['doc_read', 'doc_write', 'doc_edit'])
})

test('the refine prompt is contributed as one variable-backed section', () => {
  const state = freshState()
  state.setFile('live', 'notes/strategy.md')
  state.setRefine('live', true)

  let section = null
  let provider = null
  let disposed = 0
  const scope = {
    systemPrompt: {
      section: (value) => { section = value; return () => { disposed += 1 } },
      variable: (key, fn) => { provider = { key, fn }; return () => { disposed += 1 } },
    },
  }
  const dispose = registerRefinePrompt(scope, state)

  assert.equal(section.name, 'plan-file:refine')
  assert.equal(section.order, 55)
  assert.equal(section.text, '{{' + provider.key + '}}')
  // Off renders the empty string, which drops the section - a session that is
  // not refining must pay no tokens for this.
  assert.equal(provider.fn({ agent: { session: { header: { id: 'other' } } } }), '')
  assert.equal(provider.fn({}), '')
  assert.match(provider.fn({ agent: { session: { header: { id: 'live' } } } }), /notes\/strategy\.md/)

  dispose()
  assert.equal(disposed, 2)
})

test('/refine targets a document, steers a message, and leaves on off', () => {
  const state = freshState()
  const steered = []
  const agent = { session: { header: { id: 'sc', cwd: '/tmp/ws' } }, steer: (m) => steered.push(m) }
  let definition = null
  const dispose = registerRefineCommand(
    { commands: { register: (value) => { definition = value; return () => {} } } },
    state,
    DEFAULTS,
  )
  assert.equal(definition.name, 'refine')
  assert.equal(definition.input.images, false)

  // Bare /refine on a session still pointed at PLAN.md asks for the document
  // rather than quietly editing the plan.
  const bare = definition.handler({ agent, rawInput: '' })
  assert.equal(bare.kind, 'error')
  assert.match(bare.text, /Name the document/)
  assert.equal(state.get('sc').refine, false)

  const targeted = definition.handler({ agent, rawInput: 'notes/strategy.md make it punchier' })
  assert.equal(targeted.kind, 'success')
  assert.deepEqual(state.get('sc'), { file: 'notes/strategy.md', refine: true })
  assert.equal(steered.length, 1)
  assert.equal(steered[0].content[0].text, 'make it punchier')

  // Once a document is targeted, a bare /refine just turns the mode back on.
  state.setRefine('sc', false)
  assert.equal(definition.handler({ agent, rawInput: '' }).kind, 'success')
  assert.equal(state.get('sc').refine, true)

  assert.match(definition.handler({ agent, rawInput: 'nope.txt' }).text, /markdown file/)
  assert.match(definition.handler({ agent, rawInput: '../escape.md' }).text, /outside the workspace/)

  const off = definition.handler({ agent, rawInput: 'off' })
  assert.equal(off.kind, 'success')
  assert.equal(state.get('sc').refine, false)
  // The target survives leaving the mode, so /refine resumes where it left off.
  assert.equal(state.get('sc').file, 'notes/strategy.md')
  dispose()
})

test('a failed steer still reports that refine mode is on', () => {
  const state = freshState()
  state.setFile('sf', 'doc.md')
  let definition = null
  registerRefineCommand({ commands: { register: (v) => { definition = v; return () => {} } } }, state, DEFAULTS)
  const agent = {
    session: { header: { id: 'sf', cwd: '/tmp/ws' } },
    steer: () => { throw new Error('shape drifted') },
  }
  const result = definition.handler({ agent, rawInput: 'tighten the intro' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Refine mode on for doc\.md/)
  assert.match(result.text, /shape drifted/)
  assert.equal(state.get('sf').refine, true)
})
