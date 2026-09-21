// dsh-image-inline, browser half.
//
// Renders the `show_image` tool call inside the chat flow as an inline image
// card (QQ/WeChat style: the picture sits in the conversation, scrolls with
// history, and survives replays). The card is registered as an atomic Tool
// view — the `tool.call.toolview` keyed slot, dispatched by the wire tool
// name — so the generic Tool call tree renders OUR row for every show_image
// call, at the call's own position in the turn.
//
// The card is a pure function of the call node: while running it shows a
// compact summary row; once settled it reads the tool's private `meta`
// payload (attachmentId/mediaType/bytes/width/height — threaded from the
// host's `output.presentationMeta` through the tool/result event, never part
// of model context) and renders the image through the official MessageImage
// atom. Loading uses the plugin's own content-addressed HTTP route, so no
// session-log attachment reference is required (the built-in resolveImage
// path cannot serve tool-produced attachments whose result is text-only).
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), modlens-style: no build
// step, no imports from dsh client packages beyond the platform modules the
// loader seeds (react, ui-attachment, ui-primitives).

window.__ModuleLoader__.load({
  id: 'dsh-image-inline',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')

    /**
     * NOTE: we deliberately do NOT import MessageImage from
     * 'dsh-client-ui-attachment': since the 0.1.1-rc web split that module's
     * browser bundle only exports the cordis plugin face (apply/inject) —
     * MessageImage et al. are internal and NOT on module.exports anymore, so
     * `attachment.MessageImage` is `undefined` and React.createElement(undefined)
     * throws #130 ("Element type is invalid"), which the slot error boundary
     * turns into an empty data-slot-error placeholder. Render plain <img> here
     * instead (self-contained, same card chrome).
     */

    /** Namespace this plugin owns in the DSH locale registry. */
    var NS = 'image-inline'

    /** Simplified Chinese dictionary (the key-set source of truth). */
    var zh = {
      'title.running': '显示图片 {path}',
      'title.done': '图片已显示',
      'summary.done': '{path} · {width}x{height}px · {bytes} bytes',
      'summary.donePlain': '{path}',
      'summary.error': '图片显示失败：{error}',
      'meta.missing': '缺少图片信息（attachmentId 不可用）',
      'label.image': '图片',
      'label.open': '查看原图',
      'label.openNamed': '查看原图 {name}',
      'label.loading': '加载中…',
      'label.loadPreview': '加载图片预览',
      'label.hidePreview': '隐藏图片预览',
      'label.loadFailed': '加载失败，点击重试',
      'lightbox.dialog': '原图预览',
      'lightbox.close': '关闭预览',
      'aria.card': '显示图片：{path}',
      'details.running': '运行中…',
      'details.loadFailed': '图片加载失败（文件不存在、格式不支持或超出大小上限）',
      'details.loadPreview': '加载预览',
      'details.hidePreview': '隐藏预览',
      'details.image': '图片',
    }

    /** The image-inline namespace key union. */
    var zhKeys = Object.keys(zh)

    /** English dictionary, checked complete against the zh key set. */
    var en = {
      'title.running': 'Show image {path}',
      'title.done': 'Image shown',
      'summary.done': '{path} · {width}x{height}px · {bytes} bytes',
      'summary.donePlain': '{path}',
      'summary.error': 'Failed to show image: {error}',
      'meta.missing': 'Image metadata missing (attachmentId unavailable)',
      'label.image': 'Image',
      'label.open': 'View original',
      'label.openNamed': 'View original {name}',
      'label.loading': 'Loading…',
      'label.loadPreview': 'Load image preview',
      'label.hidePreview': 'Hide image preview',
      'label.loadFailed': 'Load failed, click to retry',
      'lightbox.dialog': 'Original preview',
      'lightbox.close': 'Close preview',
      'aria.card': 'Show image: {path}',
      'details.running': 'Running…',
      'details.loadFailed': 'Image failed to load (file missing, unsupported format, or over the size cap)',
      'details.loadPreview': 'Load preview',
      'details.hidePreview': 'Hide preview',
      'details.image': 'Image',
    }

    /** Parse the raw JSON arguments of a running call; best-effort, never throws. */
    function parseArgs(argsRaw) {
      if (typeof argsRaw !== 'string') return {}
      try {
        var parsed = JSON.parse(argsRaw)
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch (error) {
        return {}
      }
    }

    /** The plugin's content-addressed image URL for one attachment id. */
    function imageUrl(attachmentId) {
      return '/plugin/show-image/' + encodeURIComponent(String(attachmentId))
    }

    /** The plugin's path-addressed image URL for one display path. */
    function pathImageUrl(path) {
      return '/plugin/show-image-by-path?path=' + encodeURIComponent(path)
    }

    /**
     * Extract the first `<path>…</path>` value from settled text blocks, or ''
     * when none is present. Results without attachment meta (nested
     * code-dispatched calls, pre-meta replays) still carry the path in the
     * text the model produced, which is enough to render through the plugin's
     * path-addressed route.
     */
    function pathFromBlocks(blocks) {
      if (!Array.isArray(blocks)) return ''
      for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i]
        if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
        var match = /<path>([^<]+)<\/path>/.exec(block.text)
        if (match && typeof match[1] === 'string' && match[1].trim() !== '') return match[1].trim()
      }
      return ''
    }

    /** Join the text blocks of a settled result, best-effort. */
    function textOfBlocks(blocks) {
      var out = ''
      if (!Array.isArray(blocks)) return out
      for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i]
        if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
      }
      return out
    }

    /** The inline image card for one show_image call. */

    /** Shared inline <img> card body (content-addressed or path-addressed URL). */
    function imageLink(url, alt, onError) {
      return React.createElement(
        'a',
        {
          href: url,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: alt,
          'aria-label': alt,
          style: { display: 'block', width: 'fit-content' },
        },
        React.createElement('img', {
          src: url,
          alt: alt,
          onError: onError,
          style: {
            maxWidth: '240px',
            maxHeight: '240px',
            borderRadius: '8px',
            display: 'block',
          },
        }),
      )
    }

    /** The inline image card for one show_image call. */
    function ShowImageCard(props) {
      if (!props || typeof props !== 'object') return null
      var block = props.block
      // The locale seat is normally injected; fall back to an identity
      // translator so a missing seat degrades to raw keys instead of a crash.
      var t = typeof props.t === 'function' ? props.t : function (key) { return key }
      if (!block || typeof block !== 'object') return null
      // Path-fallback load state: when the path-addressed image fails to
      // load we degrade to the plain text result instead of a broken img.
      var pathFailedState = React.useState(false)
      var pathFailed = pathFailedState[0]
      var setPathFailed = pathFailedState[1]
      // Keep the preview URL in browser-local component state. Merely rendering
      // chat history must never request or decode an image; the URL is attached
      // to an <img> only after the person explicitly clicks Load preview.
      var previewUrlState = React.useState('')
      var previewUrl = previewUrlState[0]
      var setPreviewUrl = previewUrlState[1]
      if ('kind' in block) {
        // Settled result.
        if (block.isError === true) {
          var errorText = ''
          var content = block.content || []
          for (var i = 0; i < content.length; i++) {
            if (content[i] && content[i].type === 'text') errorText += content[i].text
          }
          return React.createElement(
            'div',
            { 'data-image-inline-card': 'error', role: 'status' },
            React.createElement(
              'span',
              { className: 'dsh-image-inline-error' },
              t('summary.error', { error: errorText || 'unknown' }),
            ),
          )
        }
        var meta = block.meta
        if (
          meta && typeof meta === 'object'
          && typeof meta.attachmentId === 'string'
          && typeof meta.mediaType === 'string'
          && typeof meta.width === 'number'
          && typeof meta.height === 'number'
          && typeof meta.bytes === 'number'
        ) {
          var ref = {
            attachmentId: meta.attachmentId,
            mediaType: meta.mediaType,
            bytes: meta.bytes,
            width: meta.width,
            height: meta.height,
          }
          var path = typeof meta.path === 'string' ? meta.path : ''
          var row = React.createElement(
            'span',
            { 'data-image-inline-summary': true, title: path },
            t('summary.done', {
              path: path,
              width: meta.width,
              height: meta.height,
              bytes: meta.bytes,
            }),
          )
          var imgUrl = imageUrl(ref.attachmentId)
          var previewVisible = previewUrl === imgUrl
          var previewButton = React.createElement(
            'button',
            {
              type: 'button',
              'data-image-inline-load': true,
              'aria-expanded': previewVisible && !pathFailed,
              onClick: function () {
                if (pathFailed) {
                  setPathFailed(false)
                  setPreviewUrl(imgUrl)
                } else {
                  setPreviewUrl(previewVisible ? '' : imgUrl)
                }
              },
              style: { display: 'block', margin: '4px 0', fontSize: '12px', cursor: 'pointer' },
            },
            pathFailed ? t('label.loadFailed') : t(previewVisible ? 'label.hidePreview' : 'label.loadPreview'),
          )
          return React.createElement(
            'div',
            { 'data-image-inline-card': 'done' },
            row,
            previewButton,
            previewVisible && !pathFailed ? imageLink(imgUrl, t('label.image'), function () { setPathFailed(true) }) : null,
            previewVisible && !pathFailed ? React.createElement(
              'a',
              {
                href: imgUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
                style: { display: 'inline-block', margin: '2px 0 0', fontSize: '12px' },
              },
              t('label.open'),
            ) : null,
          )
        }
        // Settled but no usable meta: this happens when the call ran as a
        // nested dispatch inside run_code (the host registry only projects
        // presentationMeta for top-level executions) or when the log predates
        // the meta schema. The text still carries the <path>, so render the
        // image through the plugin's path-addressed route instead of giving
        // up; if that fails (file gone / wrong type), fall back to the plain
        // text result.
        var fallback = textOfBlocks(block.content)
        var fallbackPath = pathFromBlocks(block.content)
        if (fallbackPath !== '') {
          var fallbackUrl = pathImageUrl(fallbackPath)
          var fallbackVisible = previewUrl === fallbackUrl
          return React.createElement(
            'div',
            { 'data-image-inline-card': 'done-path' },
            React.createElement(
              'span',
              { 'data-image-inline-summary': true, title: fallbackPath },
              t('summary.donePlain', { path: fallbackPath }),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                'data-image-inline-load': true,
                'aria-expanded': fallbackVisible && !pathFailed,
                onClick: function () {
                  if (pathFailed) {
                    setPathFailed(false)
                    setPreviewUrl(fallbackUrl)
                  } else {
                    setPreviewUrl(fallbackVisible ? '' : fallbackUrl)
                  }
                },
                style: { display: 'block', margin: '4px 0', fontSize: '12px', cursor: 'pointer' },
              },
              pathFailed ? t('label.loadFailed') : t(fallbackVisible ? 'label.hidePreview' : 'label.loadPreview'),
            ),
            fallbackVisible && !pathFailed ? imageLink(fallbackUrl, t('label.image'), function () { setPathFailed(true) }) : null,
          )
        }
        return React.createElement(
          'div',
          { 'data-image-inline-card': 'meta-missing' },
          React.createElement('span', null, t('meta.missing')),
          fallback ? React.createElement('pre', null, fallback) : null,
        )
      }
      // Running call.
      var args = parseArgs(block.argsRaw)
      var runningPath = typeof args.path === 'string' ? args.path : ''
      return React.createElement(
        'div',
        { 'data-image-inline-card': 'running' },
        React.createElement('span', null, t('title.running', { path: runningPath || '…' })),
      )
    }

    /**
     * The picture source for one read_image / show_image settled result, or null
     * when none is available. show_image prefers its content-addressed attachment
     * (durable even if the file later moves); read_image (and any meta-less
     * show_image) resolves the display path from the call args or the `<path>`
     * text and serves it through the plugin's path-addressed route. A relative
     * path resolves against the session cwd.
     */
    function detailsImageSource(block, cwd) {
      var toolName = block.call && typeof block.call.name === 'string' ? block.call.name : ''
      if (toolName !== 'read_image' && toolName !== 'show_image') return null
      if (
        toolName === 'show_image'
        && block.meta && typeof block.meta === 'object'
        && typeof block.meta.attachmentId === 'string'
        && /^sha256:[0-9a-f]{64}$/.test(block.meta.attachmentId)
      ) {
        return { url: imageUrl(block.meta.attachmentId), alt: 'show_image result' }
      }
      var path = ''
      if (toolName === 'read_image' && block.call && typeof block.call.argsRaw === 'string') {
        var args = parseArgs(block.call.argsRaw)
        if (typeof args.file_path === 'string' && args.file_path.trim() !== '') path = args.file_path.trim()
      }
      if (path === '') path = pathFromBlocks(block.content)
      if (path === '') return null
      var absolute = /^[a-zA-Z]:[\\/]/.test(path) || path.charAt(0) === '/' || path.charAt(0) === '\\'
      if (!absolute) {
        // The path route requires an absolute path; without a session cwd a
        // relative path cannot be resolved, so render text only. Joiners and
        // separators are normalized to the cwd's style.
        if (typeof cwd !== 'string' || cwd === '') return null
        var sep = cwd.indexOf('\\') !== -1 && cwd.indexOf('/') === -1 ? '\\' : '/'
        path = cwd.replace(/[\\/]+$/, '') + sep + path.replace(/^[\\/]+/, '').split(/[\\/]+/).join(sep)
      }
      return { url: pathImageUrl(path), alt: path }
    }

    /**
     * The keyed chat card for the built-in read_image tool. DSH owns the global
     * details panel as a single slot, so replacing it makes an unrelated tool
     * failure abdicate this plugin for the whole page. The keyed Tool slot is the
     * supported extension seam: only read_image is replaced, while Inspect still
     * opens DSH's stock raw details panel.
     */
    function ReadImageCard(props) {
      if (!props || typeof props !== 'object') return null
      var t = typeof props.t === 'function' ? props.t : function (key) { return key }
      var block = props.block
      // Hook before any early return: the URL whose <img> failed to load (reset
      // when the selected call changes, since a different src is a different image).
      var failedState = React.useState('')
      var failedUrl = failedState[0]
      var setFailedUrl = failedState[1]
      var previewState = React.useState('')
      var previewUrl = previewState[0]
      var setPreviewUrl = previewState[1]
      if (!block || typeof block !== 'object') return null
      if (!('kind' in block)) {
        var runningArgs = parseArgs(block.argsRaw)
        var runningPath = typeof runningArgs.file_path === 'string' ? runningArgs.file_path : ''
        return React.createElement(
          'div',
          { 'data-image-inline-read-card': 'running', style: { fontSize: '13px', opacity: '0.65', padding: '4px 0' } },
          'Tool call · read_image' + (runningPath ? ' · ' + runningPath : ''),
        )
      }
      var isError = block.isError === true
      var raw = ''
      var content = Array.isArray(block.content) ? block.content : []
      for (var i = 0; i < content.length; i++) {
        var item = content[i]
        raw += (i > 0 ? '\n' : '') + (item && item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
      }
      if (content.length === 0 && block.error !== undefined) raw = block.error.name + ': ' + block.error.code
      var source = isError ? null : detailsImageSource(block, props.cwd)
      var displayPath = source ? source.alt : ''
      var fileName = displayPath.split(/[\\/]/).pop() || displayPath
      var previewVisible = source && previewUrl === source.url
      var children = []
      children.push(React.createElement(
        'button',
        {
          key: 'row',
          type: 'button',
          onClick: source ? function () {
            if (failedUrl === source.url) {
              setFailedUrl('')
              setPreviewUrl(source.url)
            } else {
              setPreviewUrl(previewVisible ? '' : source.url)
            }
          } : (typeof props.inspect === 'function' ? props.inspect : undefined),
          'aria-expanded': source ? previewVisible && failedUrl !== source.url : undefined,
          style: {
            appearance: 'none',
            border: '0',
            background: 'transparent',
            color: 'inherit',
            cursor: source || typeof props.inspect === 'function' ? 'pointer' : 'default',
            display: 'block',
            font: 'inherit',
            opacity: '0.78',
            padding: '2px 0 6px',
            textAlign: 'left',
            width: '100%',
          },
        },
        'Tool call · read_image' + (fileName ? ' · ' + fileName : '')
          + (source ? ' · ' + t(previewVisible ? 'details.hidePreview' : 'details.loadPreview') : ''),
      ))
      if (source && previewVisible && failedUrl !== source.url) {
        children.push(React.createElement(
          'a',
          {
            key: 'img',
            href: source.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            title: source.alt,
            style: { display: 'block', margin: '0 0 8px' },
          },
          React.createElement('img', {
            src: source.url,
            alt: t('details.image'),
            onError: function () { setFailedUrl(source.url) },
            style: {
              maxWidth: '100%',
              maxHeight: '480px',
              borderRadius: '8px',
              display: 'block',
              objectFit: 'contain',
            },
          }),
        ))
      }
      if (source && previewVisible && failedUrl === source.url) {
        children.push(React.createElement(
          'div',
          { key: 'load-failed', 'data-image-inline-read-card': 'load-failed', style: { fontSize: '12px', opacity: '0.65', marginBottom: '6px' } },
          t('details.loadFailed'),
        ))
      }
      if (isError || !source) {
        children.push(React.createElement(
          'pre',
          {
            key: 'raw',
            'data-error': isError || undefined,
            style: {
              margin: '0',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: '12px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              color: isError ? '#f87171' : undefined,
            },
          },
          raw,
        ))
      }
      return React.createElement('div', { 'data-image-inline-read-card': 'body' }, children)
    }

    /**
     * Cordis client plugin body.
     * @param ctx - client root context (slots service injected).
     */
    function apply(ctx) {
      var locale = ctx.get ? ctx.get('locale') : undefined
      if (locale && typeof locale.register === 'function') {
        ctx.effect(function () { return locale.register(NS, { zh: zh, en: en }) }, 'dsh-image-inline: dictionaries')
      }

      ctx.slots.inject('tool.call.toolview', function* () {
        yield ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'show_image',
          locale: NS,
        }, ShowImageCard)
        yield ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'read_image',
          locale: NS,
        }, ReadImageCard)
      })
    }

    exports.name = 'image-inline'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
