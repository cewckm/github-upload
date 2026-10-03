---
name: github-upload
description: 把本地代码或技能包发布到 GitHub——包括在没有 git 凭据、git push 被网络阻断、用户从没用过 GitHub 的情况下，完成建仓库、认证、提交、推送与校验。
whenToUse: 用户要求把某个项目/插件/技能上传或发布到 GitHub、创建仓库、更新已有仓库，或在 git push 失败、认证失败、"Connect to GitHub" 弹窗卡住、github.com 连不上时使用。
---

# 发布到 GitHub

目标：把本地的一个 git 仓库发布到 GitHub，并在失败时**诊断出真正的失败原因**而不是反复重试。

脚本在 `{{SCRIPTS_DIR}}`。

---

## 零、先做一次体检（30 秒，能省掉后面所有猜测）

```bash
node "{{SCRIPTS_DIR}}/doctor.mjs"
```

它检查并报告：git 是否可用、目标仓库与远端、**git 传输端点是否可达**、
认证方式、以及该走哪条发布通道。**先跑它，再决定用下面哪条路。**

---

## 一、两条发布通道，先判断走哪条

| 通道 | 何时用 | 判据 |
|---|---|---|
| **A. git push** | 正常情况 | `curl` 能拿到 `<repo>/info/refs?service=git-receive-pack` 的 HTTP 200 |
| **B. REST API** | git 端点不可达时 | 上一条超时/000，但 `api.github.com` 返回 200 |

**关键认知**：`github.com` 的**网页**通不通，和 **git 能不能推**是两件事。
实测过一台机器：网页时通时不通、`api.github.com` 稳定 200、
而 git 传输端点 `/info/refs?service=git-receive-pack` **连续 5 次超时**。
curl 和 git 同时失败 → 拦截在网络层，不是客户端问题，重试无用。

---

## 二、通道 B 的完整流程（最常用，因为最可靠）

```bash
cd "{{SCRIPTS_DIR}}"

# 1) 打开一个「可被工具驱动」的浏览器窗口并登录 GitHub（只需一次）
#    注意：已运行的浏览器会忽略调试端口参数，所以必须用独立 profile 复制一份
node launch-gh.mjs

# 2) 通过 GitHub 网页自动生成一个临时 token（不粘贴、不落库、用完即删）
node gh-pat.mjs token

# 3) 发布：从远端树比对差异 → 建 blob/tree/commit → 移动分支引用
node api-push.mjs --message "本次改了什么"
```

`api-push.mjs` 的行为要点：

- **不依赖本地存在远端提交**。API 在服务端造的提交，本地 `git fetch` 在 git 端点被阻断时拿不到，
  所以它改为：读**远端树** → 对每个本地文件按 git 算法算 blob id
  （`sha1("blob " + 字节长度 + "\0" + 内容)`）→ 只发布 id 不同的文件。
- **内容取自 git 对象**（`git cat-file blob HEAD:<path>`），不是工作区，
  所以未提交的改动和行尾差异不会混进去。
- **不删除远端文件**。远端有、本地没跟踪的文件保持原样（删除是破坏性操作，不该由"发布"顺手做）。
- 发布后在 `.git/last-api-push.json` 留一份记录（因为此时本地 git 与远端不再一致）。
- 无论成败都**删除 token 文件**。

先用 `--dry-run` 看会发布什么，确认无误再真发。

---

## 三、通道 A（git push）的坑

如果体检显示 git 端点可达，可以正常 push，但要避开这几个坑：

| 现象 | 原因 | 处理 |
|---|---|---|
| 弹出 **"Connect to GitHub"** 图形窗口并卡住 | 系统级 `credential.helper=manager`（Git for Windows 自带）抢走了认证 | push 时加 `-c credential.helper=`，并自行提供凭据 |
| `No anonymous write access` | 用了 `www.github.com` 等会 301 的主机，**重定向会丢掉 URL 里的用户名密码** | 改用请求头认证：`-c "http.extraHeader=Authorization: Basic <base64(user:token)>"`（头能穿过重定向） |
| `SSL: no alternative certificate subject name matches target ipv4 address` | 直接连 IP，证书校验的是域名 | 不要用 IP 直连；改用 `Host:` 头或换回域名 |
| `Failed to connect to github.com port 443 after 21s` | git 传输端点被网络阻断 | 换通道 B |
| `git push` 卡住不返回 | 在等交互式输入 | 检查是否有凭据弹窗被最小化；用 `GIT_TERMINAL_PROMPT=0` 让它直接失败而不是挂起 |

**认证格式**：HTTPS 推送用 `<GitHub用户名>:<token>`；
`x-access-token:<token>` 对 API 有效，对普通 push 不一定被接受。

---

## 四、生成 token（无 gh CLI 时）

`gh-pat.mjs` 通过驱动 GitHub 网页完成，不需要用户手动复制粘贴：

1. 确认浏览器已登录（没有则提示用户登录——**密码/2FA 必须由用户自己输入，不要代填**）
2. 打开 `https://github.com/settings/tokens/new`
3. 填 Note（**必须唯一**：GitHub 拒绝重名，所以名字带秒级时间戳）
4. 勾选 `repo` 权限
5. 点 Generate token
6. 从结果页抓取 `ghp_…` 写入 `_token.txt`

