/**
 * config.mjs — resolve "which repository am I publishing?" for any project.
 *
 * Resolution order (first hit wins):
 *   1. explicit CLI arguments     --repo / --repoDir
 *   2. environment variables      GH_REPO / GH_REPO_DIR / GH_OWNER
 *   3. `git remote get-url origin` in the target directory
 *
 * Nothing here is specific to a particular project, so the same scripts work in
 * any git checkout.
 */
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))

/** Read `--flag value` pairs and boolean flags from argv. */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else { flags[key] = next; index += 1 }
  }
  return flags
}

/** `git config --get` in a directory, or undefined. */
function gitConfig(dir, key) {
  try {
    return execFileSync('git', ['-C', dir, 'config', '--get', key], { encoding: 'utf8' }).trim() || undefined
  } catch { return undefined }
}

/**
 * Parse `owner/repo` out of any common remote URL shape:
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *   https://user:token@github.com/owner/repo.git
 * @param {string} url - the remote URL.
 * @returns {{ owner: string, repo: string, host: string } | undefined} the parts.
 */
export function parseRemote(url) {
  if (typeof url !== 'string' || url.trim() === '') return undefined
  const cleaned = url.trim().replace(/\.git$/, '')
  const match = /(?:@|\/\/)([^/:@]+)[/:]([^/]+)\/([^/]+)$/.exec(cleaned)
  if (match === null) return undefined
  const [, host, owner, repo] = match
  if (host.includes('@')) return undefined
  return { host, owner, repo }
}

/**
 * Walk up from a starting directory until a `.git` entry is found.
 *
 * Without this, running the scripts from a subdirectory (the natural thing to do
 * — they live in `scripts/`) would look for the repository in that subdirectory
 * and fail with "no origin remote".
 *
 * @param {string} start - directory to start from.
 * @returns {string} the enclosing git work tree, or the original directory.
 */
export function findGitRoot(start) {
  let current = resolve(start)
  for (let depth = 0; depth < 24; depth += 1) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolve(start)
}

/**
 * Resolve the publishing target.
 *
 * `owner`/`repo` may legitimately be unknown — creating the FIRST token for a
 * brand-new local repository does not need them (there is no remote yet). In that
 * case they come back undefined and only the operations that actually talk to a
 * repository need to complain.
 *
 * @param {Record<string, string|boolean>} [flags] - parsed CLI flags.
 * @param {{ requireRepo?: boolean }} [options] - set requireRepo to fail fast.
 * @returns {{ repoDir: string, owner?: string, repo?: string, branch: string, remote?: string, tokenFile: string }} the target.
 */
export function resolveTarget(flags = {}, options = {}) {
  const requested = resolve(
    (typeof flags.repoDir === 'string' ? flags.repoDir : undefined)
    ?? process.env.GH_REPO_DIR
    ?? process.cwd(),
  )
  // Prefer the enclosing work tree when the caller did not name one explicitly.
  const repoDir = typeof flags.repoDir === 'string' || process.env.GH_REPO_DIR !== undefined
    ? requested
    : findGitRoot(requested)
  const branch = (typeof flags.branch === 'string' ? flags.branch : undefined)
    ?? process.env.GH_BRANCH
    ?? 'main'

  let owner = (typeof flags.owner === 'string' ? flags.owner : undefined) ?? process.env.GH_OWNER
  let repo = (typeof flags.repo === 'string' ? flags.repo : undefined) ?? process.env.GH_REPO
  let remote

  if (existsSync(join(repoDir, '.git'))) {
    remote = gitConfig(repoDir, 'remote.origin.url')
    const parsed = parseRemote(remote)
    if (parsed !== undefined) {
      owner = owner ?? parsed.owner
      repo = repo ?? parsed.repo
    }
  }

  if (options.requireRepo === true && (owner === undefined || repo === undefined)) {
    throw new Error(
      `cannot determine the GitHub repository.\n` +
      `  looked in : ${repoDir}\n` +
      `  remote    : ${remote ?? '(no origin remote)'}\n` +
      `  fix       : pass --repo owner/name, or set GH_REPO=owner/name`,
    )
  }

  return {
    repoDir,
    owner,
    repo,
    branch,
    remote,
    tokenFile: join(HERE, '_token.txt'),
  }
}

/** Human-readable summary for logs. */
export function describeTarget(t) {
  return {
    repoDir: t.repoDir,
    repository: `${t.owner}/${t.repo}`,
    branch: t.branch,
    remote: t.remote ?? null,
    tokenFile: t.tokenFile,
  }
}

/** Is there a git identity configured for this repo (needed to commit)? */
export function gitIdentity(repoDir) {
  const name = gitConfig(repoDir, 'user.name')
  const email = gitConfig(repoDir, 'user.email')
  return { name, email, configured: name !== undefined && email !== undefined }
}

/** Read a file if it exists, else undefined. */
export function readIfExists(path) {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}
