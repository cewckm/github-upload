# github-upload

**English** | [中文](README.zh.md)

**Publish a local project or skill package to GitHub — including under the hardest conditions.**

It covers the failures that were actually hit in practice: a user who had never used GitHub,
no git credentials on the machine, `git push` blocked by the network, a credential popup that
hangs the process, and verification being fooled by GitHub's own cache.

---

## What it solves

When `git push` fails, the symptom always looks the same ("push failed") while the real cause can
be completely different. This skill **diagnoses first** and separates the cases:

```
$ node scripts/doctor.mjs

=== network ===
  api.github.com      : OK (342ms)
  git receive-pack    : UNREACHABLE (fetch failed, 19439ms)
  github.com (web)    : FAIL (fetch failed, 10582ms)

=== verdict ===
  CHANNEL B — the git endpoint is unreachable but the REST API works.
  This is a network-path block, not a git problem: retrying push will not help.
```

**The key insight**: whether the `github.com` **web** page loads and whether **git can push** are
two different network paths. On one measured machine the web page was intermittent,
`api.github.com` answered 200 consistently, and git's `/info/refs?service=git-receive-pack`
timed out five times in a row. When curl and git fail at the same moment, the block is in the
network layer — **retrying is pointless**.

---

## Two channels

| Channel | Condition | Command |
|---|---|---|
| **A. git push** | git endpoint reachable (a 401 still counts as reachable) | `node scripts/gh-push.mjs` |
| **B. REST API** | only api.github.com works | `node scripts/api-push.mjs --message "..."` |

Channel B performs all four steps of a push through the API:
`blob → tree → commit → move the branch ref`.

---

## Quick start

```bash
cd scripts

# 0) diagnose: which channel should this machine use?
node doctor.mjs

# 1) open a tool-drivable browser window (separate profile) and sign in to GitHub — once
node launch-gh.mjs

# 2) create a temporary token through the GitHub web UI (no copy-pasting)
node gh-pat.mjs token

# 3) publish
node api-push.mjs --message "what changed"
#    add --dry-run to see what would be published first
```

**Requirements**: Node.js ≥ 18, git, Windows (token creation needs a debuggable Chromium browser).

---

## Scripts

| Script | Purpose |
|---|---|
| `doctor.mjs` | Check environment, target repo, endpoint reachability, and which channel to use |
| `launch-gh.mjs` | Copy the profile and start a debuggable browser window |
| `gh-pat.mjs` | Drive the GitHub web UI to create a temporary token in `_token.txt` |
| `api-push.mjs` | **Channel B**: publish through the API (recommended, most reliable) |
| `gh-push.mjs` | **Channel A**: create the repo and `git push` |
| `gh-update.ps1` | All-in-one: commit → token → push → verify → destroy token |
| `config.mjs` | Derives the repository from `git remote`; nothing hard-coded |
| `install-skill.mjs` | Copy this skill into the DSH skills directory |

---

## Two design points

**1. It never assumes the remote commit exists locally.**
A commit created through the API cannot be fetched locally while the git endpoint is blocked.
So `api-push.mjs` does not ask git "what changed"; instead it reads the **remote tree**, computes
each local file's blob id the way git does
(`sha1("blob " + byteLength + "\0" + bytes)`), and publishes only the files whose id differs.
Content comes from git objects (`git cat-file blob HEAD:<path>`), not the working tree.

**2. Verification must compare blob ids, not GitHub's zip snapshot.**
`codeload.github.com` is cached and can serve a stale revision. This fooled the tooling once:
the snapshot reported a file as 5345 bytes while the remote actually had 6816 — only the blob-id
comparison proved the remote was in fact correct.

---

## Security rules

- The token is **read from a file only** — never passed as a command-line argument (that leaks
  into shell history and the process list)
- All output is **redacted automatically**: the token and its base64 form become `***`
- The token file and `~/.git-credentials` are **deleted immediately** after use, with `finally`
  so error paths delete them too
- After pushing with credentials embedded in the URL, `.git/config` and `.git/logs` are checked
  and cleaned (the reflog records URLs as well)
- **Never fill in passwords/2FA**: when a login is needed, the skill tells the user exactly which
  window to use
- Users are reminded to clean up unused tokens at https://github.com/settings/tokens

---

## Explaining GitHub to a first-time user

The "hotel key card" analogy works best:

| Concept | Analogy |
|---|---|
| token | A one-time key card: it proves you have access, and **it should be destroyed after use** |
| GitHub session | The front-desk registration: still valid, so a new key card can be issued any time |
| repository | The room: the contents stay there |
| commit / push | Taking a photo for the archive (locally) / sending the archive to the cloud |

**The point**: deleting a token does not revoke your access — as long as the browser is signed in,
you can always mint another one.

---

## Troubleshooting

| Symptom | Real cause | Fix |
|---|---|---|
| `git push` times out after 21 s | git transport endpoint blocked by the network | Use channel B |
| "Connect to GitHub" popup hangs the process | System-level `credential.helper=manager` | Push with `-c credential.helper=` |
| `No anonymous write access` | A 301 redirect dropped the credentials in the URL | Authenticate with `http.extraHeader` instead |
| `SSL: no alternative certificate subject name…` | Connecting to a bare IP; the certificate is for the domain | Use the domain, or a `Host:` header |
| Verification reports "content differs" | codeload snapshot cache | Compare blob ids instead |
| GitHub says "Note has already been taken" | Duplicate token name | Put a second-resolution timestamp in the name |

---

## License

MIT
