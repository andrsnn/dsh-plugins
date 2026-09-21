import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

test('client loads and registers one additive composer control', async () => {
  const source = await readFile(new URL('../dsh/client.js', import.meta.url), 'utf8')
  let definition
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(value) { definition = value } } },
    Set,
    fetch: async () => { throw new Error('unused') },
  })
  new vm.Script(source).runInContext(context)
  assert.equal(definition.id, 'dsh-chat-attachments')
  const React = {
    Fragment: Symbol('Fragment'),
    createElement() {},
    useRef(value) { return { current: value } },
    useState(value) { return [typeof value === 'function' ? value() : value, () => {}] },
  }
  const plugin = definition.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  let injectedSlot
  let registered
  plugin.apply({
    get(name) { return name === 'conversation' ? {} : undefined },
    slots: {
      inject(name, mount) {
        injectedSlot = name
        const iterator = mount()
        iterator.next()
      },
      register(spec, component) {
        registered = { spec, component }
        return () => {}
      },
    },
  })
  assert.equal(injectedSlot, 'conversation.input.left')
  assert.equal(registered.spec.id, 'chat-attachments')
  assert.equal(typeof registered.component, 'function')
})
