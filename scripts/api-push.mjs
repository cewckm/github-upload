// api-push.mjs — publish committed files to GitHub through the REST API.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// On some networks the git smart-http endpoint is unreachable while the REST API
// is not. Observed on a real machine:
//
//   https://github.com                                     -> intermittently dead
//   https://api.github.com                                 -> 200, always
//   https://github.com/<o>/<r>.git/info/refs?service=…     -> 5/5 timeouts
//   gitlab.com / gitee.com git endpoints                   -> fine
//
// curl.exe and git fail on that endpoint simultaneously (both use libcurl), so
// the block is in the network path, not in a client. `git push` therefore cannot
// work there — but the API can do exactly what a push does:
//
//   POST /git/blobs   -> one blob per changed file
//   POST /git/trees   -> a tree based on the remote tree
//   POST /git/commits -> a commit whose parent is the remote tip
//   PATCH /git/refs/heads/<branch> -> move the branch
//
// ── WHY IT COMPARES INSTEAD OF TRUSTING LOCAL GIT ────────────────────────────
// Commits created through the API exist only on the server; a local `git fetch`
// cannot retrieve them when the git endpoint is blocked. So this script never
// asks git what changed. It reads the REMOTE tree from the API, computes each
// local file's git blob id itself —
//
//     sha1("blob " + byteLength + "\0" + bytes)
//
// — and publishes only the files whose id differs. That also means it works with
// no local git objects for the remote commit at all.
//
// Usage:
//   node api-push.mjs --message "..." [--repo owner/name] [--repoDir path]
//                     [--branch main] [--tokenFile path] [--dry-run]
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describeTarget, parseArgs, resolveTarget } from './config.mjs'

const flags = parseArgs()
const target = resolveTarget(flags, { requireRepo: true })
const branch = target.branch
const dryRun = flags['dry-run'] === true
const message = typeof flags.message === 'string' ? flags.message : undefined
// Declared here because both the first-commit path (Contents API) and the normal
// path (Git Data API) use it.
const commitMessage = message ?? 'publish via API'

// Accept a token wherever it happens to be: an explicit --tokenFile, this
// script's own directory (gh-pat.mjs default), or the target repo's scripts/.
const tokenCandidates = [
  typeof flags.tokenFile === 'string' ? flags.tokenFile : undefined,
  target.tokenFile,
  join(target.repoDir, 'scripts', '_token.txt'),
].filter((value) => typeof value === 'string')
const tokenFile = tokenCandidates.find((path) => existsSync(path))

console.log('target:', JSON.stringify(describeTarget(target), null, 1))
if (!existsSync(join(target.repoDir, '.git'))) {
  console.error(`not a git repository: ${target.repoDir}`)
  process.exit(1)
}
if (tokenFile === undefined) {
  console.error('missing token file. looked for:')
  for (const path of tokenCandidates) console.error(`  ${path}`)
  console.error('create one with: node gh-pat.mjs token')
  process.exit(1)
}
console.log('token file:', tokenFile)
const token = readFileSync(tokenFile, 'utf8').trim()
if (token.length < 20) {
  console.error(`token looks malformed (length ${token.length})`)
  process.exit(1)
}

