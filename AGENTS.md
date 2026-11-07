# AGENTS.md

给所有在本仓库工作的 DSH（或其它 AI）会话的作业规约。**先读这一页，再动手。**

## 这是什么

`dsh-longshot` 是 DeepSeek Harness 的插件：把会话里选中的回合导出成一张纵向 PNG 长图。
Host 半 `lib/index.js`（读会话、渲染 HTML）＋ 浏览器半 `lib/client.js`（按钮、面板、canvas 光栅）。

## 铁律

1. **改了 `src/` 必须 `npm run build` 并提交 `lib/client.js`。** 客户端半是构建产物，
   宿主直接下发它，不构建就等于改了个寂寞。CI 会比对，不一致直接红。
2. **提交前必须 `npm test` 全绿**（Host 冒烟 45 条 + 客户端纯函数 22 条）。
3. **不要提交**：`tmp/`、`harness*`、`chrome-profile/`、任何 token / 私钥 / 会话内容。
4. **不要动用户环境**：不修改 `~/.dsh/profiles/*` 下的任何文件、不改 `cordis.patch.yml`；
   本仓库只负责代码，安装是用户的事。
5. **不要升级依赖 / 引入构建链**。项目的卖点之一就是零依赖；提构建器之前先开 issue 讨论。
6. **破坏用户数据的事一律不做**：不删会话、不写 `companion` 存储域。

## 仓库结构

```
lib/index.js          Host 半（手写，非产物）
lib/client.js         浏览器半（产物，由 scripts/build-client.mjs 生成）
src/raster.js         分片光栅 + 流式 PNG（vendor 自 dsh-companion，MIT，改了要更新 THIRD_PARTY_NOTICES）
src/ui.js             按钮与面板（原生 DOM）
scripts/build-client.mjs   src/* → lib/client.js
scripts/release.mjs        一键发版（见下）
test/smoke.mjs        Host 半 45 条断言
test/client-unit.mjs  客户端纯函数 22 条断言
```

## 常见任务

### 修一个 issue

1. `gh issue view <n> --repo bernardguan/dsh-longshot`（或读 issue 正文）；
2. 起分支：`fix/<n>-短描述` 或 `feat/短描述`；
3. 改代码 → `npm run build` → `npm test`；
4. 提交：`fix: ...` / `feat: ...` / `docs: ...` / `test: ...`（Conventional Commits，正文可中文）；
5. 推分支、开 PR，PR 描述里写「根因 / 改法 / 验证」，附 `Closes #<n>`；
6. **合并由维护者点**，除非用户明确授权 agent 直接合。

### 发版

```bash
node scripts/release.mjs patch "修了 xxx 的 500"     # 或 minor / major
# 脚本会：校验工作区干净 → build → test → bump 版本 → 写 CHANGELOG → commit → tag
# 然后按提示 push（脚本不自动推）：
git push origin main && git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file 发布说明.md
```

### dsh 升级后自检

本插件依赖三个**非公开 API**，dsh 一升级就可能断。按这个顺序查：

| 现象 | 先看哪里 |
|---|---|
| 面板报 404 / 没有 `/longshot/*` | `ctx.webServer.register({ kind: 'prefix' })` 是否还支持 |
| 「长图」按钮不存在 | 槽位 `conversation.chat.assistant-actions` 是否还在（对照 `@deepseek-ai/dsh-client-ui-chat` 的 `lib/client.js`） |
| 回合列表空 / 分类全错 | `sessionQuery.readSession()` 返回的 `events` 形状、块类型（`text` / `reasoning` / `tool-call`）是否变了 |
| 白屏 / 面板渲染失败 | 客户端 bundle 是否还能被 `window.__ModuleLoader__` 接受 |

自检入口：`GET /longshot/ping`（回版本号）、`%TEMP%\dsh-longshot.mounted`（挂载面包屑）。

## 代码风格

- 纯 ESM，无构建期依赖；`lib/index.js` 与 `src/*.js` 手写部分不用 TypeScript。
- 注释写「为什么」，不写「是什么」；用户可见文案用中文，代码标识符用英文。
- 所有进 HTML 的用户文本必须经 `escapeHtml` / `markdownToHtml`，**永不拼接原始 HTML**。
- 新增选项要同时更新：面板、`/render` 参数、README「能力」表、`test/smoke.mjs`。
