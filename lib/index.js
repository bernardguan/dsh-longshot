/**
 * dsh-longshot —— 会话长图导出（Host 半）。
 *
 * 职责边界：本半只做「把一条会话变成一份自包含的打印式 HTML」，
 * 真正的光栅化在浏览器侧完成（canvas 只能在那里跑）。这样服务端不需要
 * 任何图像依赖，客户端也不需要访问会话存储。
 *
 * 端点（同源，前缀 /longshot）：
 *   GET  /longshot/ping    健康检查（自测用）
 *   POST /longshot/turns   { sessionId } → { turns: [{ index, role, time, preview, chars }] }
 *   POST /longshot/render  { sessionId, turns?, timestamps?, redact?, tools?, width? }
 *                          → { fileName, title, html, stats }
 *                          turns 为原始回合下标数组；缺省表示全篇。
 *
 * 约定：
 * - 只读会话，不写任何存储；
 * - 全部用户文本经 HTML 转义后再进 Markdown 渲染，不信任任何输入；
 * - 出错一律返回 { error } + 恰当状态码，不把内部堆栈暴露给浏览器。
 *
 * @module dsh-longshot
 */

import { Buffer } from 'node:buffer'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 插件名（与 package.json 的 name 一致）。 */
export const name = 'dsh-longshot'
/** 依赖的宿主服务：读会话、挂 HTTP 路由。 */
export const inject = ['sessionQuery', 'webServer']

/** 版本号，随 /ping 返回，方便确认装的是哪一份。 */
const VERSION = '1.0.1'
/** 路由前缀（与客户端 fetch 的路径一致）。 */
const BASE = '/longshot'
/** 请求体上限：渲染参数很小，1 MiB 足够，防滥用。 */
const MAX_BODY_BYTES = 1024 * 1024
/** 长图版式默认宽度（CSS px）。 */
const DEFAULT_WIDTH = 900

/**
 * 插件入口：注册私有 HTTP 前缀路由。
 *
 * 顺带留一条「已挂载」面包屑（临时目录下一个几十字节的文件）：桌面端把网关请求
 * 拦在浏览器能力栅栏后面，命令行无法直接探活，这条面包屑让「插件有没有装上」
 * 这个问题能在宿主日志之外被独立回答。设 `DSH_LONGSHOT_NO_MARKER=1` 可关掉。
 * @param ctx Cordis 上下文。
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: (req, res) => handleRequest(ctx, req, res),
  }), 'dsh-longshot: http route')
  markMounted()
}

/**
 * 写「已挂载」面包屑（失败静默：这只是诊断便利，不该影响插件加载）。
 */
function markMounted() {
  if (process.env.DSH_LONGSHOT_NO_MARKER === '1')
    return
  try {
    writeFileSync(join(tmpdir(), 'dsh-longshot.mounted'), `${new Date().toISOString()} pid=${process.pid} version=${VERSION}\n`, 'utf8')
  } catch {
    // 忽略：临时目录不可写时静默降级，插件本身不受影响。
  }
}

/**
 * 带状态码的业务错误（HTTP 层统一收敛为 { error }）。
 */
class HttpError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'LongshotHttpError'
    this.status = status
  }
}

/**
 * 路由分发。
 * @param ctx Cordis 上下文。
 * @param req Node 请求。
 * @param res Node 响应。
 */
async function handleRequest(ctx, req, res) {
  let pathname
  try {
    pathname = new URL(req.url ?? '/', 'http://longshot.invalid').pathname
  } catch {
    sendJson(res, 400, { error: '非法的请求地址' })
    return
  }
  const sub = pathname.slice(BASE.length) || '/'
  const method = req.method ?? 'GET'
  try {
    if (method === 'GET' && (sub === '/ping' || sub === '/ping/')) {
      sendJson(res, 200, { ok: true, name, version: VERSION, width: DEFAULT_WIDTH })
      return
    }
    if (method === 'POST' && (sub === '/turns' || sub === '/turns/')) {
      const input = await readJsonBody(req)
      sendJson(res, 200, await buildTurnsPayload(ctx, input))
      return
    }
    if (method === 'POST' && (sub === '/render' || sub === '/render/')) {
      const input = await readJsonBody(req)
      sendJson(res, 200, await buildRenderPayload(ctx, input))
      return
    }
    sendJson(res, 404, { error: `没有这条接口：${method} ${sub}` })
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    const message = error instanceof HttpError
      ? error.message
      : `长图渲染失败：${error instanceof Error ? error.message : String(error)}`
    // 500 才写宿主日志；业务错误（参数/会话不存在）是正常路径。
    if (status >= 500)
      ctx.logger?.warn?.(error)
    if (!res.headersSent)
      sendJson(res, status, { error: message })
  }
}

