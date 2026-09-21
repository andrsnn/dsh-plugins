// dsh-compact-layout, browser half.
window.__ModuleLoader__.load({
  id: 'dsh-compact-layout',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var FishLogo = primitives.FishLogo

    var STYLE_ID = 'dsh-compact-layout-styles'
    var FOCUS_KEY = 'dsh.compact.focus'
    var SCALE_KEY = 'dsh.compact.scale'
    var SCALES = [0.8, 0.9, 1, 1.1, 1.2]
    var CSS = [
      'body[data-dsh-focus-layout="true"] div[class*="_frame"]:has(> [data-shell-overlay]){grid-template-columns:0 minmax(0,1fr) 0!important}',
      'body[data-dsh-focus-layout="true"] div[class*="_frame"]:has(> [data-shell-overlay])>div[class*="_sidebarCol"],',
      'body[data-dsh-focus-layout="true"] div[class*="_frame"]:has(> [data-shell-overlay])>div[class*="_detailsCol"],',
      'body[data-dsh-focus-layout="true"] div[class*="_frame"]:has(> [data-shell-overlay])>div[class*="_handle"]{display:none!important}',
      'body[data-dsh-focus-layout="true"] div[class*="_centerCol"]{grid-column:2;min-width:0}',
      'body[data-dsh-compact-scale] div[class*="_centerCol"]{zoom:var(--dsh-compact-scale);width:var(--dsh-compact-inverse);height:var(--dsh-compact-inverse)}',
      'body[data-dsh-compact-scale] textarea{font-size:max(16px,1em)!important}',
      '@media(max-width:700px){body:not([data-dsh-focus-layout="false"]){--dsh-chat-content-width:100%}}',
    ].join('\n')

    function clampScale(value) {
      var n = Number(value)
      return SCALES.indexOf(n) >= 0 ? n : 1
    }

    function readFocus() {
      var saved = window.localStorage.getItem(FOCUS_KEY)
      if (saved === 'true') return true
      if (saved === 'false') return false
      return window.matchMedia('(max-width: 700px)').matches
    }

    function applyPresentation(focus, scale) {
      document.body.dataset.dshFocusLayout = String(focus)
      document.body.dataset.dshCompactScale = String(scale)
      document.documentElement.style.setProperty('--dsh-compact-scale', String(scale))
      document.documentElement.style.setProperty('--dsh-compact-inverse', String(100 / scale) + '%')
    }

    function iconButton(label, title, onClick, extra) {
      return React.createElement('button', Object.assign({
        type: 'button', 'aria-label': title, title: title, onClick: onClick,
        style: {
          minWidth: '32px', height: '32px', padding: '0 7px', border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '10px', color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-button-floating-fill)', cursor: 'pointer', fontSize: '13px',
        },
      }, extra || {}), label)
    }

    function CompactControls() {
      var focusState = React.useState(readFocus)
      var focus = focusState[0]
      var setFocus = focusState[1]
      var scaleState = React.useState(function () { return clampScale(window.localStorage.getItem(SCALE_KEY)) })
      var scale = scaleState[0]
      var setScale = scaleState[1]
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var fullState = React.useState(Boolean(document.fullscreenElement))
      var full = fullState[0]
      var setFull = fullState[1]

      React.useEffect(function () {
        applyPresentation(focus, scale)
        window.localStorage.setItem(FOCUS_KEY, String(focus))
        window.localStorage.setItem(SCALE_KEY, String(scale))
      }, [focus, scale])

      React.useEffect(function () {
        function changed() { setFull(Boolean(document.fullscreenElement)) }
        document.addEventListener('fullscreenchange', changed)
        return function () { document.removeEventListener('fullscreenchange', changed) }
      }, [])

      function step(direction) {
        var index = SCALES.indexOf(scale)
        setScale(SCALES[Math.max(0, Math.min(SCALES.length - 1, index + direction))])
      }

      async function toggleFullscreen() {
        try {
          if (document.fullscreenElement) await document.exitFullscreen()
          else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen()
          else window.scrollTo(0, 1)
        } catch (error) {
          window.scrollTo(0, 1)
        }
      }

      return React.createElement('div', {
        'data-dsh-compact-controls': true,
        style: { position: 'fixed', top: '7px', left: '7px', zIndex: 1200, pointerEvents: 'auto' },
      },
      React.createElement('button', {
        type: 'button', onClick: function () { setOpen(!open) },
        title: 'Display controls', 'aria-label': 'Display controls', 'aria-expanded': open,
        style: {
          width: '34px', height: '34px', display: 'grid', placeItems: 'center', padding: '0',
          border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '11px',
          color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-button-floating-fill)',
          boxShadow: 'var(--dsw-shadow-lv1)', cursor: 'pointer',
        },
      }, FishLogo ? React.createElement(FishLogo, { size: 22 }) : '🐳'),
      open && React.createElement('div', {
        role: 'dialog', 'aria-label': 'Display controls',
        style: {
          position: 'absolute', top: '40px', left: '0', width: '210px', padding: '10px',
          border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '14px',
          color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
          boxShadow: 'var(--dsw-shadow-lv3)', fontSize: '13px',
        },
      },
      React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
        React.createElement('input', { type: 'checkbox', checked: focus, onChange: function (e) { setFocus(e.target.checked) } }),
        'Focus layout (hide side panels)'),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        iconButton('A−', 'Smaller text', function () { step(-1) }, { disabled: scale === SCALES[0] }),
        React.createElement('span', { style: { minWidth: '42px', textAlign: 'center' } }, Math.round(scale * 100) + '%'),
        iconButton('A+', 'Larger text', function () { step(1) }, { disabled: scale === SCALES[SCALES.length - 1] }),
        iconButton(full ? '↙' : '⛶', full ? 'Exit full screen' : 'Full screen', toggleFullscreen)
      )))
    }

    function apply(ctx) {
      if (!document.getElementById(STYLE_ID)) {
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.dataset.plugin = 'dsh-compact-layout'
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(function () { return function () { style.remove() } }, 'dsh-compact-layout: styles')
      }
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({ name: 'shell.overlay', id: 'compact-layout-controls', order: 100 }, CompactControls)
      })
    }

    exports.name = 'compact-layout'
    exports.inject = ['slots']
    exports.apply = apply
    exports._internal = { clampScale: clampScale, applyPresentation: applyPresentation }
    return module.exports
  },
})
