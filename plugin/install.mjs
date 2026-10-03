/**
 * install.mjs — install this skill plugin into a DSH profile.
 *
 *   node install.mjs
 *   node install.mjs --profile desktop --home C:\Users\you\.dsh
 *   node install.mjs --uninstall
 *
 * The loader resolves a row's `name` as a package specifier out of the profile,
 * so the plugin is copied to <profile>/node_modules. The skill body and scripts
 * are NOT copied — the manifest and the patch both point back at this checkout,
 * so exactly one copy of the authored content exists.
 *
 * After installing: completely quit DSH (Windows tray icon too) and reopen it.
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PKG = 'dsh-skill-github-upload'
const ROW_ID = 'skill-github-upload'

function parseArgs(argv) {
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

const flags = parseArgs(process.argv.slice(2))
const home = typeof flags.home === 'string' ? flags.home : (process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const profile = typeof flags.profile === 'string' ? flags.profile : (process.env.DSH_PROFILE ?? 'desktop')
const profileDir = join(home, 'profiles', profile)
const patchPath = join(profileDir, 'cordis.patch.yml')
const installed = join(profileDir, 'node_modules', PKG)

if (!existsSync(profileDir)) {
  console.error(`profile not found: ${profileDir}`)
  console.error('pass the right one with --profile <name>, or --home <dsh home>')
  process.exit(1)
}

const scalar = (value) => `'${String(value).replaceAll("'", "''")}'`

if (flags.uninstall === true || flags.remove === true) {
  await rm(installed, { recursive: true, force: true })
  if (existsSync(patchPath)) {
    const before = await readFile(patchPath, 'utf8')
    const row = new RegExp(`- id: ${ROW_ID}\\n[\\s\\S]*?(?=\\n- |\\n# |$)`)
    const after = before.replace(row, '').replace(/\n{3,}/g, '\n\n')
    if (after !== before) {
      await copyFile(patchPath, `${patchPath}.bak`)
      await writeFile(patchPath, after, 'utf8')
    }
  }
  console.log(`uninstalled ${PKG} from profile "${profile}"`)
  console.log('restart DSH to drop the skill from the catalog')
  process.exit(0)
}

const manifest = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'))
delete manifest.dependencies
delete manifest.devDependencies
manifest.private = true

await mkdir(installed, { recursive: true })
await writeFile(join(installed, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await copyFile(join(here, 'index.js'), join(installed, 'index.js'))

const block = `# ── github-upload skill ──────────────────────────────────────────────────────
# Authored in  ${here}
# Installed to ${installed}
#
# Registers ONE runtime skill named "github-upload" (把本地代码发布到 GitHub).
# The row names the PACKAGE, not a file path: the loader resolves it out of this
# profile's node_modules.
#
# Remove this block (or run \`node install.mjs --uninstall\`) and restart DSH.
- id: ${ROW_ID}
  name: ${PKG}
  config:
    skillFile: ${scalar(join(here, '..', 'skill', 'SKILL.md'))}
    scriptsDir: ${scalar(join(here, '..', 'scripts'))}
`

const existing = existsSync(patchPath) ? await readFile(patchPath, 'utf8') : '# Your patch layer for this dsh profile.\n[]\n'
const row = new RegExp(`- id: ${ROW_ID}\\n[\\s\\S]*?(?=\\n- |\\n# |$)`)
let next
if (existing.includes(`id: ${ROW_ID}`)) {
  next = existing.replace(row, block.trimEnd())
} else if (/^\s*\[\s*\]\s*$/m.test(existing)) {
  next = `${existing.replace(/^\s*\[\s*\]\s*$/m, '').trimEnd()}\n\n${block}`
} else {
  next = `${existing.trimEnd()}\n\n${block}`
}

await copyFile(patchPath, `${patchPath}.bak`)
await writeFile(patchPath, next, 'utf8')

console.log(`installed ${PKG} into profile "${profile}"`)
console.log(`  package : ${installed}`)
console.log(`  skill   : ${join(here, '..', 'skill', 'SKILL.md')}`)
console.log(`  scripts : ${join(here, '..', 'scripts')}`)
console.log(`  patch   : ${patchPath}   (previous copy kept as cordis.patch.yml.bak)`)
console.log('')
console.log('Next: completely quit DSH (tray icon too) and reopen it; the catalog will list: github-upload')
