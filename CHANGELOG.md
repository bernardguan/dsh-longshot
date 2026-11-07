# Changelog

本项目从 1.0.0 起按 [Semantic Versioning](https://semver.org/lang/zh-CN/) 记版本；
破坏性变更（dsh 侧 API 变动、配置字段改名）会在小版本号里明确标出。

## 1.0.1

测试补强，行为无变化。

- 长图高度上限的逻辑抽成纯函数 `planStageHeight()`，可在 Node 里单测 200000 / 200001 这类边界，
  不必为了验证截断真去跑一张 40 万像素高的 PNG。
- 新增 `test/client-unit.mjs`：22 条断言，覆盖高度上限与截断标志、回合类型判定、
  以及 bundle 契约（`inject`、`apply`、`__ModuleLoader__` 注册 id）。
- 冒烟测试扩到 45 条：新增「分类边界」样例会话，覆盖
  纯工具步骤不成行、工具名去重、句中提及 `system-reminder` 不算注入、
  `Current runtime context.` 与 `Time sampled while preparing turn` 判定为上下文。
- bundle 新增只读测试钩子 `exports.__test`（运行时不使用）。

## 1.0.0

首个公开版本。功能与 0.3.0 一致，补齐了发布所需的东西：`LICENSE`、第三方代码声明、
bundle 补丁、CI、双语文档、可移植脚本。

### 功能

- **长图导出**：选中若干回合 → 一张纵向 PNG（2x 视网膜，版式宽 720 / 900 / 1080）。
- **入口**：每条助手消息的操作图标行里的「长图」（`conversation.chat.assistant-actions` 槽），不额外占用顶部按钮。
- **回合分类**：`用户` / `回答` / `后台步骤` / `注入上下文` 四类徽章；默认只导出前两类。
- **紧凑渲染**：后台步骤与注入上下文默认压成一行（工具名 + 字数 + 一句摘要）。
- **选项**：保留时间戳、隐私脱敏（手机号 / 邮箱 / 身份证 / 银行卡 / 地址 / API Key / JWT）、版式宽度。
- **无打印对话框**：canvas 分片光栅 + 流式 PNG 编码，PNG 规范无高度上限；产品上限 20 万 CSS px（≈176 页 A4），超出会明确提示截断。

### 已知限制

- 依赖三个非正式对外 API：`ctx.webServer.register`（prefix 路由）、`ctx.sessionQuery.readSession` 的返回结构、槽位 `conversation.chat.assistant-actions`。dsh 改版可能失效，实测通过于 `@deepseek-ai/dsh` 0.2.1-rc.2 / Engineer Workbench 2.0.18。
- 仅本机使用：路由受宿主浏览器信任栅栏保护，未做额外鉴权，不要挂到局域网。
- 不含 PDF / Markdown 导出（那是另一个插件的能力）。
