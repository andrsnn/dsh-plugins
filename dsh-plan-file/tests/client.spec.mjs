// The browser half is loaded through DSH's module loader, so the suite stands
// up the smallest loader and `react` that satisfy it and then exercises the
// pure helpers. No DOM and no real React are needed: the markdown parser and
// the stores are where the behavior worth pinning lives.
import assert from 'node:assert/strict'
import test from 'node:test'

const loaded = {}

globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      loaded[id] = factory((specifier) => {
        if (specifier === 'react') {
          return {
            createElement: (type, props, ...children) => ({ type, props, children }),
            useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
            useEffect: () => {},
            useMemo: (fn) => fn(),
            useRef: (initial) => ({ current: initial }),
          }
        }
        throw new Error(`unexpected require: ${specifier}`)
      })
    },
  },
  localStorage: {
    store: new Map(),
    getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
    setItem(key, value) { this.store.set(key, String(value)) },
  },
}
globalThis.document = { getElementById: () => ({}), head: { appendChild: () => {} } }

await import('../dsh/client.js')

const plugin = loaded['dsh-plan-file']
const {
  parseBlocks, clampWidth, relativeTime, readPlanMode,
  sessionStore, openStore, planModeStore, GO_TEXT,
} = plugin._internal

test('the browser half exports the two registrations it needs', () => {
  assert.equal(plugin.name, 'plan-file')
  assert.deepEqual(plugin.inject, ['slots'])
  assert.equal(typeof plugin.apply, 'function')
})

test('parseBlocks reads the shapes a plan is made of', () => {
  const blocks = parseBlocks([
    '# Title',
    '',
    'A paragraph.',
    '',
    '## Steps',
    '- [ ] first',
    '- [x] second',
    '- plain bullet',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '> a note',
    '',
    '---',
  ].join('\n'))

  assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'para', 'heading', 'list', 'code', 'quote', 'rule'])
  assert.equal(blocks[0].level, 1)
  assert.equal(blocks[2].level, 2)
  const list = blocks[3]
  assert.equal(list.items.length, 3)
  assert.deepEqual(list.items.map((i) => i.task), [true, true, false])
  assert.deepEqual(list.items.map((i) => i.done), [false, true, false])
  assert.equal(list.items[0].text, 'first')
  assert.equal(blocks[4].lang, 'js')
  assert.equal(blocks[4].text, 'const a = 1')
  assert.equal(blocks[5].text, 'a note')
})

test('parseBlocks keeps an ordered list ordered and survives empty input', () => {
  const ordered = parseBlocks('1. one\n2. two')
  assert.equal(ordered[0].kind, 'list')
  assert.equal(ordered[0].ordered, true)
  assert.deepEqual(parseBlocks(''), [])
  assert.deepEqual(parseBlocks('   \n\n'), [])
})

test('an unterminated code fence still yields one code block', () => {
  const blocks = parseBlocks('```\nunclosed')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].kind, 'code')
  assert.equal(blocks[0].text, 'unclosed')
})

test('clampWidth holds the panel between its bounds', () => {
  assert.equal(clampWidth(420), 420)
  assert.equal(clampWidth(10), 280)
  assert.equal(clampWidth(5000), 760)
  assert.equal(clampWidth('not a number'), 420)
})

test('relativeTime reads as a recency, not a timestamp', () => {
  assert.equal(relativeTime(0), '')
  assert.equal(relativeTime(Date.now()), 'just now')
  assert.equal(relativeTime(Date.now() - 30_000), '30s ago')
  assert.equal(relativeTime(Date.now() - 300_000), '5m ago')
  assert.equal(relativeTime(Date.now() - 7_200_000), '2h ago')
})

test('the session store notifies only on a real change', () => {
  const seen = []
  const stop = sessionStore.subscribe((id) => seen.push(id))
  sessionStore.set('one')
  sessionStore.set('one')
  sessionStore.set('two')
  sessionStore.set(undefined)
  stop()
  sessionStore.set('three')
  assert.deepEqual(seen, ['one', 'two', null])
})

test('the open store persists the panel preference', () => {
  openStore.set(false)
  assert.equal(window.localStorage.getItem('dsh.planFile.open'), 'false')
  openStore.set(true)
  assert.equal(window.localStorage.getItem('dsh.planFile.open'), 'true')
})

test('the GO shortcut names the file the model is told to follow', () => {
  assert.match(GO_TEXT, /PLAN\.md/)
})

test('readPlanMode reads the plan projection and degrades to off', () => {
  assert.equal(readPlanMode(() => ({ active: true, pending: false })), true)
  assert.equal(readPlanMode(() => ({ active: false })), false)
  assert.equal(readPlanMode(() => undefined), false)
  assert.equal(readPlanMode(undefined), false)
  // A composition with no plan projection (the `minimal` preset) must not
  // take the strip down with it.
  assert.equal(readPlanMode(() => { throw new Error('unknown projection: plan') }), false)
})

test('the plan-mode store notifies only on a real change', () => {
  const seen = []
  const stop = planModeStore.subscribe((on) => seen.push(on))
  planModeStore.set(true)
  planModeStore.set(true)
  planModeStore.set(false)
  stop()
  planModeStore.set(true)
  assert.deepEqual(seen, [true, false])
  planModeStore.set(false)
})
