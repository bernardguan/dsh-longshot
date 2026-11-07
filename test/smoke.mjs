/**
 * 冒烟测试：不启动桌面端，直接把 lib/index.js 当成插件装到假 ctx 上，
 * 走一遍「读会话 → 抽回合 → 分类 → 渲染 HTML」全链路，并校验关键结构。
 *
 * 用法：node test/smoke.mjs
 */

import { Readable } from 'node:stream'
import { apply } from '../lib/index.js'

const ANSWER_MARKDOWN = [
  '结论如下：',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  '| A | 1 |',
  '',
  '### 代码',
  '',
  '```js',
  'const a = "<b>not html</b>"',
  '```',
  '',
  '> 引用一段话',
  '',
  '联系我：13800138000 / a.b@example.com / sk-abcdefghijklmnop1234',
].join('\n')

const SESSION = {
  session: {
    id: 'session-test-0001',
    title: '长图导出测试 / QA <script>alert(1)</script>',
    createdAt: Date.UTC(2026, 10, 6, 9, 0, 0),
  },
  events: [
    {
      type: 'user/message',
      time: Date.UTC(2026, 10, 6, 9, 1, 0),
      seq: 1,
      data: { content: [{ type: 'text', text: '帮我看看这张表，然后给个结论。' }] },
    },
    {
      type: 'assistant/message',
      time: Date.UTC(2026, 10, 6, 9, 1, 30),
      seq: 2,
      data: {
        message: {
          content: [
            { type: 'reasoning', text: '先读表，再算一遍。' },
            { type: 'text', text: '我先读一下数据。' },
            { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"ls"}' },
          ],
        },
      },
    },
    {
      type: 'user/message',
      time: Date.UTC(2026, 10, 6, 9, 1, 40),
      seq: 3,
      data: { content: [{ type: 'text', text: '<system-reminder>\nThe following workspace instructions may be relevant…\n</system-reminder>' }] },
    },
    {
      type: 'tool/result',
      time: Date.UTC(2026, 10, 6, 9, 1, 50),
      seq: 4,
      data: {},
    },
    {
      type: 'assistant/message',
      time: Date.UTC(2026, 10, 6, 9, 2, 0),
      seq: 5,
      data: { message: { content: [{ type: 'reasoning', text: '整理成表。' }, { type: 'text', text: ANSWER_MARKDOWN }] } },
    },
  ],
}

let handler
const ctx = {
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
  sessionQuery: {
    readSession: async (id) => {
      if (id !== SESSION.session.id)
        throw new Error('session not found')
      return SESSION
    },
  },
  logger: { warn: () => {} },
}

apply(ctx)
if (typeof handler !== 'function')
  throw new Error('路由未注册')

/** 伪造请求（只用到 method/url 与可读流）。 */
function fakeRequest(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  return req
}

/** 伪造响应，收集状态码与响应体。 */
function fakeResponse() {
  const state = { status: 0, headers: {}, body: '' }
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
      res.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined)
        state.body += chunk.toString()
    },
  }
  return { res, state }
}

