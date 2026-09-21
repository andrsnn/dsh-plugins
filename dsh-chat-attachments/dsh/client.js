// dsh-chat-attachments, browser half. Adds one paperclip to the composer.
window.__ModuleLoader__.load({
  id: 'dsh-chat-attachments',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    var MAX_FILES = 8

    function fileDescription(result) {
      return 'Attached file: `' + result.path + '` (' + result.mediaType + ', ' + result.bytes + ' bytes)'
    }

    async function uploadGeneralFile(file, sessionId) {
      var response = await fetch('/plugin/chat-attachments/upload/' + encodeURIComponent(sessionId), {
        method: 'POST',
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-dsh-file-name': encodeURIComponent(file.name || 'attachment'),
        },
        body: file,
      })
      var payload
      try { payload = await response.json() } catch (error) { payload = {} }
      if (!response.ok) throw new Error(payload.error || ('upload failed: HTTP ' + response.status))
      return payload
    }

    function Paperclip(props) {
      var inputRef = React.useRef(null)
      var statusState = React.useState('idle')
      var status = statusState[0]
      var setStatus = statusState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var conversation = props._conversation
      var locked = !props.inputActions || props.input.phase !== 'plain' || status === 'uploading'

      async function selected(event) {
        var files = Array.from(event.target.files || []).slice(0, MAX_FILES)
        event.target.value = ''
        if (files.length === 0) return
        setStatus('uploading')
        setError('')
        try {
          var images = files.filter(function (file) { return IMAGE_TYPES.has(file.type) })
          var general = files.filter(function (file) { return !IMAGE_TYPES.has(file.type) })
          if (images.length > 0) {
            var drafts = conversation.createDraftImages(images)
            if (!props.inputActions.addImages(drafts.map(function (image) { return image.id }))) {
              conversation.releaseDraftImages(drafts)
              throw new Error('composer is busy; images were not attached')
            }
          }
          if (general.length > 0) {
            var uploaded = []
            for (var i = 0; i < general.length; i++) {
              uploaded.push(await uploadGeneralFile(general[i], props.session.sessionId))
            }
            var suffix = uploaded.map(fileDescription).join('\n')
            var current = props.input.draft || ''
            props.inputActions.setDraft(current + (current.trim() ? '\n\n' : '') + suffix)
          }
          setStatus('done')
          window.setTimeout(function () { setStatus('idle') }, 1400)
        } catch (cause) {
          setStatus('idle')
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }

      return React.createElement(
        React.Fragment,
        null,
        React.createElement('input', {
          ref: inputRef,
          type: 'file',
          multiple: true,
          onChange: selected,
          style: { display: 'none' },
          'data-dsh-attachment-picker': true,
        }),
        React.createElement('button', {
          type: 'button',
          disabled: locked,
          onClick: function () { inputRef.current && inputRef.current.click() },
          title: error || (status === 'uploading' ? 'Uploading attachments…' : 'Attach images or files'),
          'aria-label': 'Attach images or files',
          'data-dsh-attachment-button': status,
          style: {
            width: '28px', height: '28px', padding: '0', border: '0', borderRadius: '50%',
            color: error ? '#f35b5b' : 'inherit', background: 'transparent', cursor: locked ? 'default' : 'pointer',
            opacity: locked ? 0.45 : 1, fontSize: '17px', lineHeight: '28px',
          },
        }, status === 'uploading' ? '…' : status === 'done' ? '✓' : '📎'),
      )
    }

    function apply(ctx) {
      var conversation = ctx.get && ctx.get('conversation')
      ctx.slots.inject('conversation.input.left', function* () {
        yield ctx.slots.register({ name: 'conversation.input.left', id: 'chat-attachments', order: 20 }, function (props) {
          return React.createElement(Paperclip, Object.assign({}, props, { _conversation: conversation }))
        })
      })
    }

    exports.name = 'chat-attachments'
    exports.inject = ['slots', 'conversation']
    exports.apply = apply
    exports._internal = { fileDescription: fileDescription, uploadGeneralFile: uploadGeneralFile }
    return module.exports
  },
})