/**
 * 读取并解析 JSON 请求体（带大小上限）。
 * @param req Node 请求。
 * @returns 解析后的对象（空体视为 {}）。
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError('请求体过大', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new HttpError('请求体必须是 JSON 对象'))
          return
        }
        resolve(parsed)
      } catch {
        reject(new HttpError('请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => reject(error))
  })
}

/**
 * 组装渲染载荷：读会话 → 抽回合 → 渲染 HTML。
 * @param ctx Cordis 上下文。
 * @param input 请求体。
 * @returns 客户端光栅化所需的载荷。
 */
async function buildRenderPayload(ctx, input) {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
  if (sessionId === '')
    throw new HttpError('缺少 sessionId')
  const options = {
    timestamps: input.timestamps !== false,
    redact: input.redact === true,
    tools: input.tools === true,
    compact: input.compact !== false,
    width: clampWidth(input.width),
  }
  let snapshot
  try {
    snapshot = await ctx.sessionQuery.readSession(sessionId)
  } catch (error) {
    throw new HttpError(`读取会话失败：${error instanceof Error ? error.message : String(error)}`, 404)
  }
  const session = snapshot?.session ?? { id: sessionId }
  const allTurns = extractTurns(snapshot, options)
  if (allTurns.length === 0)
    throw new HttpError('该会话还没有可导出的消息')
  // 回合级选择：客户端传回选中的原始下标（未传则导全部）。
  const turns = selectTurns(allTurns, input.turns)
  const title = typeof session.title === 'string' && session.title.trim() !== '' ? session.title.trim() : '未命名对话'
  const html = renderDocument({
    title,
    sessionId,
    createdAt: session.createdAt,
    turns,
    options,
  })
  return {
    fileName: buildFileName(title, turns.length, allTurns.length),
    title,
    html,
    stats: {
      turns: turns.length,
      totalTurns: allTurns.length,
      chars: turns.reduce((sum, turn) => sum + turn.text.length, 0),
      width: options.width,
    },
  }
}

/**
 * 按客户端给出的下标挑选回合；未给下标表示「全选」。
 * 越界下标静默忽略，全空则报错——绝不悄悄退回全量导出。
 * @param allTurns 全部回合。
 * @param selection 原始下标数组（可选）。
 * @returns 选中的回合（保持原顺序）。
 */
function selectTurns(allTurns, selection) {
  if (!Array.isArray(selection))
    return allTurns
  const keep = new Set(selection
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value < allTurns.length))
  const picked = allTurns.filter((_, index) => keep.has(index))
  if (picked.length === 0)
    throw new HttpError('至少选择一条要导出的消息')
  return picked
}

/**
 * 回合清单：给客户端的勾选面板用（不含正文，只有预览）。
 * @param ctx Cordis 上下文。
 * @param input 请求体（sessionId）。
 * @returns { turns: Array<{ index, role, time, preview, chars }> }
 */
async function buildTurnsPayload(ctx, input) {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
  if (sessionId === '')
    throw new HttpError('缺少 sessionId')
  let snapshot
  try {
    snapshot = await ctx.sessionQuery.readSession(sessionId)
  } catch (error) {
    throw new HttpError(`读取会话失败：${error instanceof Error ? error.message : String(error)}`, 404)
  }
  const turns = extractTurns(snapshot, { timestamps: true, redact: false, tools: input.tools === true })
  if (turns.length === 0)
    throw new HttpError('该会话还没有可导出的消息')
  return {
    turns: turns.map((turn, index) => ({
      index,
      role: turn.role,
      kind: turn.kind,
      tools: [...new Set(turn.tools)].slice(0, 4),
      time: turn.time ?? null,
      preview: previewOf(turn.text),
      chars: turn.text.length,
    })),
  }
}

