// Client-half tests for dsh-image-inline (node --test).
//
// The browser half is a `window.__ModuleLoader__.load({id, factory})` script
// (zero-build lazy-CJS protocol). Two things are tested here:
//   1. The factory registers the cordis plugin exports and, when apply() is
//      run against a stub slots context, registers the image toolviews.
//   2. The ShowImageCard and ReadImageCard components render their states (running,
//      settled-with-meta, error) to the expected DOM, using react-dom/server
//      static markup so no DOM container is needed.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

// The rendering suite below needs react + react-dom. This repo is
// zero-install by design (no npm registry required for the host suite), so
// they are resolved from the environment instead of devDependencies:
//   - DSH_HARNESS_NODE_MODULES: any directory whose node_modules contains
//     react@18 + react-dom@18 (e.g. a DSH harness checkout), or
//   - this repo's own node_modules (after `npm install` of the
//     devDependencies).
// When no usable react is found the suite reports itself as skipped.
const HARNESS_NODE_MODULES =
  process.env.DSH_HARNESS_NODE_MODULES ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules')
const require = createRequire(import.meta.url)

/** Locate react-dom/server.node.js, tolerating different pnpm store layouts. */
function resolveReactDomServer() {
  const candidates = []
  const direct = join(HARNESS_NODE_MODULES, 'react-dom', 'server.node.js')
  const pnpmDir = join(HARNESS_NODE_MODULES, '.pnpm')
  if (existsSync(direct)) candidates.push(direct)
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith('react-dom@')) {
        candidates.push(join(pnpmDir, entry, 'node_modules', 'react-dom', 'server.node.js'))
      }
    }
  }
  return candidates.find((p) => existsSync(p)) ?? null
}

/** React kit for the rendering suite, or { error } when unavailable. */
const renderKit = (() => {
  try {
    const React = require(join(HARNESS_NODE_MODULES, 'react'))
    const serverPath = resolveReactDomServer()
    if (!serverPath) throw new Error(`react-dom/server not found under ${HARNESS_NODE_MODULES}`)
    const reactDom = require(serverPath)
    return { React, renderToStaticMarkup: reactDom.renderToStaticMarkup }
  } catch (err) {
    return { error: err }
  }
})()

/** Minimal fake require serving the platform modules the bundle requests. */
function makeRequire({ react }) {
  const table = { react }
  return (name) => {
    if (!(name in table)) throw new Error(`client test: unexpected require("${name}")`)
    return table[name]
  }
}

/** Load dsh/client.js through the __ModuleLoader__ protocol and capture the exports. */
function loadClientBundle({ react }) {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'dsh', 'client.js'), 'utf8')
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => { captured = { id, factory } },
    },
  }
  // The bundle references `window` at load time; run it in a sandboxed fn
  // whose ONLY scope is window — deliberately NO require parameter here, so
  // a factory that captures `require` as a free variable fails exactly like
  // it does in the browser (ReferenceError: require is not defined). The
  // loader protocol requires `factory: (require) => ...`.
  const run = new Function('window', `${source}\n//# sourceURL=dsh-image-inline-client.js`)
  run(globalThis.window)
  // Mirror the real loader contract: factory(require) → module exports.
  const exports = captured.factory(makeRequire({ react }))
  return { id: captured.id, exports }
}

