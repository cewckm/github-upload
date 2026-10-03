/**
 * install-skill.mjs — copy this skill into a DSH skills directory.
 *
 *   node install-skill.mjs                    # into <DSH_HOME>/skills/github-upload
 *   node install-skill.mjs --dir "D:\skills"  # into a custom skills root
 *   node install-skill.mjs --print            # just show where it would go
 *
 * DSH discovers skills from these roots (rank order, nearest wins):
 *   <project>/.dsh/skills        100
 *   <project>/.agents/skills     200
 *   customSkillDirs              300
 *   <DSH_HOME>/skills            400
 *   ~/.agents/skills             500
 *
 * A skill is a directory bundle `<name>/SKILL.md`. The install copies
 * SKILL.md plus a `scripts/` symlink-free copy, so the skill keeps working even
 * if this checkout moves.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const flags = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const t = process.argv[i]
  if (!t.startsWith('--')) continue
  const next = process.argv[i + 1]
  if (next === undefined || next.startsWith('--')) flags[t.slice(2)] = true
  else { flags[t.slice(2)] = next; i += 1 }
}

/** Where DSH looks for skills, most specific first. */
function candidateRoots() {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const roots = []
  const projectDsh = join(process.cwd(), '.dsh', 'skills')
  const projectAgents = join(process.cwd(), '.agents', 'skills')
  roots.push(projectDsh, projectAgents)
  if (typeof flags.dir === 'string') roots.push(resolve(flags.dir))
  roots.push(join(dshHome, 'skills'), join(homedir(), '.agents', 'skills'))
  return roots
}

const name = 'github-upload'
const roots = candidateRoots()
const destination = typeof flags.dir === 'string'
  ? join(resolve(flags.dir), name)
  : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'skills', name)

console.log('skill source :', ROOT)
console.log('skill name   :', name)
console.log('destination  :', destination)
console.log('DSH looks in :')
for (const r of roots) console.log('  ', r, existsSync(r) ? '(exists)' : '')

if (flags.print === true) process.exit(0)

// Copy the skill body and the scripts it drives.
mkdirSync(join(destination, 'scripts'), { recursive: true })
copyFileSync(join(ROOT, 'skill', 'SKILL.md'), join(destination, 'SKILL.md'))
copyFileSync(join(ROOT, 'README.md'), join(destination, 'README.md'))

const scriptDir = join(ROOT, 'scripts')
let copied = 0
for (const entry of readdirSync(scriptDir)) {
  const from = join(scriptDir, entry)
  if (!statSync(from).isFile()) continue
  if (entry === '_token.txt' || entry === 'config.json') continue   // local state / secrets
  copyFileSync(from, join(destination, 'scripts', entry))
  copied += 1
}

// The SKILL.md refers to {{SCRIPTS_DIR}}; bake in the installed location so the
// loaded skill is directly runnable.
const skillPath = join(destination, 'SKILL.md')
const body = readFileSync(skillPath, 'utf8')
  .replaceAll('{{SCRIPTS_DIR}}', join(destination, 'scripts'))
  .replaceAll('{{SKILL_NAME}}', name)
const { writeFileSync } = await import('node:fs')
writeFileSync(skillPath, body, 'utf8')

console.log(`\ninstalled: ${copied} scripts + SKILL.md`)
console.log('next: it appears in the session skill catalog on the next step')
