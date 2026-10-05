// publish-new-repo.mjs — create a brand-new GitHub repo (if absent) and publish a local git
// checkout into it through the REST API, then verify every remote blob against the local file.
//
//   node publish-new-repo.mjs --repoDir <dir> --name <repo> [--owner <login>]
//                             [--tokenFile <path>] [--private] [--message "..."]
//
// Exists because api-push.mjs targets an EXISTING repository; a fresh skill needs the repo
// created first (Contents/Git Data API cannot create repositories).
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { parseArgs } from './config.mjs'

const flags = parseArgs()
const repoDir = resolve(typeof flags.repoDir === 'string' ? flags.repoDir : process.cwd())
const name = typeof flags.name === 'string' ? flags.name : undefined
if (name === undefined) { console.error('need --name <repo>'); process.exit(1) }
const tokenFile = typeof flags.tokenFile === 'string'
  ? flags.tokenFile
  : join(repoDir, 'scripts', '_token.txt')
if (!existsSync(tokenFile)) { console.error('missing token file:', tokenFile); process.exit(1) }
const token = readFileSync(tokenFile, 'utf8').trim()
const message = typeof flags.message === 'string' ? flags.message : 'publish via API'
const isPrivate = flags.private === true
const redact = (s) => String(s).replaceAll(token, '***')

const api = async (method, path, body) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-paper-download',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, json, text }
}

// 1) who am I
const me = await api('GET', '/user')
if (!me.ok) { console.error('token invalid:', me.status, redact(me.text).slice(0, 160)); process.exit(1) }
const owner = typeof flags.owner === 'string' ? flags.owner : me.json.login
console.log(`account: ${owner} (${me.json.type})`)

// 2) create the repository when absent
let created = await api('POST', '/user/repos', {
  name,
  description: typeof flags.description === 'string' ? flags.description : `${name} — DSH skill`,
  private: isPrivate,
  has_issues: true, has_wiki: false, has_projects: false,
  auto_init: false,
})
if (created.status === 422 && /already exists/i.test(created.text)) {
  console.log(`repository exists, reusing ${owner}/${name}`)
} else if (!created.ok) {
  console.error(`create failed (HTTP ${created.status}): ${redact(created.text).slice(0, 200)}`)
  process.exit(1)
} else {
  console.log(`repository created: ${created.json.html_url} (${created.json.private ? 'private' : 'public'})`)
}

// 3) publish with the skill's own API channel
console.log('publishing via api-push.mjs …')
try {
  const out = execFileSync(process.execPath, [
    join(import.meta.dirname, 'api-push.mjs'),
    '--repoDir', repoDir, '--owner', owner, '--repo', name,
    '--tokenFile', tokenFile, '--branch', 'main', '--message', message,
  ], { encoding: 'utf8', stdio: 'pipe' })
  console.log(redact(out).split('\n').slice(-8).join('\n'))
} catch (e) {
  console.error('api-push failed:\n' + redact(String(e.stdout ?? '') + String(e.stderr ?? e.message)).slice(0, 1200))
  process.exit(1)
}

// 4) verify: every local tracked file's blob id must exist in the remote tree
const git = (args) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim()
const localFiles = git(['ls-files']).split('\n').filter(Boolean)
const tree = await api('GET', `/repos/${owner}/${name}/git/trees/main?recursive=1`)
if (!tree.ok) { console.error('tree read failed:', tree.status, redact(tree.text).slice(0, 160)); process.exit(1) }
const remote = new Map(tree.json.tree.filter((n) => n.type === 'blob').map((n) => [n.path, n.sha]))
const blobId = (p) => {
  const bytes = readFileSync(join(repoDir, p))
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}
let ok = 0
const bad = []
for (const f of localFiles) {
  const want = blobId(f)
  const got = remote.get(f)
  if (got === want) ok += 1
  else bad.push(`${f} local=${want.slice(0, 8)} remote=${(got ?? 'MISSING').slice(0, 8)}`)
}
console.log(`\nverify: ${ok}/${localFiles.length} blobs match the remote tree`)
if (bad.length) { console.log('mismatches:'); for (const b of bad) console.log('  ' + b) }

// 5) safety: destroy the token file
try { unlinkSync(tokenFile); console.log('token file deleted:', tokenFile) } catch (e) { console.log('token delete warn:', e.message) }
console.log(`\nrepo: https://github.com/${owner}/${name}`)
console.log(`commit: ${tree.json.sha?.slice(0, 12) ?? '(unknown)'}`)
process.exit(bad.length === 0 ? 0 : 1)
