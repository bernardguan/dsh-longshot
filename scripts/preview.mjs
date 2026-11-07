/**
 * 预览生成器：把一段固定的样例对话渲染成 HTML，供 headless Chrome 截图检查版式。
 * 用法：node scripts/preview.mjs <输出 html 路径> [宽度]
 */

import { writeFileSync } from 'node:fs'
import { apply } from '../lib/index.js'

const outPath = process.argv[2] ?? 'preview.html'
const width = Number(process.argv[3] ?? 900)

const userMessage = [
  'dsh-companion 的使用方法，如何导出长图？',
].join('\n')

const assistantMessage = [
  '我核对了本机实际安装的插件产物（`dsh-companion` 0.6.0），下面这些按钮与提示文案都来自它的真实代码。',
  '',
  '## 长图导出（最短路径）',
  '',
  '1. **打开要导出的那一个会话**——长图只导出「当前会话」。',
  '2. 点对话页头部操作区的 **「导出对话」**。',
  '3. 弹窗里：',
  '   - **导出格式** 选 `PNG 长图（.png）`',
  '   - 可选 `保留时间戳`（默认开）、`隐私脱敏`（手机号 / 邮箱 / API Key 自动打码）',
  '   - 在 **`导出回合`** 区域逐回合勾选（默认全选）',
  '4. 点 **「导出」**，按钮显示 `正在导出… done/total` 分片进度。',
  '5. 完成后浏览器直接下载 `.png`。',
  '',
  '> 命令面板的 `companion-export` 不要用来导 PNG：命令通道只有文本，二进制交付不了。',
  '',
  '## 光栅机制与边界',
  '',
  '| 项 | 取值 | 影响 |',
  '| --- | --- | --- |',
  '| 宽度 | 800 CSS px × 2x 视网膜 | 实际 1600 px 宽，字号清晰 |',
  '| 高度 | 分片光栅 + 流式 PNG 编码 | PNG 规范无上限，旧版 16000 px 截断已解除 |',
  '| 产品上限 | 200 000 CSS px（≈176 页 A4） | 超过会截断并提示 |',
  '| 批量 | 不支持 PNG | 勾了批量会提示改用 MD/PDF/JSON |',
  '',
  '### 关键实现',
  '',
  '```ts',
  'async function exportLongPng(html, fileName, options) {',
  '  const stage = await RasterStage.create(html, options)',
  '  const encoder = new StreamingPngEncoder(stage.width * 2, stage.totalHeight * 2)',
  '  for await (const piece of iterTiles(stage, options?.signal)) {',
  '    const tile = await stage.tile(piece.offset, piece.height)',
  '    await encoder.pushTile(tile)',
  '    options?.onProgress?.(piece.index + 1, piece.total)',
  '  }',
  '  download(fileName, "image/png", await encoder.finish())',
  '}',
  '```',
  '',
  '## 常见问题',
  '',
  '- 没有按钮：插件客户端半加载失败（CSS module 缺失 / bundle 格式不符）',
  '- 图片尾部被切：会话超过 20 万 CSS px，分回合导或改 PDF',
  '- 一直转圈：光栅某步卡住，点「中止导出」重试',
  '',
  '如果需要，我可以把这个插件的 UI 用原生 JS 重写一版——`dsh-longshot` 就是这个思路。',
].join('\n')

const SESSION = {
  session: {
    id: 'session-preview-0001',
    title: 'dsh-companion 使用方法与长图导出',
    createdAt: Date.UTC(2026, 10, 6, 9, 30, 0),
  },
  events: [
    { type: 'user/message', time: Date.UTC(2026, 10, 6, 9, 30, 0), seq: 1, data: { content: userMessage } },
    { type: 'assistant/message', time: Date.UTC(2026, 10, 6, 9, 31, 0), seq: 2, data: { message: { content: [{ type: 'text', text: assistantMessage }] } } },
    {
      type: 'assistant/message',
      time: Date.UTC(2026, 10, 6, 9, 32, 0),
      seq: 3,
      data: {
        message: {
          content: [
            { type: 'reasoning', text: '先把插件产物翻一遍。' },
            { type: 'text', text: '我先把已安装的插件产物翻一遍，确认客户端半到底缺了什么。' },
            { type: 'tool-call', id: 'call_1', name: 'grep', arguments: '{}' },
            { type: 'tool-call', id: 'call_2', name: 'pwsh', arguments: '{}' },
          ],
        },
      },
    },
    {
      type: 'user/message',
      time: Date.UTC(2026, 10, 6, 9, 32, 30),
      seq: 4,
      data: { content: [{ type: 'text', text: '<system-reminder>\nThe following workspace instructions may be relevant to your task.\n</system-reminder>' }] },
    },
    { type: 'user/message', time: Date.UTC(2026, 10, 6, 9, 33, 0), seq: 5, data: { content: '确实没有看到按钮。' } },
    {
      type: 'assistant/message',
      time: Date.UTC(2026, 10, 6, 9, 35, 0),
      seq: 6,
      data: {
        message: {
          content: [
            { type: 'tool-call', name: 'grep' },
            { type: 'text', text: '找到了：`lib/client/components/` 下只有 7 个 `.js` + 7 个 `.d.ts`，**没有一个 `.css`**，而每个组件第一行都写着 `import styles from "./X.module.css"`。\n\n整个包里 `.css` 文件数为 **0**——浏览器加载时 import 链直接断掉，所以客户端插件整体不加载。' },
          ],
        },
      },
    },
  ],
}

let handler
apply({
  effect: (fn) => {
    fn()
    return () => {}
  },
  webServer: {
    register: (route) => {
      handler = route.handler
      return () => {}
    },
  },
  sessionQuery: { readSession: async () => SESSION },
  logger: { warn: () => {} },
})

const { Readable } = await import('node:stream')
const req = Readable.from([Buffer.from(JSON.stringify({ sessionId: SESSION.session.id, width, redact: true }))])
req.method = 'POST'
req.url = '/longshot/render'
let body = ''
const res = {
  headersSent: false,
  writeHead() {
    res.headersSent = true
  },
  end(chunk) {
    if (chunk !== undefined)
      body += chunk.toString()
  },
}
await handler(req, res)
const payload = JSON.parse(body)
if (payload.error)
  throw new Error(payload.error)
writeFileSync(outPath, payload.html, 'utf8')
console.log(`${outPath}  ${payload.stats.turns} turns / ${payload.stats.chars} chars / width ${payload.stats.width}`)
