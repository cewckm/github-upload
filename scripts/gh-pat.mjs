// gh-pat.mjs — create a GitHub Personal Access Token by driving the web UI.
//
//   node gh-pat.mjs probe       # inspect the token form (selectors may change)
//   node gh-pat.mjs token       # fill the form, generate, save to _token.txt
//   node gh-pat.mjs waitlogin   # wait for the user to sign in (up to 5 minutes)
//
// The token is written to a file so it never has to appear on a command line.
// Callers must delete that file once it has been used; api-push.mjs does.
import { writeFileSync } from 'node:fs';
import { parseArgs, resolveTarget } from './config.mjs';

const flags = parseArgs();
const target = resolveTarget(flags);
const TOKEN_FILE = typeof flags.tokenFile === 'string' ? flags.tokenFile : target.tokenFile;
const PORT = Number(process.env.GH_PORT ?? flags.port ?? 9222);
const cmd = process.argv.slice(2).find((a) => !a.startsWith('--'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// GitHub rejects a duplicate token note, so every run gets a unique name.
// Seconds matter: two runs inside the same minute used to collide.
const TOKEN_NOTE = `dsh-github-upload ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;

/** Minimal CDP connection: this script only needs one page and Runtime.evaluate. */
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  // Several windows may share the debug port (more than one browser on this machine).
  // Pick a github.com page explicitly, otherwise "the first page" can belong to another window.
  const pages = list.filter((x) => x.type === 'page');
  const page = pages.find((x) => /github\.com/.test(x.url ?? '')) ?? pages[0];
  if (!page) throw new Error(`no page target on port ${PORT} — run: node launch-gh.mjs`);
  console.log(`[gh-pat] target: ${String(page.url).slice(0, 70)}`);
  const ws = await new Promise((res, rej) => {
    const s = new WebSocket(page.webSocketDebuggerUrl);
    s.onopen = () => res(s);
    s.onerror = () => rej(new Error('websocket connect failed'));
  });
  let id = 0;
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    const to = setTimeout(() => reject(new Error('timeout ' + method)), 30000);
    const on = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== myId) return;
      clearTimeout(to);
      ws.removeEventListener('message', on);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  await rpc('Runtime.enable');
  const evalJs = async (expression) => {
    const r = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  };
  return { rpc, evalJs, close: () => ws.close() };
}

const c = await connect();
const evalJs = c.evalJs;

try {
  if (cmd === 'probe') {
    console.log(await evalJs(`(() => {
      const form = document.querySelector('form[action="/settings/tokens"]');
      const note = document.querySelector('#oauth_access_description, input[name="oauth_access[description]"]');
      const checkboxes = Array.from(document.querySelectorAll('input[type=checkbox]')).map((el) => ({
        name: el.getAttribute('name'), value: el.getAttribute('value'), id: el.id, checked: el.checked,
      }));
      const exp = document.querySelector('#oauth_access_expires_at, select[name="oauth_access[expires_at]"]');
      const submit = document.querySelector('button[type=submit], input[type=submit]');
      return JSON.stringify({
        url: location.href,
        title: document.title,
        loggedIn: !/\\/login/.test(location.href),
        hasForm: !!form,
        noteSelector: note ? (note.id ? '#' + note.id : note.name) : null,
        expiresSelector: exp ? (exp.id ? '#' + exp.id : exp.name) : null,
        submitText: submit ? (submit.textContent || submit.value || '').trim().slice(0, 40) : null,
        checkboxCount: checkboxes.length,
        repoCheckbox: checkboxes.find((x) => x.value === 'repo') ?? null,
        someCheckboxes: checkboxes.slice(0, 14),
      }, null, 1);
    })()`));
  } else if (cmd === 'waitlogin') {
    console.log('等待你在这个窗口里登录 GitHub（最多 5 分钟）…');
    for (let i = 1; i <= 60; i++) {
      const url = await evalJs('location.href');
      const title = await evalJs('document.title');
      const logged = !/\/login/.test(url) && !/Sign in/i.test(title);
      console.log(`  [${i}] ${logged ? '已登录' : '等待中'} — ${String(title).slice(0, 50)}`);
      if (logged) { console.log('LOGIN_OK ' + url); break; }
      await sleep(5000);
    }
  } else if (cmd === 'token') {
    // 1) 确保在新建 token 页面
    const here = await evalJs('location.href');
    if (!/settings\/tokens\/new/.test(here)) {
      console.log('导航到 token 新建页…');
      await c.rpc('Page.navigate', { url: 'https://github.com/settings/tokens/new' });
      await sleep(5000);
    }
    const nowUrl = await evalJs('location.href');
    if (/\/login/.test(nowUrl)) { console.error('未登录，请先登录：node gh-pat.mjs waitlogin'); process.exit(1); }

    // 2) 填 note
    const noteSel = await evalJs(`(() => {
      const el = document.querySelector('#oauth_access_description, input[name="oauth_access[description]"]');
      return el ? (el.id ? '#' + el.id : '[name="' + el.name + '"]') : null;
    })()`);
    console.log('note 选择器:', noteSel);
    if (!noteSel) { console.error('找不到表单字段，页面可能已改版。跑 probe 看看。'); process.exit(1); }
    await c.evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(noteSel)});
      el.focus(); el.value = ''; return 'ok';
    })()`);
    await c.rpc('Input.insertText', { text: TOKEN_NOTE });
    console.log('token 名称:', TOKEN_NOTE);
    await sleep(400);

    // 3) 勾选 repo scope（含所有子权限，足够 push）
    const checked = await evalJs(`(() => {
      const boxes = Array.from(document.querySelectorAll('input[type=checkbox]'));
      const repo = boxes.find((b) => b.value === 'repo');
      if (!repo) return 'no-repo-checkbox';
      if (!repo.checked) { repo.click(); }
      return JSON.stringify({ value: repo.value, checked: repo.checked, name: repo.getAttribute('name') });
    })()`);
    console.log('repo scope:', checked);
    await sleep(600);

    // 4) 提交
    const clicked = await evalJs(`(() => {
      const btn = Array.from(document.querySelectorAll('button[type=submit], input[type=submit]'))
        .find((b) => /generate token/i.test((b.textContent || b.value || '')));
      if (!btn) return 'no-submit';
      btn.click();
      return 'clicked';
    })()`);
    console.log('提交:', clicked);

    // 5) 等结果页并抓取 token
    let token = null;
    for (let i = 1; i <= 20; i++) {
      await sleep(1500);
      const found = await evalJs(`(() => {
        const el = document.querySelector('#new-oauth-token, code.js-token, [data-testid="new-token"], .token');
        const t = el ? el.textContent.trim() : '';
        return /^(gh[pousr]_|github_pat_)/.test(t) ? t : '';
      })()`);
      if (found) { token = found; break; }
    }
    if (token) {
      writeFileSync(TOKEN_FILE, token, 'utf8');
      console.log('TOKEN_SAVED ' + TOKEN_FILE + '  前缀:' + token.slice(0, 7) + '…  长度:' + token.length);
    } else {
      // Surface whatever GitHub actually said: "Note has already been taken",
      // a rate-limit banner, or a 2FA prompt all look different and need
      // different fixes.
      const msg = await evalJs(`(() => {
        const flash = document.querySelector('.flash-error, .flash-warn, .flash-notice, [role=alert]');
        return JSON.stringify({
          url: location.href,
          notice: flash ? flash.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200) : null,
          head: document.body.innerText.slice(0, 400).replace(/\\n+/g, ' | '),
        });
      })()`);
      console.log('未抓到 token。页面信息:');
      console.log(msg);
      // Leave the tab on a listing page so the next attempt starts clean.
      await c.rpc('Page.navigate', { url: 'https://github.com/settings/tokens' });
    }
  } else {
    console.log('用法: node gh-pat.mjs <probe|waitlogin|token>');
  }
} finally { c.close(); }