describe('dsh/client.js bundle', () => {
  it('loads through the __ModuleLoader__ protocol with the plugin id', () => {
    const { id } = loadClientBundle({ react: {} })
    assert.equal(id, 'dsh-image-inline')
  })

  // Regression guard for the loader-entry incident: the lazy-CJS protocol
  // requires `factory: (require) => ...`. A factory that captures `require`
  // as a free variable passes this suite's older harness (which scoped
  // require at evaluation) but throws `require is not defined` in the
  // browser. The harness now evaluates the bundle with ONLY `window` in
  // scope, so this test fails loudly if the signature regresses.
  it('materializes with the loader-injected require (factory(require) contract)', () => {
    const { exports } = loadClientBundle({ react: {} })
    assert.equal(typeof exports.apply, 'function')
  })

  it('exports the cordis plugin shape', () => {
    const { exports } = loadClientBundle({ react: {} })
    assert.equal(exports.name, 'image-inline')
    assert.deepEqual(exports.inject, ['slots'])
    assert.equal(typeof exports.apply, 'function')
  })

  it('registers keyed show_image and read_image toolviews when the Tool slot mounts', () => {
    const registrations = []
    const seats = []
    const ctx = {
      get: () => undefined,
      slots: {
        inject: (name, fn) => {
          seats.push(name)
          const result = fn()
          if (result && typeof result[Symbol.iterator] === 'function') [...result]
        },
        register: (def, Component) => {
          registrations.push({ def, Component })
          return () => {}
        },
      },
      effect: (fn, label) => { /* locale registration is optional; disposer unused */ },
    }
    const { exports } = loadClientBundle({ react: {} })
    exports.apply(ctx)
    assert.deepEqual(seats, ['tool.call.toolview'])
    assert.equal(registrations.length, 2)
    assert.equal(registrations[0].def.name, 'tool.call.toolview')
    assert.equal(registrations[0].def.key, 'show_image')
    assert.equal(registrations[0].def.locale, 'image-inline')
    assert.equal(typeof registrations[0].Component, 'function')
    assert.equal(registrations[1].def.name, 'tool.call.toolview')
    assert.equal(registrations[1].def.key, 'read_image')
    assert.equal(registrations[1].def.locale, 'image-inline')
    assert.equal(registrations[1].def.priority, undefined)
    assert.equal(typeof registrations[1].Component, 'function')
  })
})