/**
 * 回合预览：压平空白后截断，供勾选面板显示。
 * @param text 回合正文。
 * @returns 单行预览。
 */
function previewOf(text) {
  const flat = flattenWhitespace(text)
  return flat.length <= PREVIEW_LIMIT ? flat : `${flat.slice(0, PREVIEW_LIMIT)}…`
}

/** 预览长度上限（字符）。 */
const PREVIEW_LIMIT = 90

/**
 * 压平空白（面板预览与客户端匹配共用同一口径）。
 * @param text 原始文本。
 * @returns 单行文本。
 */
function flattenWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 版式宽度收敛到 360–1600，非法值回落默认。
 * @param value 原始输入。
 * @returns CSS px 宽度。
 */
function clampWidth(value) {
  const width = Number(value)
  if (!Number.isFinite(width))
    return DEFAULT_WIDTH
  return Math.max(360, Math.min(1600, Math.round(width)))
}

/**
 * 从会话快照抽取对话回合，并给每条打上「类型」标记。
 *
 * 类型定义（面板上以徽章呈现，默认只勾 user + answer）：
 * - `user`    真实用户输入
 * - `context` 宿主注入的上下文（system-reminder / runtime context / 时间采样等），
 *             界面上不显示，导出却会占好几千字
 * - `answer`  助手最终回答（不含工具调用）
 * - `step`    助手后台步骤：边思考边调工具的那种中间消息
 * @param snapshot sessionQuery.readSession 的返回值。
 * @param options 渲染选项（是否保留工具调用行）。
 * @returns 回合数组，按事件顺序。
 */
function extractTurns(snapshot, options) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : []
  const turns = []
  for (const event of events) {
    const type = event?.type
    const role = type === 'user/message' ? 'user' : type === 'assistant/message' ? 'assistant' : ''
    if (role === '')
      continue
    const data = event.data ?? {}
    const content = role === 'user'
      ? (data.content ?? data.message?.content)
      : (data.message?.content ?? data.content)
    const shaped = flattenContent(content, options.tools)
    // 纯工具步骤（没有正文）：不单独成行，否则一个长会话会有几百条空回合。
    if (shaped.text.trim() === '')
      continue
    const text = options.redact ? redactSecrets(shaped.text) : shaped.text
    turns.push({
      role,
      kind: classify(role, text, shaped.tools),
      tools: shaped.tools,
      text,
      time: typeof event.time === 'number' ? event.time : undefined,
    })
  }
  return turns
}

/**
 * 回合类型判定。
 * @param role 角色。
 * @param text 正文。
 * @param tools 工具名列表。
 * @returns 类型标识。
 */
function classify(role, text, tools) {
  if (role === 'user')
    return isInjectedContext(text) ? 'context' : 'user'
  return tools.length > 0 ? 'step' : 'answer'
}

/** 宿主注入上下文的特征开头（这些内容在界面上不可见，但会进会话日志）。 */
const INJECTED_PATTERNS = [
  /^<system-reminder>/,
  /^Current runtime context\./,
  /^Time sampled while preparing turn/,
  /^A skill is a reusable set of task-specific instructions/,
]

/**
 * 判断一条用户消息是不是宿主注入的上下文。
 * @param text 正文。
 * @returns 是否注入。
 */
function isInjectedContext(text) {
  const head = text.trimStart()
  return INJECTED_PATTERNS.some((pattern) => pattern.test(head))
}

/**
 * 把消息 content（字符串或内容块数组）压平成可渲染文本，并收集工具名。
 *
 * 真实会话日志里的块类型是 `text` / `reasoning` / `tool-call`：推理块不进正文
 * （太长且是过程），工具块默认也只记名字用于分类与紧凑渲染。
 * @param content 消息内容。
 * @param includeTools 是否把工具调用写成正文里的一行引用。
 * @returns 正文与工具名列表。
 */
