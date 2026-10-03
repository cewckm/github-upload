# github-upload

**把本地代码或技能包发布到 GitHub —— 包括在「最难」的条件下。**

处理的都是真实踩过的坑：用户从没用过 GitHub、机器上没有任何 git 凭据、
`git push` 被网络阻断、认证弹窗卡死进程、以及校验时被 GitHub 的缓存骗过。

---

## 它解决什么问题

`git push` 失败时，外表现象都一样（"push failed"），但真正原因可能完全不同。
这个技能第一步先**体检**，把原因区分开：

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

**关键认知**：`github.com` 的**网页**通不通，和 **git 能不能推**，是两条不同的网络路径。
实测过一台机器：网页时通时不通、`api.github.com` 稳定 200、
而 git 的 `/info/refs?service=git-receive-pack` 连续超时。
curl 和 git 同时失败 → 拦截在网络层，**重试没有意义**。

---

## 两条通道

| 通道 | 条件 | 命令 |
|---|---|---|
| **A. git push** | git 端点可达（返回 401 也算可达） | `node scripts/gh-push.mjs` |
| **B. REST API** | 只有 api.github.com 通 | `node scripts/api-push.mjs --message "..."` |

通道 B 用 API 完成 push 的全部四步：`blob → tree → commit → 移动分支引用`。

---

## 快速开始

```bash
cd scripts

# 0) 体检，判断该走哪条通道
node doctor.mjs

# 1) 打开一个「可被工具驱动」的浏览器窗口（独立 profile），登录 GitHub —— 只需一次
node launch-gh.mjs

# 2) 通过 GitHub 网页自动生成临时 token（不用手动复制粘贴）
node gh-pat.mjs token

# 3) 发布
node api-push.mjs --message "本次改了什么"
#    先看看会发什么：加 --dry-run
```

**前提**：Node.js ≥ 18、git、Windows（token 生成依赖一个可调试的 Chromium 浏览器）。

---

## 脚本

| 脚本 | 作用 |
|---|---|
| `doctor.mjs` | 体检：环境、目标仓库、端点可达性、该走哪条通道 |
| `launch-gh.mjs` | 复制 profile 并启动一个可调试的浏览器窗口 |
| `gh-pat.mjs` | 驱动 GitHub 网页生成临时 token 写到 `_token.txt` |
| `api-push.mjs` | **通道 B**：通过 API 发布（推荐，最可靠） |
| `gh-push.mjs` | **通道 A**：建仓库 + `git push` |
| `gh-update.ps1` | 一条龙：提交 → 生成 token → 推送 → 校验 → 销毁 token |
| `config.mjs` | 从 `git remote` 自动识别仓库，无需硬编码 |
| `install-skill.mjs` | 把这个技能复制进 DSH 的技能目录 |

---

## 设计上的两个要点

**1. 不依赖本地存在远端提交。**
API 在服务端造的提交，本地 `git fetch` 在 git 端点被阻断时拿不到。
所以 `api-push.mjs` 不问 git "什么变了"，而是：
读**远端树** → 对每个本地文件按 git 算法算 blob id
（`sha1("blob " + 字节长度 + "\0" + 内容)`）→ 只发布 id 不同的文件。
内容取自 git 对象（`git cat-file blob HEAD:<path>`），不是工作区。

**2. 校验必须用 blob id，不能用 GitHub 的 zip 快照。**
`codeload.github.com` 有缓存，会返回旧版本。
实测被它骗过一次：快照说某文件 5345 字节、实际远端是 6816 字节，
最后用 blob id 对比才确认远端其实是对的。

---

## 安全约定

- token **只从文件读**，绝不放进命令行参数（会进 shell 历史和进程列表）
- 所有输出**自动脱敏**：token 与其 base64 形式替换为 `***`
- 用完**立刻删除** token 文件与 `~/.git-credentials`，用 `finally` 保证异常路径也删
- 用 URL 内嵌凭据推送后，检查并清理 `.git/config` 与 `.git/logs`（reflog 也会记录 URL）
- **不代填密码/2FA**：需要登录时，明确告诉用户在哪个窗口操作
- 建议用户定期去 https://github.com/settings/tokens 清理不用的 token

---

## 给第一次用 GitHub 的人解释

用「酒店房卡」类比最有效：

| 概念 | 类比 |
|---|---|
| token | 一次性房卡：证明你有权限，**用完就该销毁** |
| GitHub 登录态 | 前台登记：还在，所以随时能再开一张新房卡 |
| 仓库 | 房间：内容一直都在 |
| commit / push | 拍照存档（本地）/ 把存档送上云端 |

**要点**：删掉 token 不等于失去权限——只要浏览器还登录着，就能再生成一张。

---

## 常见故障

| 现象 | 真正原因 | 处理 |
|---|---|---|
| `git push` 超时 21 秒 | git 传输端点被网络阻断 | 走通道 B |
| 弹出 "Connect to GitHub" 并卡住 | 系统级 `credential.helper=manager` | push 时加 `-c credential.helper=` |
| `No anonymous write access` | 301 重定向丢了 URL 里的凭据 | 改用 `http.extraHeader` 传认证 |
| `SSL: no alternative certificate subject name…` | 用 IP 直连，证书校验的是域名 | 别用 IP，用域名或 `Host:` 头 |
| 校验说"内容不同" | codeload 快照缓存 | 改用 blob id 对比 |
| GitHub 报 "Note has already been taken" | token 名字重复 | 名字带秒级时间戳 |

---

## License

MIT
