# 维护手册

给维护者（以及代替维护者办事的 DSH 会话）看的操作手册：版本怎么走、issue 怎么收、发布怎么发、出错怎么退。

## 三层能力，缺什么补什么

| 能力 | 现状 | 缺口 |
|---|---|---|
| 代码版本管理（commit / 分支 / tag / push） | ✅ 已具备：便携 git + SSH 密钥，无需联网授权 | 无 |
| 读 GitHub（issue / CI 状态 / 仓库信息） | ✅ 匿名 API 可读（60 次/小时） | 高频读会被限流 |
| 写 GitHub（评论 / 打标签 / 关 issue / 建 Release / 合并 PR） | ❌ 需要凭据 | 见下方「写入通道」 |

### 写入通道（三选一）

1. **`gh` CLI + 设备码登录（推荐）**
   ```bash
   gh auth login --web --git-protocol ssh
   ```
   浏览器输入一次性码即可，token 由 gh 自己保管在系统密钥链里，**不经过对话**。
   装好之后 agent 就能执行 `gh issue close`、`gh pr merge`、`gh release create` 等。
2. **细粒度 PAT**（没有 gh 时的备选）
   建一个只勾 `issues:write` + `contents:write` 的 fine-grained token，存到仓库**外**的
   `%USERPROFILE%\.dsh-longshot\github-token.txt`，脚本读环境变量或该文件。
   优点：可控可撤销；缺点：明文落盘，别提交、别贴进对话。
3. **纯人工**（零配置）
   agent 只负责改代码 + 推分支/打标签，评论、合并、建 Release 都由维护者点。

## 日常流程

### 收到一个 issue

1. 读：`gh issue view <n> --repo bernardguan/dsh-longshot`
2. 判定：能复现 → 起分支 `fix/<n>-短描述`；不能复现 → 用 `gh issue comment` 补充信息清单（版本、`/longshot/ping`、控制台报错）。
3. 修 + 验证：`npm run build && npm test`，必要时跑 `scripts/verify-browser.mjs` 那条真浏览器链路。
4. 提交并推分支 → 开 PR（模板会自动带「根因 / 改法 / 验证 / Closes #n」）。
5. 合并后如果用户可见，走一次发版。

### 发版

```bash
node scripts/release.mjs patch "修复空会话导出 500"   # minor / major 同理
git push origin main && git push origin v1.0.2
gh release create v1.0.2 --title v1.0.2 --notes-file <发布说明>.md
```

`release.mjs` 会：校验工作区干净 → 构建 → 跑两套测试 → 同步 `package.json` 与 `lib/index.js` 的 VERSION
→ 在 CHANGELOG 顶部插段落 → commit `chore(release): vX.Y.Z` → 打 annotated tag。
**它不自动 push**，这是刻意的。

> 如果 `git` 不在 PATH（例如用的是便携 MinGit），先指过去，脚本会用它：
>
> ```powershell
> $env:GIT_BIN = 'C:\path\to\git.exe'      # 本机是 <tools>\git\cmd\git.exe
> ```


版本号怎么选：

| 变更 | 版本 |
|---|---|
| 只改文档 / 测试 / 内部重构，行为不变 | patch |
| 新功能、新选项（向后兼容） | minor |
| 跟随 dsh 改 API、改路由、改配置字段 | major，并在 release notes 写清迁移方式 |

### 合并与保护策略（建议）

- `main` 是唯一发布分支，tag 只在 `main` 上打。
- 建议在 GitHub 上给 `main` 开 branch protection：要求 CI 通过、禁止直推（小项目也可先只开「Require status checks」）。
- 破坏性改动先开 issue 讨论，别直接进 `main`。

## 出问题怎么退

| 场景 | 处理 |
|---|---|
| 刚发的版本有严重 bug | 把问题版本从 latest 标记撤下（Release 页面 edit → 取消 latest），修好后发 patch；**不要删 tag**（删了会让已安装的人无法 diff） |
| tag 打错（指错 commit） | `git tag -d vX.Y.Z && git tag -a vX.Y.Z -m ... && git push --force origin vX.Y.Z`（仅在 Release 尚未发布时） |
| 改动要整体回滚 | `git revert <sha>` 发一个 patch 版本；不要 `reset --hard` 推 main |
| 插件在用户机器上崩了 | 让用户看 `%TEMP%\dsh-longshot.mounted` 有没有、`/longshot/ping` 通不通，再对照 AGENTS.md 的「dsh 升级后自检」表 |

## dsh 升级后的兼容性巡检

本插件依赖三个非公开 API（`ctx.webServer.register`、`ctx.sessionQuery.readSession` 的形状、
`conversation.chat.assistant-actions` 槽位）。每次 dsh 大版本更新后：

1. `npm test`（Host 冒烟会暴露形状变化）；
2. 真机点一次「长图」，确认按钮、回合列表、导出都正常；
3. 若断，按 AGENTS.md 的表定位，改完发 patch，并在 CHANGELOG 写明适配的 dsh 版本。

## 仓库卫生

- `lib/client.js` 是产物但必须提交（宿主直接下发），CI 会校验它与 `src/` 一致。
- 提交前 `git status` 自查：不该出现 `tmp/`、`harness*`、截图、日志、任何密钥。
- 私钥位置：`~/.ssh/` 或便携目录；**永远不进仓库**。
- 依赖：目前零运行时依赖，保持这一点。