describe('ShowImageCard rendering', () => {
  if (renderKit.error) {
    it('skips the rendering suite (react/react-dom not resolvable)', (t) => {
      t.skip(renderKit.error.message)
    })
    return
  }
  const { React, renderToStaticMarkup } = renderKit
  let ShowImageCard

  before(() => {
    const { exports } = loadClientBundle({ react: React })
    // Capture the component registered by apply() through the slots contract:
    // inject defers to register, which records the (definition, Component).
    let capturedComponent
    const ctx = {
      get: () => undefined,
      slots: {
        inject: (name, fn) => {
          const result = fn()
          if (result && typeof result[Symbol.iterator] === 'function') [...result]
        },
        register: (def, Component) => {
          if (def.name === 'tool.call.toolview' && def.key === 'show_image') capturedComponent = Component
          return () => {}
        },
      },
      effect: () => {},
    }
    exports.apply(ctx)
    assert.ok(capturedComponent, 'apply must register the toolview component')
    ShowImageCard = capturedComponent
  })

  it('renders a running call as a compact summary row', () => {
    const block = { callId: 'c1', name: 'show_image', argsRaw: '{"path":"/ws/a.png"}', turn: 1, step: 2, time: 1, callView: null, subCalls: [] }
    const html = renderToStaticMarkup(React.createElement(ShowImageCard, {
      callId: 'c1', toolName: 'show_image', block,
      t: (key) => key,
    }))
    assert.match(html, /data-image-inline-card="running"/)
    assert.match(html, /title\.running/)
  })

  it('renders a settled result with meta as a click-to-load preview', () => {
    const block = {
      kind: 'tool-result',
      seq: 10, time: 2, callId: 'c1',
      call: { name: 'show_image', argsRaw: '{"path":"/ws/a.png"}' },
      callTime: 1,
      content: [{ type: 'text', text: '<path>/ws/a.png</path>' }],
      isError: false,
      meta: {
        path: '/ws/a.png',
        attachmentId: 'sha256:' + 'd'.repeat(64),
        mediaType: 'image/png', bytes: 123, width: 800, height: 600,
      },
      callView: null, resultView: null, subCalls: [],
    }
    const html = renderToStaticMarkup(React.createElement(ShowImageCard, {
      callId: 'c1', toolName: 'show_image', block,
      t: (key, params) => key + (params ? JSON.stringify(params) : ''),
    }))
    assert.match(html, /data-image-inline-card="done"/)
    assert.match(html, /data-image-inline-load="true"/)
    assert.match(html, /label\.loadPreview/)
    assert.doesNotMatch(html, /<img/)
  })

  it('renders an error result without crashing', () => {
    const block = {
      kind: 'tool-result',
      seq: 10, time: 2, callId: 'c1',
      call: { name: 'show_image', argsRaw: '{"path":"/ws/missing.png"}' },
      callTime: 1,
      content: [{ type: 'text', text: 'cannot show "/ws/missing.png": not found' }],
      isError: true,
      callView: null, resultView: null, subCalls: [],
    }
    const html = renderToStaticMarkup(React.createElement(ShowImageCard, {
      callId: 'c1', toolName: 'show_image', block,
      t: (key, params) => key,
    }))
    assert.match(html, /data-image-inline-card="error"/)
    assert.match(html, /summary\.error/)
  })

  it('renders a settled result without meta as a click-to-load path preview', () => {
    const block = {
      kind: 'tool-result',
      seq: 10, time: 2, callId: 'c1',
      call: { name: 'show_image', argsRaw: '{"path":"/ws/a.png"}' },
      callTime: 1,
      content: [{ type: 'text', text: '<path>/ws/a.png</path>\n<type>image</type>\n<content>\nimage/png image, 2x2 px, 4 bytes\n</content>' }],
      isError: false,
      callView: null, resultView: null, subCalls: [],
    }
    const html = renderToStaticMarkup(React.createElement(ShowImageCard, {
      callId: 'c1', toolName: 'show_image', block,
      t: (key) => key,
    }))
    assert.match(html, /data-image-inline-card="done-path"/)
    assert.match(html, /data-image-inline-load="true"/)
    assert.match(html, /label\.loadPreview/)
    assert.doesNotMatch(html, /<img/)
  })

  it('renders a settled result without meta and without a path as a text fallback', () => {
    const block = {
      kind: 'tool-result',
      seq: 10, time: 2, callId: 'c1',
      call: { name: 'show_image', argsRaw: '{"path":"/ws/a.png"}' },
      callTime: 1,
      content: [{ type: 'text', text: 'no path here' }],
      isError: false,
      callView: null, resultView: null, subCalls: [],
    }
    const html = renderToStaticMarkup(React.createElement(ShowImageCard, {
      callId: 'c1', toolName: 'show_image', block,
      t: (key) => key,
    }))
    assert.match(html, /data-image-inline-card="meta-missing"/)
    assert.match(html, /meta\.missing/)
    assert.match(html, /no path here/)
  })
})