async function call(method, url, body) {
  const { res, state } = fakeResponse()
  await handler(fakeRequest(method, url, body), res)
  return { status: state.status, json: state.body === '' ? undefined : JSON.parse(state.body) }
}

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) })
  if (!condition)
    console.error(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// --- 基础 ---
const ping = await call('GET', '/longshot/ping')
check('ping 200', ping.status === 200 && ping.json.ok === true)

// --- 回合清单与分类 ---
const turnList = await call('POST', '/longshot/turns', { sessionId: SESSION.session.id })
check('turns 200', turnList.status === 200, JSON.stringify(turnList.json).slice(0, 160))
const turns = turnList.json?.turns ?? []
check('turns 数量=4（跳过空工具结果）', turns.length === 4, String(turns.length))
check('分类为用户/后台/上下文/回答', turns.map((t) => t.kind).join(',') === 'user,step,context,answer', turns.map((t) => t.kind).join(','))
check('后台回合带工具名', JSON.stringify(turns[1]?.tools) === '["pwsh"]', JSON.stringify(turns[1]?.tools))
check('回答回合无工具', Array.isArray(turns[3]?.tools) && turns[3].tools.length === 0)
check('turns 不带正文', turns[3]?.text === undefined)
check('turns 带预览', typeof turns[3]?.preview === 'string' && turns[3].preview.length > 0)

// --- 只导正文（用户 + 回答）---
const main = await call('POST', '/longshot/render', { sessionId: SESSION.session.id, turns: [0, 3] })
check('正文导出 200', main.status === 200)
check('正文导出 2 条', main.json?.stats?.turns === 2, String(main.json?.stats?.turns))
const mainHtml = main.json.html
check('含用户消息', mainHtml.includes('帮我看看这张表'))
check('含最终回答', mainHtml.includes('结论如下'))
check('不含后台步骤正文', !mainHtml.includes('我先读一下数据'))
check('不含注入上下文', !mainHtml.includes('workspace instructions'))
check('表格渲染', mainHtml.includes('<table>') && mainHtml.includes('<th>项</th>'))
check('代码块渲染', mainHtml.includes('<pre><code class="language-js">'))
check('代码内容已转义', mainHtml.includes('&lt;b&gt;not html&lt;/b&gt;'))
check('引用块', mainHtml.includes('<blockquote>'))
check('标题注入已转义', mainHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !mainHtml.includes('<script>alert(1)'))
check('宽度写入版式', mainHtml.includes('width:900px'))
check('徽章：用户/回答', mainHtml.includes('who user') && mainHtml.includes('who answer'))
check('文件名标注范围', String(main.json.fileName).includes('选中2条'), main.json.fileName)

// --- 勾选后台与上下文：默认压成一行 ---
const compact = await call('POST', '/longshot/render', { sessionId: SESSION.session.id, turns: [0, 1, 2, 3] })
const compactHtml = compact.json.html
check('全选 4 条', compact.json?.stats?.turns === 4)
check('后台/上下文走紧凑行', compactHtml.includes("class=\"turn assistant compact\"") && compactHtml.includes('who step') && compactHtml.includes('who context'))
check('紧凑行带工具名', compactHtml.includes('工具 pwsh'))
check('紧凑行有摘要', compactHtml.includes('compact-snippet'))

const expanded = await call('POST', '/longshot/render', { sessionId: SESSION.session.id, turns: [1], compact: false })
check('关掉紧凑后后台回合展开', expanded.json.html.includes('我先读一下数据') && expanded.json.html.includes('who step') && !expanded.json.html.includes("class=\"turn assistant compact\""))

// --- 脱敏 ---
const redacted = await call('POST', '/longshot/render', { sessionId: SESSION.session.id, turns: [3], redact: true })
const redactedHtml = redacted.json?.html ?? ''
check('手机号脱敏', redactedHtml.includes('［手机号已脱敏］') && !redactedHtml.includes('13800138000'))
check('邮箱脱敏', redactedHtml.includes('［邮箱已脱敏］'))
check('API Key 脱敏', redactedHtml.includes('［API Key 已脱敏］'))

// --- 工具调用行（可选）---
const withTools = await call('POST', '/longshot/render', { sessionId: SESSION.session.id, turns: [1], tools: true, compact: false })
check('工具调用可保留为正文行', (withTools.json?.html ?? '').includes('工具调用：<code>pwsh</code>'))

// --- 回合选择的边界 ---
const emptySelection = await call('POST', '/longshot/render', { sessionId: SESSION.session.id, turns: [] })
check('空选择 400（不悄悄退回全量）', emptySelection.status === 400)
const bogus = await call('POST', '/longshot/render', { sessionId: SESSION.session.id, turns: [99] })
check('越界下标 400', bogus.status === 400)
const oneOutOfRange = await call('POST', '/longshot/render', { sessionId: SESSION.session.id, turns: [0, 99] })
check('越界下标被忽略、其余照导', oneOutOfRange.status === 200 && oneOutOfRange.json?.stats?.turns === 1)

// --- 错误路径 ---
const missing = await call('POST', '/longshot/render', { sessionId: 'nope' })
check('未知会话 404', missing.status === 404)
const noId = await call('POST', '/longshot/render', {})
check('缺 sessionId 400', noId.status === 400)
const notFound = await call('GET', '/longshot/nothing')
check('未知路由 404', notFound.status === 404)

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0)
  process.exitCode = 1
else
  console.log('冒烟测试全部通过')