const api = async (method, path, body) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-github-upload',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  })
  const text = await res.text()
  let json
  try { json = text === '' ? undefined : JSON.parse(text) } catch { json = undefined }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> HTTP ${res.status} ${json?.message ?? text.slice(0, 200)}`)
  }
  return json
}

const git = (args, { encoding = 'utf8' } = {}) =>
  execFileSync('git', ['-C', target.repoDir, ...args], { encoding, maxBuffer: 64 * 1024 * 1024 })

/** Raw blob bytes straight out of the object database (never the working tree). */
const blobBytes = (rev, path) =>
  execFileSync('git', ['-C', target.repoDir, 'cat-file', 'blob', `${rev}:${path}`], { maxBuffer: 64 * 1024 * 1024 })

/** The git blob id of arbitrary bytes: sha1("blob <len>\0" + bytes). */
function blobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'ascii')
  return createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex')
}

// ---------- 1. optionally commit pending work ----------
if (message !== undefined) {
  const dirty = git(['status', '--porcelain']).toString().trim()
  if (dirty !== '') {
    for (const key of ['user.name', 'user.email']) {
      const value = (() => { try { return git(['config', '--get', key]).toString().trim() } catch { return '' } })()
      if (value === '') {
        // A commit needs an identity; set a neutral local one instead of failing
        // or touching the user's global config.
        const fallback = key === 'user.name' ? 'github-upload' : 'github-upload@users.noreply.github.com'
        git(['config', key, fallback])
        console.log(`set local ${key} = ${fallback}`)
      }
    }
    git(['add', '-A'])
    const staged = git(['diff', '--cached', '--name-only']).toString().trim()
    if (staged !== '') {
      git(['commit', '-m', message])
      console.log('committed:', git(['rev-parse', '--short', 'HEAD']).toString().trim())
    } else {
      console.log('nothing staged to commit')
    }
  } else {
    console.log('working tree clean; nothing to commit')
  }
}

// ---------- 2. remote tip (or notice that the repository is empty) ----------
// A freshly created GitHub repository has NO branch at all: asking for
// ref/heads/<branch> answers 409 "Git Repository is empty", and there is no base
// tree to compare against. That is the normal first-publish case, so it is
// handled explicitly instead of surfacing a raw 409.
let base
let remoteShas = new Map()
let baseTreeSha
let emptyRepo = false
try {
  const ref = await api('GET', `/repos/${target.owner}/${target.repo}/git/ref/heads/${branch}`)
  base = ref.object.sha
  console.log(`remote ${branch} tip: ${base.slice(0, 7)}`)
  const remoteTree = await api('GET', `/repos/${target.owner}/${target.repo}/git/trees/${base}?recursive=1`)
  baseTreeSha = remoteTree.sha
  for (const node of remoteTree.tree) {
    if (node.type === 'blob') remoteShas.set(node.path, node.sha)
  }
  console.log(`remote tree: ${remoteShas.size} blobs`)
} catch (error) {
  if (/HTTP 409/.test(String(error.message)) || /is empty/i.test(String(error.message))) {
    emptyRepo = true
    console.log(`remote repository is empty — creating the first commit on "${branch}"`)
  } else {
    throw error
  }
}

/** Every file in the local HEAD tree, as a flat list. */
function listLocalFiles() {
  return git(['ls-tree', '-r', '--name-only', 'HEAD']).toString()
    .split('\n').map((s) => s.trim()).filter(Boolean)
}

// ---------- 3. decide what to publish ----------
const allFiles = listLocalFiles()
if (allFiles.length === 0) {
  console.error('local HEAD has no files to publish')
  process.exit(1)
}
const localShas = new Map()
const changed = []
for (const path of allFiles) {
  let bytes
  try { bytes = blobBytes('HEAD', path) } catch { continue }
  const sha = blobSha(bytes)
  localShas.set(path, { sha, bytes })
  if (emptyRepo || remoteShas.get(path) !== sha) changed.push(path)
}
// Files present remotely but not tracked locally are left untouched on purpose:
// deleting through this path is destructive and is not what "publish" means.
const added = changed.filter((p) => !remoteShas.has(p))
const modified = changed.filter((p) => remoteShas.has(p))

if (changed.length === 0) {
  console.log('nothing to publish — remote already matches local HEAD')
  rmSync(tokenFile, { force: true })
  process.exit(0)
}
console.log(`to publish: ${changed.length} (${added.length} new, ${modified.length} modified)`)
for (const p of changed) console.log(`  ${remoteShas.has(p) ? 'M' : 'A'} ${p}`)
if (dryRun) {
  console.log('dry run: nothing sent')
  process.exit(0)
}

// ---------- 4. upload ----------
//
// Two different mechanisms, because GitHub treats an empty repository specially:
// the Git Data API (blobs/trees/commits) answers 409 "Git Repository is empty"
// until the repository has at least one commit. The Contents API is the only
// thing that can create the FIRST commit, so that path is used once and the
// normal blob/tree/commit path takes over from the second publish onward.
if (emptyRepo) {
  console.log('first publish: using the Contents API (the Git Data API rejects an empty repository)')
  for (const path of changed) {
    const { bytes } = localShas.get(path)
    const result = await api('PUT', `/repos/${target.owner}/${target.repo}/contents/${encodeURI(path)}`, {
      message: commitMessage ?? `add ${path}`,
      content: bytes.toString('base64'),
      branch,
    })
    const sha = result?.commit?.sha
    console.log(`  + ${path}  (${bytes.length} bytes)${sha ? `  commit ${sha.slice(0, 8)}` : ''}`)
  }

  const head = await api('GET', `/repos/${target.owner}/${target.repo}/git/ref/heads/${branch}`)
  const commit = { sha: head.object.sha }
  console.log('branch head:', commit.sha.slice(0, 8))

  const note = {
    publishedAt: new Date().toISOString(),
    repository: `${target.owner}/${target.repo}`,
    branch,
    localHead: git(['rev-parse', 'HEAD']).toString().trim(),
    remoteHead: commit.sha,
    files: changed,
    mode: 'first-commit-via-contents-api',
  }
  writeFileSync(join(target.repoDir, '.git', 'last-api-push.json'), `${JSON.stringify(note, null, 2)}\n`, 'utf8')
  rmSync(tokenFile, { force: true })
  console.log('token file removed')
  console.log(`\nAPI_PUSH_OK ${commit.sha}`)
  console.log(`repository: https://github.com/${target.owner}/${target.repo}`)
  process.exit(0)
}