describe('ReadImageCard rendering', () => {
  if (renderKit.error) {
    it('skips the rendering suite (react/react-dom not resolvable)', (t) => {
      t.skip(renderKit.error.message)
    })
    return
  }
  const { React, renderToStaticMarkup } = renderKit
  let ReadImageCard

  before(() => {
    const { exports } = loadClientBundle({ react: React })
    let capturedComponent
    const ctx = {
      get: () => undefined,
      slots: {
        inject: (name, fn) => {
          const result = fn()
          if (result && typeof result[Symbol.iterator] === 'function') [...result]
        },
        register: (def, Component) => {
          if (def.name === 'tool.call.toolview' && def.key === 'read_image') capturedComponent = Component
          return () => {}
        },
      },
      effect: () => {},
    }
    exports.apply(ctx)
    assert.ok(capturedComponent, 'apply must register the read_image component')
    ReadImageCard = capturedComponent
  })

  /** A settled read_image node shaped like the real ToolResultNode. */
  function readImageBlock({ file_path, text, extra = {}, cwd = undefined } = {}) {
    return {
      props: {
        block: {
          kind: 'tool-result',
          seq: 10, time: 2, callId: 'c1',
          call: { name: 'read_image', argsRaw: file_path === undefined ? undefined : JSON.stringify({ file_path }) },
          callTime: 1,
          content: [{ type: 'text', text }].concat(extra.content ?? []),
          isError: false,
          callView: null, resultView: null, subCalls: [],
        },
        cwd,
        t: (key, params) => key,
      },
      block: extra.block ?? null,
    }
  }

  it('renders a settled read_image as a click-to-load preview row', () => {
    const { props } = readImageBlock({
      file_path: 'C:/ws/game/view.png',
      text: '<path>C:/ws/game/view.png</path>\n<type>image</type>\n<content>\nimage/png image, 1280x720 px, 1341163 bytes\n</content>',
    })
    const html = renderToStaticMarkup(React.createElement(ReadImageCard, props))
    assert.match(html, /data-image-inline-read-card="body"/)
    assert.match(html, /Tool call · read_image · view\.png/)
    assert.match(html, /details\.loadPreview/)
    assert.doesNotMatch(html, /<img/)
  })

  it('finds a fallback <path> without eagerly loading it', () => {
    const { props } = readImageBlock({
      file_path: undefined,
      text: '<path>/ws/game/view.png</path>',
    })
    const html = renderToStaticMarkup(React.createElement(ReadImageCard, props))
    assert.match(html, /Tool call · read_image · view\.png/)
    assert.match(html, /details\.loadPreview/)
    assert.doesNotMatch(html, /<img/)
  })

  it('resolves a relative arg path without eagerly loading it', () => {
    const { props } = readImageBlock({
      file_path: 'game/view.png',
      text: '<path>C:\\ws\\game\\view.png</path>',
      cwd: 'C:\\ws',
    })
    const html = renderToStaticMarkup(React.createElement(ReadImageCard, props))
    assert.match(html, /Tool call · read_image · view\.png/)
    assert.match(html, /details\.loadPreview/)
    assert.doesNotMatch(html, /<img/)
  })

  it('renders text only when a relative path cannot be resolved (no cwd)', () => {
    const { props } = readImageBlock({
      file_path: 'game/view.png',
      text: 'relative without cwd',
    })
    const html = renderToStaticMarkup(React.createElement(ReadImageCard, props))
    assert.doesNotMatch(html, /<img/)
    assert.match(html, /relative without cwd/)
  })

  it('shows the error text without a picture for a failed read_image', () => {
    const props = {
      block: {
        kind: 'tool-result',
        seq: 10, time: 2, callId: 'c3',
        call: { name: 'read_image', argsRaw: '{"file_path":"/ws/missing.png"}' },
        callTime: 1,
        content: [{ type: 'text', text: 'cannot read "/ws/missing.png": not found' }],
        isError: true,
        callView: null, resultView: null, subCalls: [],
      },
      t: (key) => key,
    }
    const html = renderToStaticMarkup(React.createElement(ReadImageCard, props))
    assert.doesNotMatch(html, /<img/)
    assert.match(html, /data-error/)
    assert.match(html, /cannot read/)
  })

  it('renders an error name:code when content is empty', () => {
    const props = {
      block: {
        kind: 'tool-result',
        seq: 10, time: 2, callId: 'c4',
        call: { name: 'read_image', argsRaw: '{"file_path":"/ws/x.png"}' },
        callTime: 1,
        content: [],
        isError: true,
        error: { name: 'ReadImage', code: 'not-found' },
        callView: null, resultView: null, subCalls: [],
      },
      t: (key) => key,
    }
    const html = renderToStaticMarkup(React.createElement(ReadImageCard, props))
    assert.match(html, /ReadImage: not-found/)
  })

  it('shows the running state for an in-flight call (no kind)', () => {
    const props = {
      block: { callId: 'c6', name: 'read_image', argsRaw: '', turn: 1, step: 2, time: 1, callView: null, subCalls: [] },
      t: (key) => key,
    }
    const html = renderToStaticMarkup(React.createElement(ReadImageCard, props))
    assert.match(html, /data-image-inline-read-card="running"/)
    assert.match(html, /Tool call · read_image/)
    assert.doesNotMatch(html, /<img/)
  })
})
