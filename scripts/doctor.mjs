// doctor.mjs — check everything a GitHub publish needs, and say which channel to use.
//
//   node doctor.mjs [--repoDir path] [--repo owner/name]
//
// Prints one line per check with a clear pass/fail, then a verdict:
//   channel A (git push)  when the git smart-http endpoint answers
//   channel B (REST API)  when only api.github.com answers
//
// This exists because the two channels fail in ways that look identical from the
// outside ("push failed"), and guessing wastes a lot of time.
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describeTarget, gitIdentity, parseArgs, resolveTarget } from './config.mjs'

const flags = parseArgs()
const results = []
const add = (name, ok, detail) => { results.push({ name, ok, detail }) }

console.log('=== environment ===')
console.log('  platform :', process.platform)
console.log('  node     :', process.version)

// ---------- git ----------
let gitVersion
try {
  gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()
  add('git installed', true, gitVersion)
} catch {
  add('git installed', false, 'git not found on PATH')
  console.log('  git      : MISSING')
}

// ---------- target repository ----------
let target
try {
  target = resolveTarget(flags)
  add('repository resolved', true, `${target.owner}/${target.repo} (branch ${target.branch})`)
  console.log('=== target ===')
  console.log('  repoDir  :', target.repoDir)
  console.log('  remote   :', target.remote ?? '(no origin remote)')
  console.log('  repo     :', `${target.owner}/${target.repo}`)
  console.log('  branch   :', target.branch)
} catch (error) {
  add('repository resolved', false, error.message)
  console.log('\n' + error.message)
  process.exit(1)
}

if (!existsSync(join(target.repoDir, '.git'))) {
  add('git repository', false, `${target.repoDir} is not a git checkout`)
} else {
  add('git repository', true, target.repoDir)
  const identity = gitIdentity(target.repoDir)
  add('commit identity', identity.configured, identity.configured
    ? `${identity.name} <${identity.email}>`
    : 'not set — api-push.mjs will set a neutral local identity')
  let head = '(none)'
  let counts = '(no commits)'
  try { head = execFileSync('git', ['-C', target.repoDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* empty repo */ }
  try {
    const tracked = execFileSync('git', ['-C', target.repoDir, 'ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length
    const dirty = execFileSync('git', ['-C', target.repoDir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
    counts = `${tracked} tracked, ${dirty === '' ? 'clean' : dirty.split('\n').length + ' uncommitted change(s)'}`
  } catch { /* ignore */ }
  add('local state', true, `HEAD ${head}; ${counts}`)
}

// ---------- credential manager ----------
try {
  const systemHelper = execFileSync('git', ['config', '--system', '--get', 'credential.helper'], { encoding: 'utf8' }).trim()
  add('credential helper', systemHelper === '',
    systemHelper === ''
      ? 'none configured'
      : `${systemHelper} — will pop a GUI on push; bypass with -c credential.helper=`)
} catch {
  add('credential helper', true, 'none configured')
}

// ---------- network ----------
const probe = async (url, { timeout = 12000 } = {}) => {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'dsh-github-upload-doctor' },
      signal: AbortSignal.timeout(timeout),
    })
    return { ok: true, status: res.status, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started }
  }
}

console.log('=== network ===')
const apiProbe = await probe('https://api.github.com/rate_limit')
add('api.github.com', apiProbe.ok, apiProbe.ok ? `HTTP ${apiProbe.status} in ${apiProbe.ms}ms` : `${apiProbe.error} (${apiProbe.ms}ms)`)
console.log(`  api.github.com      : ${apiProbe.ok ? `OK (${apiProbe.ms}ms)` : `FAIL (${apiProbe.error}, ${apiProbe.ms}ms)`}`)

const gitProbe = await probe(`https://github.com/${target.owner}/${target.repo}.git/info/refs?service=git-receive-pack`, { timeout: 20000 })
// A 401/403 here means the endpoint ANSWERED — it just wants credentials, which is
// exactly what a push supplies. Only a transport failure counts as unreachable.
const gitReachable = gitProbe.ok && gitProbe.status < 500
add('git endpoint', gitReachable, gitProbe.ok
  ? `HTTP ${gitProbe.status} in ${gitProbe.ms}ms${gitProbe.status === 401 || gitProbe.status === 403 ? ' (auth required — reachable)' : ''}`
  : `${gitProbe.error} (${gitProbe.ms}ms)`)
console.log(`  git receive-pack    : ${gitProbe.ok ? `reachable (HTTP ${gitProbe.status}, ${gitProbe.ms}ms)` : `UNREACHABLE (${gitProbe.error}, ${gitProbe.ms}ms)`}`)

const webProbe = await probe('https://github.com')
add('github.com web', webProbe.ok, webProbe.ok ? `HTTP ${webProbe.status} in ${webProbe.ms}ms` : `${webProbe.error} (${webProbe.ms}ms)`)
console.log(`  github.com (web)    : ${webProbe.ok ? `OK (${webProbe.ms}ms)` : `FAIL (${webProbe.error}, ${webProbe.ms}ms)`}`)

// ---------- browser debug port ----------
const port = Number(process.env.GH_PORT ?? 9222)
let browserUp = false
let browserInfo = ''
try {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(4000) })
  if (res.ok) { browserUp = true; browserInfo = (await res.json()).Browser }
} catch { /* not running */ }
add('debuggable browser', browserUp, browserUp ? `${browserInfo} on port ${port}` : `nothing on port ${port} — run: node launch-gh.mjs`)
console.log(`  browser :${String(port)}       : ${browserUp ? 'OK — ' + browserInfo : 'not running (needed for token creation)'}`)

// ---------- token ----------
const tokenPresent = existsSync(target.tokenFile)
add('token file', tokenPresent, tokenPresent ? target.tokenFile : `absent (${target.tokenFile}) — create with: node gh-pat.mjs token`)

// ---------- verdict ----------
console.log('\n=== verdict ===')
if (gitReachable) {
  console.log('  CHANNEL A — the git endpoint answers, so git push should work.')
  console.log('  Create a token:  node gh-pat.mjs token')
  console.log('  Then push (the -c flag bypasses a GUI credential manager):')
  console.log(`    git -C "${target.repoDir}" -c credential.helper= push \\`)
  console.log(`      https://<your-login>:<token>@github.com/${target.owner}/${target.repo}.git ${target.branch}`)
  console.log('  If it times out anyway, fall back to: node api-push.mjs --message "..."')
} else if (apiProbe.ok) {
  console.log('  CHANNEL B — the git endpoint is unreachable but the REST API works.')
  console.log('  This is a network-path block, not a git problem: retrying push will not help.')
  console.log('  Publish through the API instead:')
  console.log(`    1. node launch-gh.mjs        (once, then sign in to GitHub in that window)`)
  console.log(`    2. node gh-pat.mjs token`)
  console.log(`    3. node api-push.mjs --message "..."`)
} else {
  console.log('  NO CHANNEL — neither the API nor the git endpoint is reachable.')
  console.log('  Check the machine\'s network, proxy or VPN before continuing.')
}

console.log('\n=== checks ===')
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(22)} ${r.detail}`)
}
console.log('\ntarget:', JSON.stringify(describeTarget(target)))

const fatal = results.some((r) => !r.ok && ['git installed', 'repository resolved', 'git repository'].includes(r.name))
process.exit(fatal ? 1 : 0)
