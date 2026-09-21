// dsh-plan-file, browser half.
//
// Two registrations, one job: keep PLAN.md in front of the user while they talk
// to the model.
//
//   conversation.input.dock - a one-line strip above the composer: the plan's
//     step progress, when it last changed, a show/hide toggle, and a button
//     that drops "GO - implement the plan" into the draft. It is also where the
//     active session id comes from; shell.overlay components get no session.
//   shell.overlay          - the panel itself, docked to the right edge, which
//     polls the host route and renders the markdown. While it is open the app
//     frame is narrowed to match, so the panel sits BESIDE the chat rather than
//     on top of it; if that CSS ever fails to bite, the panel still renders and
//     merely overlaps.
//
// The panel is read-only on purpose. The plan is edited by talking to the
// model, which is the whole point of keeping it in a file the model can patch.
window.__ModuleLoader__.load({
  id: 'dsh-plan-file',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var STYLE_ID = 'dsh-plan-file-styles'
    var OPEN_KEY = 'dsh.planFile.open'
    var WIDTH_KEY = 'dsh.planFile.width'
    var MIN_WIDTH = 280
    var MAX_WIDTH = 760
    var DEFAULT_WIDTH = 420
    var POLL_OPEN_MS = 1200
    var POLL_CLOSED_MS = 6000
    var FLASH_MS = 2600

    var CSS = [
      // Narrow the app frame so the docked panel does not cover the chat. The
      // frame measures itself with a ResizeObserver and recomputes its columns,
      // so shrinking it is enough - no column maths is duplicated here.
      'body[data-dsh-plan-open="true"] div[class*="_frame"]:has(> [data-shell-overlay])',
      '{width:calc(100% - var(--dsh-plan-width, 420px))!important}',
      '.dsh-plan-panel{position:fixed;top:0;right:0;bottom:0;display:flex;flex-direction:column;',
      'background:var(--dsw-alias-bg-layer-1,#161618);border-left:1px solid var(--dsw-alias-border-l2,#2a2a2e);',
      'color:var(--dsw-alias-label-primary,#e8e8ea);font-size:13px;line-height:1.55;z-index:1150}',
      '.dsh-plan-panel[data-dragging="true"]{user-select:none}',
      '.dsh-plan-grip{position:absolute;left:-3px;top:0;bottom:0;width:7px;cursor:col-resize;z-index:1}',
      '.dsh-plan-head{display:flex;align-items:center;gap:8px;padding:9px 12px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,#242427);flex:none}',
      '.dsh-plan-body{overflow:auto;padding:12px 16px 40px;flex:1 1 auto}',
      '.dsh-plan-body h1,.dsh-plan-body h2,.dsh-plan-body h3{margin:16px 0 6px;line-height:1.3}',
      '.dsh-plan-body h1{font-size:17px}.dsh-plan-body h2{font-size:15px}.dsh-plan-body h3{font-size:13.5px}',
      '.dsh-plan-body p{margin:6px 0}',
      '.dsh-plan-body ul,.dsh-plan-body ol{margin:6px 0;padding-left:20px}',
      '.dsh-plan-body li{margin:3px 0}',
      '.dsh-plan-body pre{margin:8px 0;padding:8px 10px;border-radius:8px;overflow:auto;',
      'background:var(--dsw-alias-bg-layer-2,#0f0f11);border:1px solid var(--dsw-alias-border-l1,#242427)}',
      '.dsh-plan-body code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.dsh-plan-body blockquote{margin:8px 0;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2,#2a2a2e);',
      'color:var(--dsw-alias-label-secondary,#a0a0a8)}',
      '.dsh-plan-body hr{border:0;border-top:1px solid var(--dsw-alias-border-l1,#242427);margin:14px 0}',
      '.dsh-plan-task{display:flex;gap:8px;align-items:flex-start;list-style:none;margin-left:-20px}',
      '.dsh-plan-task[data-done="true"]{color:var(--dsw-alias-label-secondary,#a0a0a8)}',
      '.dsh-plan-box{flex:none;width:14px;height:14px;margin-top:3px;border-radius:4px;',
      'border:1px solid var(--dsw-alias-border-l3,#3a3a40);display:grid;place-items:center;font-size:10px}',
      '.dsh-plan-task[data-done="true"] .dsh-plan-box{background:var(--dsw-alias-border-l3,#3a3a40)}',
      '@keyframes dsh-plan-flash{from{background:rgba(88,166,255,.22)}to{background:transparent}}',
      '.dsh-plan-new{animation:dsh-plan-flash ' + FLASH_MS + 'ms ease-out;border-radius:6px}',
      // Match the stock composer dock's own width formula. Without it the strip
      // spans the whole centre column while the composer card is inset, so the
      // right-hand buttons fly out past the card's edge.
      '.dsh-plan-strip{box-sizing:border-box;display:flex;align-items:center;gap:8px;',
      'width:calc(100% - var(--dsh-composer-side-clearance,0px)*2 - var(--dsh-composer-dock-inset,0px)*2);',
      'max-width:calc(var(--dsh-composer-card-max-width,760px) - var(--dsh-composer-dock-inset,0px)*2);',
      'margin:0 auto;padding:3px var(--dsh-composer-dock-inset,0px) 7px;',
      'font-size:12px;color:var(--dsw-alias-label-secondary,#a0a0a8)}',
      '.dsh-plan-tag{border:1px solid var(--dsw-alias-border-l3,#3a3a40);border-radius:6px;padding:0 5px;',
      'font-size:11px;letter-spacing:.02em;opacity:.8}',
      '.dsh-plan-btn{border:1px solid var(--dsw-alias-border-l2,#2a2a2e);border-radius:8px;padding:2px 8px;',
      'background:var(--dsw-alias-button-floating-fill,transparent);color:inherit;cursor:pointer;font-size:12px}',
      '.dsh-plan-btn:hover{color:var(--dsw-alias-label-primary,#e8e8ea)}',
    ].join('')

    // ---------------------------------------------------------------- store

    // shell.overlay components are rendered outside any session scope, so the
    // panel cannot be handed a session id. The composer strip lives inside that
    // scope and publishes it here.
    var sessionStore = {
      value: null,
      listeners: [],
      set: function (id) {
        var next = typeof id === 'string' && id.length > 0 ? id : null
        if (sessionStore.value === next) return
        sessionStore.value = next
        sessionStore.listeners.slice().forEach(function (fn) { fn(next) })
      },
      subscribe: function (fn) {
        sessionStore.listeners.push(fn)
        return function () {
          var at = sessionStore.listeners.indexOf(fn)
          if (at >= 0) sessionStore.listeners.splice(at, 1)
        }
      },
    }

    // The panel owns the fetch; the strip reads the same snapshot rather than
    // polling a second time.
    var planStore = {
      value: null,
      listeners: [],
      set: function (next) {
        planStore.value = next
        planStore.listeners.slice().forEach(function (fn) { fn(next) })
      },
      subscribe: function (fn) {
        planStore.listeners.push(fn)
        return function () {
          var at = planStore.listeners.indexOf(fn)
          if (at >= 0) planStore.listeners.splice(at, 1)
        }
      },
    }

    // Whether stock plan mode is on, read from the `plan` session projection
    // that @deepseek-ai/dsh-plan-mode registers. The strip is inside the
    // session scope and can see it; the panel cannot, so it is republished
    // here. Turning plan mode on opens the panel on an empty plan, which is
    // what makes the feature findable before any file exists.
    var planModeStore = {
      value: false,
      listeners: [],
      set: function (next) {
        var flag = next === true
        if (planModeStore.value === flag) return
        planModeStore.value = flag
        planModeStore.listeners.slice().forEach(function (fn) { fn(flag) })
      },
      subscribe: function (fn) {
        planModeStore.listeners.push(fn)
        return function () {
          var at = planModeStore.listeners.indexOf(fn)
          if (at >= 0) planModeStore.listeners.splice(at, 1)
        }
      },
    }

    var openStore = {
      value: readOpen(),
      listeners: [],
      set: function (next) {
        if (openStore.value === next) return
        openStore.value = next
        try { window.localStorage.setItem(OPEN_KEY, String(next)) } catch (error) { void error }
        openStore.listeners.slice().forEach(function (fn) { fn(next) })
      },
      subscribe: function (fn) {
        openStore.listeners.push(fn)
        return function () {
          var at = openStore.listeners.indexOf(fn)
          if (at >= 0) openStore.listeners.splice(at, 1)
        }
      },
    }

    function readOpen() {
      try { return window.localStorage.getItem(OPEN_KEY) !== 'false' } catch (error) { return true }
    }

    function clampWidth(value) {
      var n = Number(value)
      if (!isFinite(n)) return DEFAULT_WIDTH
      return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(n)))
    }

    function readWidth() {
      try { return clampWidth(window.localStorage.getItem(WIDTH_KEY) || DEFAULT_WIDTH) } catch (error) { return DEFAULT_WIDTH }
    }

    function relativeTime(ms) {
      if (!ms) return ''
      var seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (seconds < 5) return 'just now'
      if (seconds < 60) return seconds + 's ago'
      var minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes + 'm ago'
      return Math.round(minutes / 60) + 'h ago'
    }

    // ------------------------------------------------------------- markdown

    /**
     * Split markdown into the block list the panel renders. Deliberately small:
     * headings, lists (checklists included), fenced code, quotes, rules and
     * paragraphs are what a plan is made of.
     */
    function parseBlocks(text) {
      var lines = String(text || '').split('\n')
      var blocks = []
      var index = 0
      while (index < lines.length) {
        var line = lines[index]
        if (line.trim() === '') { index += 1; continue }
        var fence = /^\s*```(.*)$/.exec(line)
        if (fence) {
          var code = []
          index += 1
          while (index < lines.length && !/^\s*```/.test(lines[index])) { code.push(lines[index]); index += 1 }
          index += 1
          blocks.push({ kind: 'code', text: code.join('\n'), lang: fence[1].trim() })
          continue
        }
        var heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() })
          index += 1
          continue
        }
        if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
          blocks.push({ kind: 'rule', text: '---' })
          index += 1
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          var quote = []
          while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
            quote.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          blocks.push({ kind: 'quote', text: quote.join('\n') })
          continue
        }
        if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
          var items = []
          var ordered = /^\s*\d+[.)]\s+/.test(line)
          while (index < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[index])) {
            var raw = lines[index].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
            var task = /^\[([ xX])\]\s*(.*)$/.exec(raw)
            var indent = /^\s*/.exec(lines[index])[0].length
            items.push(task
              ? { task: true, done: task[1] !== ' ', text: task[2], indent: indent }
              : { task: false, done: false, text: raw, indent: indent })
            index += 1
          }
          blocks.push({ kind: 'list', ordered: ordered, items: items, text: items.map(function (i) { return i.text }).join('\n') })
          continue
        }
        var para = []
        while (index < lines.length && lines[index].trim() !== ''
          && !/^\s*(?:#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s)/.test(lines[index])) {
          para.push(lines[index])
          index += 1
        }
        if (para.length === 0) { index += 1; continue }
        blocks.push({ kind: 'para', text: para.join('\n') })
      }
      return blocks
    }

    /** Inline `code`, **bold** and *italic*. Anything else stays literal. */
    function renderInline(text, keyPrefix) {
      var out = []
      var pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)/g
      var last = 0
      var match
      var n = 0
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) out.push(text.slice(last, match.index))
        var token = match[0]
        n += 1
        if (token.charAt(0) === '`') {
          out.push(React.createElement('code', { key: keyPrefix + ':c' + n }, token.slice(1, -1)))
        } else if (token.slice(0, 2) === '**') {
          out.push(React.createElement('strong', { key: keyPrefix + ':b' + n }, token.slice(2, -2)))
        } else {
          out.push(React.createElement('em', { key: keyPrefix + ':i' + n }, token.slice(1, -1)))
        }
        last = match.index + token.length
      }
      if (last < text.length) out.push(text.slice(last))
      return out
    }

    function renderBlock(block, key, fresh) {
      var className = fresh ? 'dsh-plan-new' : undefined
      if (block.kind === 'heading') {
        var tag = 'h' + Math.min(3, block.level)
        return React.createElement(tag, { key: key, className: className }, renderInline(block.text, key))
      }
      if (block.kind === 'code') {
        return React.createElement('pre', { key: key, className: className },
          React.createElement('code', null, block.text))
      }
      if (block.kind === 'quote') {
        return React.createElement('blockquote', { key: key, className: className }, renderInline(block.text, key))
      }
      if (block.kind === 'rule') {
        return React.createElement('hr', { key: key })
      }
      if (block.kind === 'list') {
        var tagName = block.ordered ? 'ol' : 'ul'
        return React.createElement(tagName, { key: key, className: className },
          block.items.map(function (item, at) {
            var itemKey = key + ':' + at
            if (!item.task) {
              return React.createElement('li', {
                key: itemKey,
                style: item.indent > 1 ? { marginLeft: Math.min(24, item.indent * 6) + 'px' } : undefined,
              }, renderInline(item.text, itemKey))
            }
            return React.createElement('li', {
              key: itemKey,
              className: 'dsh-plan-task',
              'data-done': String(item.done),
              style: item.indent > 1 ? { marginLeft: Math.min(24, item.indent * 6) + 'px' } : undefined,
            },
            React.createElement('span', { className: 'dsh-plan-box', 'aria-hidden': 'true' }, item.done ? '✓' : ''),
            React.createElement('span', null, renderInline(item.text, itemKey)))
          }))
      }
      return React.createElement('p', { key: key, className: className }, renderInline(block.text, key))
    }

    // ------------------------------------------------------------- fetching

    async function fetchPlan(sessionId) {
      var response = await fetch('/plugin/plan-file/state/' + encodeURIComponent(sessionId), {
        headers: { accept: 'application/json' },
      })
      var payload
      try { payload = await response.json() } catch (error) { payload = {} }
      if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status))
      return payload
    }

    async function postMode(sessionId, body) {
      var response = await fetch('/plugin/plan-file/mode/' + encodeURIComponent(sessionId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      var payload
      try { payload = await response.json() } catch (error) { payload = {} }
      if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status))
      return payload
    }

    /**
     * Poll the plan route for whichever session the composer last published.
     * Polling beats a push channel here: the file is the source of truth and a
     * hand edit outside the harness has to show up too.
     */
    function usePlan() {
      var sessionState = React.useState(sessionStore.value)
      var sessionId = sessionState[0]
      var setSessionId = sessionState[1]
      var dataState = React.useState(planStore.value)
      var data = dataState[0]
      var setData = dataState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var openState = React.useState(openStore.value)
      var open = openState[0]
      var setOpen = openState[1]
      var planModeState = React.useState(planModeStore.value)
      var planMode = planModeState[0]
      var setPlanMode = planModeState[1]

      React.useEffect(function () { return sessionStore.subscribe(setSessionId) }, [])
      React.useEffect(function () { return openStore.subscribe(setOpen) }, [])
      React.useEffect(function () { return planModeStore.subscribe(setPlanMode) }, [])

      React.useEffect(function () {
        if (!sessionId) {
          planStore.set(null)
          setData(null)
          return undefined
        }
        var live = true
        var timer = null
        function schedule() {
          if (!live) return
          timer = window.setTimeout(tick, open ? POLL_OPEN_MS : POLL_CLOSED_MS)
        }
        async function tick() {
          try {
            var next = await fetchPlan(sessionId)
            if (!live) return
            setError('')
            planStore.set(next)
            setData(next)
          } catch (cause) {
            if (!live) return
            setError(cause instanceof Error ? cause.message : String(cause))
          }
          schedule()
        }
        tick()
        return function () {
          live = false
          if (timer !== null) window.clearTimeout(timer)
        }
      }, [sessionId, open])

      return { sessionId: sessionId, data: data, error: error, open: open, planMode: planMode }
    }

    // ---------------------------------------------------------------- panel

    function PlanPanel() {
      var state = usePlan()
      var data = state.data
      var widthState = React.useState(readWidth)
      var width = widthState[0]
      var setWidth = widthState[1]
      var draggingState = React.useState(false)
      var dragging = draggingState[0]
      var setDragging = draggingState[1]
      var tickState = React.useState(0)
      var setTick = tickState[1]
      var previousBlocks = React.useRef([])
      var freshUntil = React.useRef(0)

      // Open on either mode as well as on a file: a mode whose panel only
      // appears after the first write leaves nothing to look at during the
      // exploration that precedes it.
      var hasPlan = data !== null && data.exists === true
      var refine = data !== null && data.refine === true
      var visible = state.open && state.sessionId !== null && (hasPlan || state.planMode || refine)

      React.useEffect(function () {
        document.body.dataset.dshPlanOpen = String(visible)
        document.documentElement.style.setProperty('--dsh-plan-width', width + 'px')
        try { window.localStorage.setItem(WIDTH_KEY, String(width)) } catch (error) { void error }
        return function () { delete document.body.dataset.dshPlanOpen }
      }, [visible, width])

      // One slow repaint keeps the "updated 12s ago" line honest without
      // coupling it to the poll.
      React.useEffect(function () {
        var timer = window.setInterval(function () { setTick(function (n) { return n + 1 }) }, 5000)
        return function () { window.clearInterval(timer) }
      }, [])

      var blocks = React.useMemo(function () {
        return parseBlocks(data && data.exists ? data.content : '')
      }, [data && data.content])

      // Blocks whose text was not in the previous render flash once, so an edit
      // the model just made is findable without diffing by eye.
      var freshKeys = React.useMemo(function () {
        var before = previousBlocks.current
        var counts = {}
        before.forEach(function (block) { counts[block.text] = (counts[block.text] || 0) + 1 })
        var fresh = {}
        blocks.forEach(function (block, at) {
          if (counts[block.text] > 0) counts[block.text] -= 1
          else if (before.length > 0) fresh[at] = true
        })
        previousBlocks.current = blocks
        if (Object.keys(fresh).length > 0) freshUntil.current = Date.now() + FLASH_MS
        return fresh
      }, [blocks])

      React.useEffect(function () {
        function move(event) {
          setWidth(clampWidth(window.innerWidth - event.clientX))
        }
        function up() { setDragging(false) }
        if (!dragging) return undefined
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        return function () {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
      }, [dragging])

      if (!visible) return null

      // `data` is null until the first poll answers, and `exists` is false
      // until the model writes. Both are ordinary states of an open panel now
      // that plan mode alone opens it.
      var progress = hasPlan && data.checklist && data.checklist.total > 0
        ? data.checklist.done + '/' + data.checklist.total
        : ''
      var latest = hasPlan && data.recent && data.recent.length > 0 ? data.recent[0] : null
      var stamp = hasPlan ? (latest ? relativeTime(latest.at) : relativeTime(data.mtimeMs)) : ''
      var showFlash = Date.now() < freshUntil.current
      var fileName = (data && data.fileName) || 'PLAN.md'

      return React.createElement('aside', {
        className: 'dsh-plan-panel',
        'data-dragging': String(dragging),
        style: { width: width + 'px' },
        'aria-label': 'Plan file',
      },
      React.createElement('div', {
        className: 'dsh-plan-grip',
        onPointerDown: function (event) { event.preventDefault(); setDragging(true) },
        title: 'Drag to resize',
      }),
      React.createElement('div', { className: 'dsh-plan-head' },
        React.createElement('strong', { style: { fontSize: '12.5px' } }, fileName),
        refine && React.createElement('span', {
          className: 'dsh-plan-tag',
          title: 'Refine mode: this document is the deliverable, nothing gets implemented',
        }, 'refine'),
        progress && React.createElement('span', { style: { opacity: 0.7 } }, progress),
        stamp && React.createElement('span', { style: { opacity: 0.55, marginLeft: 'auto' } }, stamp),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-plan-btn',
          onClick: function () { openStore.set(false) },
          title: 'Hide the plan panel',
          style: progress || stamp ? undefined : { marginLeft: 'auto' },
        }, 'Hide')),
      latest && latest.summary
        ? React.createElement('div', {
          style: {
            padding: '6px 12px', fontSize: '12px', opacity: 0.75, flex: 'none',
            borderBottom: '1px solid var(--dsw-alias-border-l1, #242427)',
          },
        }, latest.summary + ' (+' + latest.added + ' −' + latest.removed + ')')
        : null,
      React.createElement('div', { className: 'dsh-plan-body' },
        hasPlan
          ? blocks.map(function (block, at) {
            return renderBlock(block, 'b' + at, showFlash && freshKeys[at] === true)
          })
          : React.createElement('p', { style: { opacity: 0.6 } },
            data === null
              ? 'Loading…'
              : refine
                ? 'Refine mode is on and ' + fileName + ' does not exist yet. Say what it should cover; '
                  + 'the document appears here as the model drafts it, and every later change is an edit '
                  + 'to this file rather than a fresh copy in the chat.'
                : 'Plan mode is on and there is no ' + fileName + ' yet. Say what you want built; '
                  + 'the plan appears here as the model writes it, and every later change is an edit '
                  + 'to this file rather than a fresh copy in the chat.')),
      state.error
        ? React.createElement('div', {
          style: { padding: '6px 12px', fontSize: '12px', color: '#f35b5b', flex: 'none' },
        }, state.error)
        : null)
    }

    // ---------------------------------------------------------------- strip

    var GO_TEXT = 'GO - implement the plan in PLAN.md.'

    /**
     * Read `plan.active` from the session projection @deepseek-ai/dsh-plan-mode
     * registers. A composition without that projection (the `minimal` preset
     * mounts no plan mode) simply reports off rather than failing the strip.
     */
    function readPlanMode(useProjection) {
      if (typeof useProjection !== 'function') return false
      try {
        var view = useProjection('plan')
        return Boolean(view && view.active)
      } catch (error) {
        return false
      }
    }

    function PlanStrip(props) {
      var state = usePlan()
      var data = state.data
      var planMode = readPlanMode(props && props.useProjection)

      React.useEffect(function () {
        var id = props && props.session && props.session.sessionId
        sessionStore.set(id)
      }, [props && props.session && props.session.sessionId])

      React.useEffect(function () { planModeStore.set(planMode) }, [planMode])

      var hasPlan = data !== null && data.exists === true
      var refine = data !== null && data.refine === true
      if (!hasPlan && !planMode && !refine) return null

      var fileName = (data && data.fileName) || 'PLAN.md'
      var progress = hasPlan
        ? (data.checklist && data.checklist.total > 0
          ? data.checklist.done + '/' + data.checklist.total + ' steps'
          : 'no steps yet')
        : 'not written yet'
      var latest = hasPlan && data.recent && data.recent.length > 0 ? data.recent[0] : null
      var stamp = hasPlan ? (latest ? relativeTime(latest.at) : relativeTime(data.mtimeMs)) : ''
      // GO only means something in plan mode: refine mode has no
      // implementation step to hand off to.
      var canDraft = Boolean(props && props.inputActions && props.inputActions.setDraft)

      return React.createElement('div', { className: 'dsh-plan-strip' },
        React.createElement('span', null, '📋 ' + fileName),
        refine && React.createElement('span', { className: 'dsh-plan-tag' }, 'refine'),
        React.createElement('span', { style: { opacity: 0.75 } }, progress),
        stamp && React.createElement('span', { style: { opacity: 0.55 } }, '· ' + stamp),
        React.createElement('span', { style: { marginLeft: 'auto' } }),
        refine && state.sessionId && React.createElement('button', {
          type: 'button',
          className: 'dsh-plan-btn',
          title: 'Leave refine mode (same as /refine off)',
          onClick: function () {
            postMode(state.sessionId, { refine: false }).catch(function () {})
          },
        }, 'Refine off'),
        canDraft && hasPlan && !refine && React.createElement('button', {
          type: 'button',
          className: 'dsh-plan-btn',
          title: 'Put "' + GO_TEXT + '" in the composer',
          onClick: function () {
            var current = (props.input && props.input.draft) || ''
            props.inputActions.setDraft(current.trim() ? current.trim() + '\n\n' + GO_TEXT : GO_TEXT)
          },
        }, 'GO'),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-plan-btn',
          onClick: function () { openStore.set(!state.open) },
        }, state.open ? 'Hide' : 'Show'))
    }

    // ----------------------------------------------------------------- wire

    function apply(ctx) {
      if (!document.getElementById(STYLE_ID)) {
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.dataset.plugin = 'dsh-plan-file'
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(function () { return function () { style.remove() } }, 'dsh-plan-file: styles')
      }
      ctx.slots.inject('conversation.input.dock', function* () {
        yield ctx.slots.register({ name: 'conversation.input.dock', id: 'plan-file', order: 5 }, PlanStrip)
      })
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({ name: 'shell.overlay', id: 'plan-file-panel', order: 120 }, PlanPanel)
      })
    }

    exports.name = 'plan-file'
    exports.inject = ['slots']
    exports.apply = apply
    exports._internal = {
      parseBlocks: parseBlocks,
      clampWidth: clampWidth,
      relativeTime: relativeTime,
      readPlanMode: readPlanMode,
      postMode: postMode,
      sessionStore: sessionStore,
      planStore: planStore,
      planModeStore: planModeStore,
      openStore: openStore,
      GO_TEXT: GO_TEXT,
    }
    return module.exports
  },
})