function flattenContent(content, includeTools) {
  if (typeof content === 'string')
    return { text: content, tools: [] }
  if (!Array.isArray(content))
    return { text: '', tools: [] }
  const parts = []
  const tools = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block === null || typeof block !== 'object')
      continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string')
          parts.push(block.text)
        break
      case 'image':
        parts.push('［图片］')
        break
      case 'tool-call':
      case 'tool_use': {
        const toolName = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool'
        tools.push(toolName)
        if (includeTools)
          parts.push(`> 工具调用：\`${toolName}\``)
        break
      }
      case 'tool-result':
      case 'tool_result':
      case 'reasoning':
      default:
        break
    }
  }
  return { text: parts.join('\n\n'), tools }
}

/**
 * 隐私脱敏：手机号 / 邮箱 / 身份证 / 银行卡 / IP / API Key / JWT。
 * 只做保守替换，宁可少打码也不破坏正文结构。
 * @param text 原始文本。
 * @returns 脱敏文本。
 */
function redactSecrets(text) {
  return text
    .replace(/\b(?:\d[ -]?){16,19}\b/g, (match) => (match.replace(/\D/g, '').length >= 16 ? '［银行卡已脱敏］' : match))
    .replace(/\b\d{3}-\d{4}-\d{4}\b/g, '［身份证已脱敏］')
    .replace(/\b1[3-9]\d{9}\b/g, '［手机号已脱敏］')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '［邮箱已脱敏］')
    .replace(/\b(?:[A-Za-z0-9-]+\.){3}[A-Za-z0-9-]+\b(?=\s|$|[,;:])/g, (match) => (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(match) || match.includes('.') ? '［地址已脱敏］' : match))
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '［API Key 已脱敏］')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '［JWT 已脱敏］')
}

/**
 * 下载文件名：标题清洗 + 长图 + 北京时间戳。
 * @param title 会话标题。
 * @returns 含 .png 后缀的文件名。
 */
/**
 * 下载文件名：标题清洗 + 选中范围 + 北京时间戳。
 * @param title 会话标题。
 * @param picked 选中回合数。
 * @param total 全部回合数。
 * @returns 含 .png 后缀的文件名。
 */
function buildFileName(title, picked = 0, total = 0) {
  const stem = title
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || 'conversation'
  const scope = picked > 0 && total > 0 && picked < total ? `选中${picked}条` : '全篇'
  return `${stem}-长图-${scope}-${stamp(Date.now())}.png`
}

// ---------------------------------------------------------------------------
// HTML 文档
// ---------------------------------------------------------------------------

