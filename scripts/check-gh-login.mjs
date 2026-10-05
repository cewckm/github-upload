// check-gh-login.mjs — is the driven window logged in to GitHub?
const port = Number(process.env.GH_PORT ?? 9222)
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((x) => x.type === 'page')
if (!page) {
  console.log('no page target on port', port, '— run: node launch-gh.mjs')
  process.exit(0)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = ++id
  pending.set(myId, resolve)
  setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + method)) } }, 30000)
  ws.send(JSON.stringify({ id: myId, method, params }))
})
const evalJs = async (expression) => {
  const r = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}
await rpc('Page.enable')
await rpc('Runtime.enable')
await rpc('Page.navigate', { url: 'https://github.com/settings/tokens/new' })
await new Promise((r) => setTimeout(r, 8000))
const state = await evalJs(`JSON.stringify({
  url: location.href,
  title: document.title,
  hasLoginForm: !!document.querySelector('input[name="login"], form[action="/session"]'),
  hasTokenForm: !!document.querySelector('#oauth_access_description, input[name="oauth_access[description]"]'),
  bodyHead: (document.body ? document.body.innerText.slice(0, 200) : '')
})`)
console.log(state)
ws.close()