失败时它会把 GitHub 页面上的**实际提示**（"Note has already been taken"、限流横幅、
2FA 提示）打印出来——不要只报"未抓到 token"，那样无法定位。

**替代方案**（用户愿意自己操作时）：让用户建一个长期 token，
配合 `git config --global credential.helper manager`，以后就不用每次生成。

---

## 五、把技能包做成可发布的仓库

一个技能包仓库的最小结构：

```
<repo>/
├── README.md            说明它是什么、怎么用、有什么限制
├── LICENSE              MIT 之类
├── .gitignore           排除本地状态、密钥、缓存
├── plugin/              如果是 DSH 插件：package.json + index.js + install.mjs
├── skill/SKILL.md       技能正文（frontmatter 必须有 name 和 description）
├── scripts/             可直接运行的实现
└── docs/                深入说明
```

`.gitignore` **必须**包含：`_token.txt`、`.git-credentials`、`config.json`、
运行产生的数据目录、以及任何临时脚本。**密钥永远不进仓库。**

技能名必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（小写字母、数字、连字符）。

---

## 六、发布后的校验（必做，不能只看"命令返回 0"）

```bash
# 远端文件清单与每个文件的 blob id —— API 是权威来源
node -e "fetch('https://api.github.com/repos/OWNER/REPO/git/trees/main?recursive=1')
  .then(r=>r.json()).then(j=>console.log(j.tree.filter(n=>n.type==='blob').length + ' blobs'))"
```

把远端每个 blob 的 sha 与本地 `git hash-object <file>` 对比，**逐文件一致**才算成功。

⚠️ **不要用 GitHub 的 zip 快照（codeload）做校验**：它有缓存，
会返回旧版本，导致"内容不一致"的假报警。实测被这个骗过一次——
快照说 5345 字节、实际远端是 6816 字节，最后用 blob id 对比才确认其实是一致的。

---

## 七、命令速查

| 命令 | 作用 |
|---|---|
| `node doctor.mjs` | 体检：git 可用性、端点可达性、该走哪条通道 |
| `node launch-gh.mjs` | 打开可被驱动的浏览器窗口（独立 profile，供 GitHub 操作用） |
| `node gh-pat.mjs token` | 网页自动生成临时 token |
| `node gh-push.mjs` | 通道 A：建仓库并 `git push` |
| `node api-push.mjs --message "..."` | 通道 B：通过 API 发布（推荐） |
| `node api-push.mjs --dry-run` | 只显示会发布什么，不发送 |
| `powershell gh-update.ps1 -Message "..."` | 提交 + 认证 + 发布 + 校验 一条龙 |

---

## 八、安全约定（每次都要遵守）

1. **token 只从文件读**，绝不放进命令行参数（会进 shell 历史与进程列表）。
2. **打印输出必须脱敏**：把 token 与其 base64 形式替换成 `***` 后再输出。
3. **用完立刻删除** token 文件与 `~/.git-credentials`；用 `finally` 保证异常路径也删。
4. **不留 git 痕迹**：URL 里内嵌过凭据后，检查并清理 `.git/config`、`.git/logs`（reflog 也会记录 URL）。
5. **不要代填密码/2FA**。需要用户登录时，明确告诉用户在哪个窗口操作。
6. 提醒用户定期去 `https://github.com/settings/tokens` 清理不再需要的 token。

---

## 九、给第一次用 GitHub 的用户解释时

用「酒店房卡」类比最有效：

| 概念 | 类比 |
|---|---|
| token | 一次性房卡：用来证明你有权限，**用完就该销毁** |
| GitHub 登录态 | 前台登记：还在，所以随时能再开一张新房卡 |
| 仓库 | 房间：内容一直都在 |
| commit / push | 拍照存档（本地）/ 把存档送上云端 |

**要点**：删掉 token 不等于失去权限——只要浏览器还登录着，就能再生成一张。

---

## 十、排错对照表

| 现象 | 真正的原因 | 处理 |
|---|---|---|
| `git push` 超时 21 秒 | git 传输端点被网络阻断 | 走通道 B（API） |
| `Authentication failed` | 用户名格式不对 / token 权限不足 | HTTPS 用 `<用户名>:<token>`；token 需 `repo` 权限 |
| `No anonymous write access` | 301 重定向丢了 URL 凭据 | 改请求头认证 |
| 弹窗卡住整个进程 | Credential Manager 抢占 | `-c credential.helper=` |
| 页面打不开但 API 正常 | 网页路径与 API 路径的拦截策略不同 | 以 API 结果为准 |
| 校验显示"内容不同" | codeload 快照缓存 | 改用 blob id 对比 |
| `update-ref` 报对象不存在 | 远端提交是 API 造的，本地没有 | 不要伪造本地引用；用 `.git/last-api-push.json` 记录 |
| GitHub 报 "Note has already been taken" | token 名字重复 | 名字带秒级时间戳 |