/** 文档样式：一份自包含、白底、适合分享的排版。 */
const DOC_STYLE = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body {
  color: #1f2328;
  font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.72;
  -webkit-font-smoothing: antialiased;
}
.sheet { padding: 44px 46px 58px; }
header { padding-bottom: 18px; margin-bottom: 6px; border-bottom: 1px solid #e6e8eb; }
h1 { margin: 0 0 12px; font-size: 27px; line-height: 1.34; font-weight: 700; letter-spacing: -0.2px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 16px; color: #6b7280; font-size: 12.5px; }
.meta span { white-space: nowrap; }
.turn { margin-top: 24px; }
.turn-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.who { font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 999px; letter-spacing: 0.2px; }
.who.user { background: #e8f0fe; color: #1a56db; }
.who.step { background: #fff4e0; color: #a35d00; }
.who.context { background: #eef0f3; color: #5f6b7a; }
.who.assistant, .who.answer { background: #e7f7ee; color: #0f7a45; }
.time { color: #9aa1a9; font-size: 11.5px; }
.bubble { border: 1px solid #e6e8eb; border-radius: 12px; padding: 15px 18px; background: #fcfcfd; }
.turn.user .bubble { background: #f8faff; border-color: #e2e9fb; }
.turn.compact { margin-top: 10px; }
.compact-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; padding: 6px 10px; border-left: 2px solid #e2e5e9; background: #fafbfc; border-radius: 0 6px 6px 0; }
.compact-meta { color: #8b929c; font-size: 11.5px; white-space: nowrap; }
.compact-snippet { flex: 1 1 240px; min-width: 0; color: #6b7280; font-size: 12px; line-height: 1.5; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.bubble > :first-child { margin-top: 0; }
.bubble > :last-child { margin-bottom: 0; }
p { margin: 9px 0; }
h1, h2, h3, h4 { margin: 18px 0 8px; line-height: 1.4; }
.bubble h1 { font-size: 21px; } .bubble h2 { font-size: 18px; } .bubble h3 { font-size: 16px; } .bubble h4 { font-size: 15px; }
ul, ol { margin: 8px 0; padding-left: 24px; }
li { margin: 3px 0; }
li > ul, li > ol { margin: 4px 0; }
pre {
  margin: 11px 0; padding: 13px 15px; overflow: hidden;
  background: #f6f8fa; border: 1px solid #e6e8eb; border-radius: 9px;
  font-family: "Cascadia Code", Consolas, "Courier New", monospace;
  font-size: 12.5px; line-height: 1.58; white-space: pre-wrap; word-break: break-word;
}
pre code { background: none; padding: 0; font-size: inherit; }
code {
  background: #f1f3f5; border-radius: 5px; padding: 1px 5px;
  font-family: "Cascadia Code", Consolas, monospace; font-size: 13px;
}
table { width: 100%; margin: 12px 0; border-collapse: collapse; font-size: 13.5px; }
th, td { border: 1px solid #e2e5e9; padding: 7px 11px; text-align: left; vertical-align: top; }
th { background: #f6f8fa; font-weight: 600; }
blockquote { margin: 11px 0; padding: 6px 15px; border-left: 3px solid #d5dae1; background: #fafbfc; color: #57606a; }
blockquote > :first-child { margin-top: 0; } blockquote > :last-child { margin-bottom: 0; }
hr { border: 0; border-top: 1px solid #e6e8eb; margin: 20px 0; }
a { color: #2563eb; text-decoration: none; }
img { max-width: 100%; }
strong { font-weight: 650; }
`.trim()

/**
 * 渲染完整 HTML 文档（raster 侧会抽取 style 与 body.innerHTML）。
 * @param model 文档模型。
 * @returns 完整 HTML 字符串。
 */
function renderDocument(model) {
  const { title, sessionId, createdAt, turns, options } = model
  const meta = [
    `会话 ${sessionId}`,
    createdAt ? `创建于 ${dateTime(createdAt)}` : '',
    `导出于 ${dateTime(Date.now())}`,
    `${turns.length} 条消息`,
  ].filter((item) => item !== '')
  const head = [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${DOC_STYLE}</style>`,
    '</head><body>',
    `<div class="sheet" style="width:${options.width}px">`,
    '<header>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<div class="meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>`,
    '</header>',
  ]
  const body = turns.map((turn) => {
    // 后台步骤与注入上下文：压成一行，避免勾错一条就把长图撑爆。
    if (options.compact && (turn.kind === 'step' || turn.kind === 'context'))
      return renderCompactTurn(turn, options)
    const who = WHO_LABEL[turn.kind] ?? (turn.role === 'user' ? '用户' : '助手')
    const time = options.timestamps && turn.time ? `<span class="time">${escapeHtml(timeOfDay(turn.time))}</span>` : ''
    return [
      `<section class="turn ${turn.role}">`,
      `<div class="turn-head"><span class="who ${turn.kind}">${who}</span>${time}</div>`,
      `<div class="bubble">${markdownToHtml(turn.text)}</div>`,
      '</section>',
    ].join('')
  })
  return [...head, ...body, '</div></body></html>'].join('\n')
}

/** 徽章文案。 */
const WHO_LABEL = {
  user: '用户',
  answer: '助手',
  step: '后台步骤',
  context: '上下文',
}

/**
 * 紧凑回合：一条灰底细行，只留一句摘要（可选列出工具名）。
 * @param turn 回合。
 * @param options 渲染选项。
 * @returns HTML 片段。
 */
function renderCompactTurn(turn, options) {
  const tools = [...new Set(turn.tools)]
  const toolText = tools.length > 0 ? `工具 ${tools.slice(0, 4).join('、')}${tools.length > 4 ? ' 等' : ''} · ` : ''
  const flat = flattenWhitespace(turn.text)
  const snippet = flat.length <= COMPACT_SNIPPET ? flat : `${flat.slice(0, COMPACT_SNIPPET)}…`
  const time = options.timestamps && turn.time ? ` · ${escapeHtml(timeOfDay(turn.time))}` : ''
  return [
    `<section class="turn ${turn.role} compact">`,
    `<div class="compact-row">`,
    `<span class="who ${turn.kind}">${WHO_LABEL[turn.kind] ?? '步骤'}</span>`,
    `<span class="compact-meta">${escapeHtml(toolText)}${turn.text.length} 字${time}</span>`,
    `<span class="compact-snippet">${escapeHtml(snippet)}</span>`,
    `</div>`,
    '</section>',
  ].join('')
}

/** 紧凑行摘要长度上限（字符）。 */
const COMPACT_SNIPPET = 70

/**
 * 极简 Markdown → HTML（只覆盖对话里真实出现过的语法）。
 * 顺序：先整体转义，再逐块解析；块内只做内联替换，绝不引入原始 HTML。
 * @param source Markdown 源文本。
 * @returns HTML 片段。
 */
function markdownToHtml(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    // 代码围栏
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(line)
    if (fence !== null) {
      const marker = fence[1][0]
      const lang = fence[2]
      const buffer = []
      index += 1
      while (index < lines.length) {
        const candidate = lines[index]
        if (new RegExp(`^\\s{0,3}${marker}{3,}\\s*$`).test(candidate))
          break
        buffer.push(candidate)
        index += 1
      }
      index += 1
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`
      out.push(`<pre><code${cls}>${escapeHtml(buffer.join('\n'))}</code></pre>`)
      continue
    }
    // 空行
    if (line.trim() === '') {
      index += 1
      continue
    }
    // 分隔线
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>')
      index += 1
      continue
    }
    // 标题
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const level = heading[1].length
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`)
      index += 1
      continue
    }
    // 表格（表头 + 分隔行）
    if (line.includes('|') && index + 1 < lines.length && /^\s{0,3}\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1])) {
      const parsed = readTable(lines, index)
      if (parsed !== null) {
        out.push(parsed.html)
        index = parsed.next
        continue
      }
    }
    // 引用
    if (/^\s{0,3}>/.test(line)) {
      const buffer = []
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        buffer.push(lines[index].replace(/^\s{0,3}>\s?/, ''))
        index += 1
      }
      out.push(`<blockquote>${markdownToHtml(buffer.join('\n'))}</blockquote>`)
      continue
    }
    // 列表（连续项为一块，缩进子内容并入同项）
    if (/^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/.test(line)) {
      const parsed = readList(lines, index)
      out.push(parsed.html)
      index = parsed.next
      continue
    }
    // 段落
    const buffer = []
    while (index < lines.length) {
      const candidate = lines[index]
      if (candidate.trim() === '')
        break
      if (/^\s{0,3}(?:#{1,6}\s|>|```|~~~|(?:-{3,}|\*{3,})\s*$)/.test(candidate))
        break
      if (/^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/.test(candidate))
        break
      buffer.push(candidate)
      index += 1
    }
    out.push(`<p>${renderInline(buffer.join('\n')).replace(/\n/g, '<br>')}</p>`)
  }
  return out.join('\n')
}

/**
 * 读取 Markdown 表格。
 * @param lines 全部行。
 * @param start 起始行。
 * @returns HTML 与下一行下标；格式不符返回 null。
 */
function readTable(lines, start) {
  const split = (row) => {
    const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '')
    return trimmed.split('|').map((cell) => cell.trim())
  }
  const header = split(lines[start])
  const ruler = split(lines[start + 1])
  if (header.length === 0 || header.length !== ruler.length || ruler.some((cell) => !/^:?-{1,}:?$/.test(cell)))
    return null
  const rows = []
  let index = start + 2
  while (index < lines.length) {
    const candidate = lines[index]
    if (candidate.trim() === '' || !candidate.includes('|'))
      break
    const cells = split(candidate)
    // 单元格数与表头不符：按表头补齐/截断，避免畸形表格撑破版面。
    rows.push(header.map((_, i) => cells[i] ?? ''))
    index += 1
  }
  const head = `<thead><tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>`
  const body = rows.length === 0
    ? ''
    : `<tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
  return { html: `<table>${head}${body}</table>`, next: index }
}

/**
 * 读取 Markdown 列表（支持缩进续行与一层子列表）。
 * 有序列表保留起始序号，避免「1. 2. 3. / 1. 2.」把编号重新从 1 开始。
 * @param lines 全部行。
 * @param start 起始行。
 * @returns HTML 与下一行下标。
 */
function readList(lines, start) {
  const marker = /^(\s{0,3})([-*+]|\d{1,3}[.)])\s+(.*)$/
  const first = marker.exec(lines[start])
  if (first === null)
    return { html: '', next: start + 1 }
  const ordered = /\d/.test(first[2])
  const startAt = ordered ? Number(first[2].replace(/\D/g, '')) : 1
  const baseIndent = first[1].length
  const items = []
  let index = start
  while (index < lines.length) {
    const head = marker.exec(lines[index])
    if (head === null)
      break
    // 序号类型或缩进层级不同：属于别的列表，交回调用方。
    if (/\d/.test(head[2]) !== ordered || head[1].length !== baseIndent)
      break
    const parts = [head[3]]
    index += 1
    // 续行（缩进 ≥ 2 且不是列表标记）并入当前项。
    while (index < lines.length) {
      const line = lines[index]
      if (line.trim() === '' || marker.test(line))
        break
      if (!/^\s{2,}/.test(line))
        break
      parts.push(line.trim())
      index += 1
    }
    // 更深缩进的列表：递归成子列表。
    const children = []
    for (;;) {
      const sub = marker.exec(lines[index] ?? '')
      if (sub === null || sub[1].length <= baseIndent)
        break
      const nested = readList(lines, index)
      if (nested.html !== '')
        children.push(nested.html)
      if (nested.next <= index)
        break
      index = nested.next
    }
    items.push(`<li>${renderInline(parts.join(' '))}${children.join('')}</li>`)
  }
  const tag = ordered ? 'ol' : 'ul'
  const startAttr = ordered && startAt !== 1 ? ` start="${startAt}"` : ''
  return { html: `<${tag}${startAttr}>${items.join('')}</${tag}>`, next: index }
}

/**
 * 行内 Markdown：代码、链接、粗体、斜体、删除线。
 * 输入必须是已转义的文本；代码段用占位符保护，避免二次解析。
 * @param text 已转义文本。
 * @returns HTML 片段。
 */
function renderInline(text) {
  const codes = []
  let out = text.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)）]+)/g, '$1<a href="$2">$2</a>')
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  out = out.replace(/\u0000(\d+)\u0000/g, (_, at) => `<code>${codes[Number(at)]}</code>`)
  return out
}

/**
 * HTML 转义（正文唯一入口）。
 * @param text 原始文本。
 * @returns 转义文本。
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// 时间与 HTTP 工具
// ---------------------------------------------------------------------------

/** 北京时区格式化器（宿主与客户端同一套显示口径）。 */
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
})

/**
 * 北京时间「YYYY/MM/DD HH:mm」。
 * @param value 时间戳。
 * @returns 展示字符串。
 */
function dateTime(value) {
  const date = new Date(typeof value === 'number' ? value : Number(value))
  return Number.isNaN(date.getTime()) ? '' : dateFormatter.format(date)
}

/**
 * 北京时间「YYYYMMDD-HHmm」（文件名用）。
 * @param value 时间戳。
 * @returns 紧凑时间串。
 */
function stamp(value) {
  const text = dateTime(value).replace(/[^\d]/g, '')
  return text.length >= 12 ? `${text.slice(0, 8)}-${text.slice(8, 12)}` : String(value)
}

/**
 * 单条消息的时刻（只显示时:分）。
 * @param value 时间戳。
 * @returns 展示字符串。
 */
function timeOfDay(value) {
  const text = dateTime(value)
  return text.length >= 5 ? text.slice(-5) : text
}

/**
 * 发送 JSON 响应。
 * @param res Node 响应。
 * @param status 状态码。
 * @param payload 响应体。
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
  })
  res.end(body)
}