// ---------- 4b. blobs ----------
const entries = []
for (const path of changed) {
  const { bytes } = localShas.get(path)
  const blob = await api('POST', `/repos/${target.owner}/${target.repo}/git/blobs`, {
    content: bytes.toString('base64'),
    encoding: 'base64',
  })
  entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
  console.log(`  blob ${blob.sha.slice(0, 8)}  ${path}  (${bytes.length} bytes)`)
}

// ---------- 5. tree ----------
// base_tree is omitted for a first commit: there is no base tree to preserve.
const tree = await api('POST', `/repos/${target.owner}/${target.repo}/git/trees`, emptyRepo
  ? { tree: entries }
  : { base_tree: baseTreeSha, tree: entries })
console.log('tree:', tree.sha.slice(0, 8))

// ---------- 6. commit ----------
const commit = await api('POST', `/repos/${target.owner}/${target.repo}/git/commits`, {
  message: commitMessage,
  tree: tree.sha,
  parents: emptyRepo ? [] : [base],
})
console.log('commit:', commit.sha.slice(0, 8))

// ---------- 7. move the branch (create it for a first commit) ----------
if (emptyRepo) {
  await api('POST', `/repos/${target.owner}/${target.repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: commit.sha,
  })
  console.log(`created refs/heads/${branch} -> ${commit.sha.slice(0, 8)}`)
} else {
  await api('PATCH', `/repos/${target.owner}/${target.repo}/git/refs/heads/${branch}`, {
    sha: commit.sha,
    force: false,
  })
  console.log(`refs/heads/${branch} -> ${commit.sha.slice(0, 8)}`)
}

// ---------- 8. record the server-made commit locally so status is honest ----------
// The object does not exist locally and cannot be fetched while the git endpoint
// is blocked, so write a small note instead of pretending local git is in sync.
const note = {
  publishedAt: new Date().toISOString(),
  repository: `${target.owner}/${target.repo}`,
  branch,
  localHead: git(['rev-parse', 'HEAD']).toString().trim(),
  remoteHead: commit.sha,
  files: changed,
}
writeFileSync(join(target.repoDir, '.git', 'last-api-push.json'), `${JSON.stringify(note, null, 2)}\n`, 'utf8')

rmSync(tokenFile, { force: true })
console.log('token file removed')
console.log(`\nAPI_PUSH_OK ${commit.sha}`)
console.log(`repository: https://github.com/${target.owner}/${target.repo}`)
console.log(`note: local git still points at ${note.localHead.slice(0, 7)}; remote tip is ${commit.sha.slice(0, 7)}.`)
