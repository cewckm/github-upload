/**
 * dsh-skill-github-upload — Host half.
 *
 * Registers one runtime skill (`github-upload`) into the DSH skill registry, so
 * any session can load the GitHub publishing playbook on demand — including the
 * part that matters most in practice: telling apart the several ways a push can
 * fail and picking the channel that actually works on this machine.
 *
 * The skill body ships as `../skill/SKILL.md`; `{{SCRIPTS_DIR}}` and friends are
 * substituted with absolute paths at activation time so the loaded skill is
 * directly runnable rather than a template.
 *
 * Also publishes a read-only status route when a Web server is mounted:
 *     GET /dsh-skill-github-upload/status
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-skill-github-upload'

/**
 * Read `skills` / `webServer` with ctx.get() instead of injecting them: the skill
 * should register whenever a registry exists, and the HTTP route whenever a Web
 * shell exists. Neither absence should stop this row from activating.
 */
export const inject = []

const ROUTE = '/dsh-skill-github-upload'
const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SKILL_FILE = join(HERE, '..', 'skill', 'SKILL.md')
const DEFAULT_SCRIPTS = join(HERE, '..', 'scripts')

/** @typedef {{ skillName?: string, skillFile?: string, scriptsDir?: string, statusRoute?: 'route' | 'off' }} Config */

/** Substitute `{{TOKEN}}` placeholders; unknown tokens stay verbatim so typos show. */
function render(body, values) {
  return body.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, token) =>
    Object.prototype.hasOwnProperty.call(values, token) ? values[token] : whole)
}

/** Split YAML frontmatter from the markdown body (flat string scalars only). */
function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { frontmatter: {}, body: text }
  const frontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (pair === null) continue
    let value = pair[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    frontmatter[pair[1]] = value
  }
  return { frontmatter, body: text.slice(match[0].length) }
}

/**
 * Host plugin body.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {Config} [config] - resolved plugin config.
 */
export function apply(ctx, config) {
  const options = config ?? {}
  const skillFile = resolve(options.skillFile ?? DEFAULT_SKILL_FILE)
  const scriptsDir = resolve(options.scriptsDir ?? DEFAULT_SCRIPTS)
  const skillName = options.skillName ?? 'github-upload'

  const values = {
    SKILL_NAME: skillName,
    PLUGIN_DIR: HERE,
    SCRIPTS_DIR: scriptsDir,
  }

  let body = ''
  let description = '把本地代码或技能包发布到 GitHub：建仓库、认证、提交、推送与校验，含 git push 被网络阻断时的 API 通道。'
  let whenToUse = ''
  let loadError = null

  try {
    const raw = readFileSync(skillFile, 'utf8')
    const parsed = splitFrontmatter(raw)
    body = render(parsed.body, values)
    if (parsed.frontmatter.description) description = parsed.frontmatter.description
    if (parsed.frontmatter.whenToUse) whenToUse = parsed.frontmatter.whenToUse
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
  }

  const skills = ctx.get('skills')
  if (skills === undefined) {
    console.log('[dsh-skill-github-upload] no skill registry mounted — skipping registration', { skillFile })
  } else if (loadError !== null) {
    console.log('[dsh-skill-github-upload] skill body unreadable — skipping registration', { skillFile, loadError })
  } else {
    ctx.effect(() => skills.register({
      name: skillName,
      description,
      ...(whenToUse === '' ? {} : { whenToUse }),
      content: body,
    }), `dsh-skill-github-upload: register "${skillName}"`)
  }

  const facts = {
    skillName,
    skillFile,
    skillFileExists: existsSync(skillFile),
    scriptsDir,
    scriptsDirExists: existsSync(scriptsDir),
    loadError,
  }
  try {
    writeFileSync(join(HERE, 'config.resolved.json'), `${JSON.stringify(facts, null, 2)}\n`, 'utf8')
  } catch { /* read-only install: diagnostics stay in memory */ }

  console.log('[dsh-skill-github-upload] host half active', {
    skill: skillName,
    registered: skills !== undefined && loadError === null,
    scriptsDir,
  })

  if (options.statusRoute === 'off') return
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => {
      const method = (req.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
        res.end('method not allowed')
        return
      }
      if ((req.url ?? '/').split('?')[0] !== `${ROUTE}/status`) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(method === 'HEAD' ? undefined : JSON.stringify(facts, null, 2))
    },
  }), 'dsh-skill-github-upload: status route')
}
