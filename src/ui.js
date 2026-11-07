/**
 * dsh-longshot —— 会话长图导出（浏览器半）。
 *
 * 本文件与 src/raster.js 一起被 scripts/build-client.mjs 内联进
 * `window.__ModuleLoader__.load({ id, factory })` 工厂闭包：factory 里只有
 * `require` 可用（platform seed 表），所以全部依赖都必须是 require('react')
 * 这一级的基座模块，资源一律内联，不引入任何 CSS module / 构建期变换。
 *
 * 入口：官方 chat 插件的 `conversation.chat.assistant-actions` 槽——也就是每条
 * 助手消息下面那排「复制 / 点赞 / 分享」图标所在的位置。点击后弹出面板，
 * 面板里勾选要导出的回合（默认只勾「用户输入 + 最终回答」），再光栅成一张 PNG。
 */

const React = require('react')
const h = React.createElement

/** 单条消息操作区里的触发按钮（与图标按钮同一行，字号最小化以免抢戏）。 */
const TRIGGER_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  height: '24px',
  padding: '0 8px',
  borderRadius: '6px',
  border: '1px solid var(--dsh-color-border, rgba(128, 128, 128, 0.32))',
  background: 'transparent',
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: '11px',
  lineHeight: '1',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  opacity: 0.85,
}
const TRIGGER_HOVER_STYLE = {
  ...TRIGGER_STYLE,
  background: 'rgba(128, 128, 128, 0.16)',
  borderColor: 'rgba(128, 128, 128, 0.55)',
  opacity: 1,
}

/** 面板配色（跟随深色主题；浅色主题下仍可读）。 */
const UI = {
  layer: 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;'
    + 'background:rgba(0,0,0,0.46);backdrop-filter:blur(1px);',
  panel: 'width:560px;max-width:calc(100vw - 32px);max-height:calc(100vh - 64px);display:flex;flex-direction:column;'
    + 'box-sizing:border-box;padding:22px 24px 16px;border-radius:14px;border:1px solid rgba(255,255,255,0.12);'
    + 'background:#242529;color:#e9eaee;box-shadow:0 18px 48px rgba(0,0,0,0.45);'
    + 'font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;',
  title: 'margin:0 0 6px;font-size:16px;font-weight:650;letter-spacing:0.2px;',
  hint: 'margin:0 0 14px;font-size:12.5px;line-height:1.6;color:#9aa1ab;',
  row: 'display:flex;align-items:center;gap:9px;padding:6px 0;font-size:13px;cursor:pointer;',
  checkbox: 'width:15px;height:15px;margin:0;accent-color:#4c8dff;cursor:pointer;flex:none;',
  widthRow: 'display:flex;align-items:center;gap:10px;margin:8px 0 0;font-size:13px;',
  select: 'flex:1;height:30px;padding:0 9px;border-radius:8px;border:1px solid rgba(255,255,255,0.16);'
    + 'background:#1c1d21;color:#e9eaee;font-family:inherit;font-size:12.5px;',
  turnBox: 'margin-top:12px;border:1px solid rgba(255,255,255,0.10);border-radius:10px;overflow:hidden;',
  turnBar: 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(255,255,255,0.045);'
    + 'font-size:12px;color:#a7adb6;',
  turnCount: 'margin-left:auto;font-variant-numeric:tabular-nums;',
  mini: 'height:24px;padding:0 9px;border-radius:6px;border:1px solid rgba(255,255,255,0.16);'
    + 'background:transparent;color:#d6d9de;font-family:inherit;font-size:11.5px;cursor:pointer;',
  list: 'max-height:246px;overflow-y:auto;padding:4px 0;',
  item: 'display:flex;align-items:flex-start;gap:9px;padding:7px 10px;cursor:pointer;',
  itemChecked: 'display:flex;align-items:flex-start;gap:9px;padding:7px 10px;cursor:pointer;'
    + 'background:rgba(76,141,255,0.10);',
  who: 'flex:none;font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:999px;margin-top:1px;',
  whoUser: 'background:#1f3358;color:#8fb6ff;',
  whoAnswer: 'background:#173a2a;color:#7ee0a8;',
  whoStep: 'background:#3a2d12;color:#ffc46b;',
  whoContext: 'background:#2b2f36;color:#98a2ae;',
  preview: 'flex:1;font-size:12px;line-height:1.45;color:#c7ccd3;overflow:hidden;display:-webkit-box;'
    + '-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word;',
  previewMuted: 'flex:1;font-size:12px;line-height:1.45;color:#8d949e;overflow:hidden;display:-webkit-box;'
    + '-webkit-line-clamp:1;-webkit-box-orient:vertical;word-break:break-word;',
  status: 'min-height:20px;margin:12px 0 2px;font-size:12px;line-height:1.5;color:#a7adb6;word-break:break-word;',
  footer: 'display:flex;justify-content:flex-end;gap:10px;margin-top:10px;',
  ghost: 'height:32px;padding:0 15px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);'
    + 'background:transparent;color:#d6d9de;font-family:inherit;font-size:13px;cursor:pointer;',
  primary: 'height:34px;padding:0 18px;border-radius:8px;border:1px solid #3f7ef0;background:#3f7ef0;'
    + 'color:#fff;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;'
    + 'box-shadow:0 2px 10px rgba(63,126,240,0.35);transition:background 0.12s ease,border-color 0.12s ease,'
    + 'box-shadow 0.12s ease;',
  primaryHover: 'height:34px;padding:0 18px;border-radius:8px;border:1px solid #5b93f7;background:#5b93f7;'
    + 'color:#fff;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;'
    + 'box-shadow:0 3px 14px rgba(63,126,240,0.5);transition:background 0.12s ease,border-color 0.12s ease,'
    + 'box-shadow 0.12s ease;',
  // 禁用态是「实心灰」，而不是给主按钮打半透明——半透明看起来像加载中/不可点击，
  // 容易让人以为「导出」坏了。
  primaryDisabled: 'height:34px;padding:0 18px;border-radius:8px;'
    + 'border:1px solid rgba(255,255,255,0.10);background:#31343a;color:#7f858f;'
    + 'font-family:inherit;font-size:13px;font-weight:600;cursor:not-allowed;box-shadow:none;',
  disabled: 'opacity:0.55;cursor:default;',
}

/** 版式宽度候选。 */
const WIDTH_OPTIONS = [
  { value: '720', label: '窄（720 px）' },
  { value: '900', label: '标准（900 px）— 推荐' },
  { value: '1080', label: '宽（1080 px）' },
]

/** 回合类型 → 徽章文案与配色。 */
const KIND_META = {
  user: { label: '用户', style: UI.whoUser },
  answer: { label: '回答', style: UI.whoAnswer },
  step: { label: '后台', style: UI.whoStep },
  context: { label: '上下文', style: UI.whoContext },
}

/** 面板单例：避免重复点击开出多层。 */
let openLayer = null

/**
 * 客户端插件入口：把「长图」注册进每条消息的操作区。
 * @param ctx 客户端 Cordis 上下文。
 */
function apply(ctx) {
  ctx.effect(() => ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'longshot-export',
    order: 40,
  }, LongshotAction)), 'dsh-longshot: message action')
}

/**
 * 消息级触发按钮。slot 注入 { messageId, text, sessionId }。
 * @param props React props。
 * @returns 按钮元素。
 */
function LongshotAction({ sessionId, text }) {
  const [hover, setHover] = React.useState(false)
  return h('button', {
    type: 'button',
    title: '把选中的消息导出成一张纵向 PNG 长图',
    style: hover ? TRIGGER_HOVER_STYLE : TRIGGER_STYLE,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onClick: (event) => {
      event?.preventDefault?.()
      event?.stopPropagation?.()
      openPanel(sessionId, typeof text === 'string' ? flattenWhitespace(text) : '')
    },
  }, '长图')
}

/**
 * 压平空白（与 Host 的预览口径一致，用于定位「当前这条」）。
 * @param text 原始文本。
 * @returns 单行文本。
 */
function flattenWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 接口基址：同源页面用相对路径，非 HTTP 载体尝试 shell 提供的 transport。
 * @returns 前缀（可能为空串）。
 */
function apiBase() {
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol))
    return ''
  const transport = typeof window !== 'undefined' ? window.__DSH_TRANSPORT__ : undefined
  return transport !== undefined && typeof transport.streamBaseUrl === 'string'
    ? transport.streamBaseUrl.replace(/\/+$/, '')
    : ''
}

/**
 * 后台类回合（后台步骤 / 注入上下文）。
 * @param kind 回合类型。
 * @returns 是否后台类。
 */
function isBackground(kind) {
  return kind === 'step' || kind === 'context'
}

/**
 * 在回合清单里定位触发按钮所属的消息：预览被截断时按前缀匹配。
 * @param turns 回合清单。
 * @param currentText 当前消息纯文本（已压平）。
 * @returns 回合下标，未命中为 -1。
 */
function indexOfCurrent(turns, currentText) {
  if (currentText === '')
    return -1
  const head = currentText.slice(0, 60)
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn.role !== 'assistant')
      continue
    const flat = flattenWhitespace(turn.preview).replace(/…$/, '')
    if (flat === '')
      continue
    if (currentText.startsWith(flat) || flat.startsWith(head))
      return index
  }
  return -1
}

/**
 * 打开导出面板。
 * @param sessionId 当前会话 id。
 * @param currentText 触发按钮所在消息的纯文本（用于默认勾选）。
 */
function openPanel(sessionId, currentText) {
  if (openLayer !== null) {
    openLayer.focus()
    return
  }
  const doc = document
  const options = { timestamps: true, redact: false, includeBackground: false, compact: true, width: '900' }
  /** 全部回合（null = 还在加载）。 */
  let turns = null
  /** 选中回合的原始下标。 */
  const selected = new Set()
  /** 是否显示/允许选择后台类回合。 */
  let includeBackground = false
  let busy = false
  /** 是否已成功导出（成功后主按钮变成「已导出」并保持禁用态）。 */
  let finished = false
  /** 主按钮是否处于悬停态。 */
  let hoverRun = false
  let currentIndex = -1

  const layer = doc.createElement('div')
  layer.setAttribute('style', UI.layer)
  const panel = doc.createElement('div')
  panel.setAttribute('style', UI.panel)
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '导出长图')

  const title = doc.createElement('h2')
  title.setAttribute('style', UI.title)
  title.textContent = '导出长图'
  const hint = doc.createElement('p')
  hint.setAttribute('style', UI.hint)
  hint.textContent = '默认只导出「用户输入 + 最终回答」。后台步骤（边思考边调工具）和宿主注入的上下文默认隐藏——它们往往占掉大半个篇幅。'
  panel.append(title, hint)

  const addCheckbox = (key, label, initial, onChange) => {
    const row = doc.createElement('label')
    row.setAttribute('style', UI.row)
    const box = doc.createElement('input')
    box.type = 'checkbox'
    box.setAttribute('style', UI.checkbox)
    box.checked = initial
    box.addEventListener('change', () => {
      options[key] = box.checked
      onChange?.(box.checked)
    })
    const text = doc.createElement('span')
    text.textContent = label
    row.append(box, text)
    panel.append(row)
    return box
  }
  addCheckbox('timestamps', '保留时间戳', true)
  addCheckbox('redact', '隐私脱敏（手机号 / 邮箱 / 身份证 / API Key / JWT）', false)
  const backgroundToggle = addCheckbox('includeBackground', '包含后台步骤与注入上下文', false, (checked) => {
    includeBackground = checked
    // 关掉开关时，把后台类回合从选择里摘掉，避免「看不见却被导出」。
    if (!checked) {
      for (const turn of turns ?? []) {
        if (isBackground(turn.kind))
          selected.delete(turn.index)
      }
    }
    renderTurns()
    if (turns !== null) {
      const hidden = turns.filter((turn) => isBackground(turn.kind)).length
      setStatus(checked
        ? `已显示全部 ${turns.length} 条；后台/上下文会按紧凑行渲染。`
        : `已隐藏 ${hidden} 条后台/上下文。`)
    }
  })
  addCheckbox('compact', '后台/上下文回合压成一行（勾错也不至于撑爆长图）', true)

  const widthRow = doc.createElement('div')
  widthRow.setAttribute('style', UI.widthRow)
  const widthLabel = doc.createElement('span')
  widthLabel.textContent = '版式宽度'
  const select = doc.createElement('select')
  select.setAttribute('style', UI.select)
  for (const item of WIDTH_OPTIONS) {
    const option = doc.createElement('option')
    option.value = item.value
    option.textContent = item.label
    if (item.value === options.width)
      option.selected = true
    select.append(option)
  }
  select.addEventListener('change', () => {
    options.width = select.value
  })
  widthRow.append(widthLabel, select)
  panel.append(widthRow)

  // 回合勾选区块。
  const turnBox = doc.createElement('div')
  turnBox.setAttribute('style', UI.turnBox)
  const turnBar = doc.createElement('div')
  turnBar.setAttribute('style', UI.turnBar)
  const turnLabel = doc.createElement('span')
  turnLabel.textContent = '导出范围'
  const countLabel = doc.createElement('span')
  countLabel.setAttribute('style', UI.turnCount)
  countLabel.textContent = '加载中…'
  const mkMini = (label, handler) => {
    const button = doc.createElement('button')
    button.type = 'button'
    button.setAttribute('style', UI.mini)
    button.textContent = label
    button.addEventListener('click', handler)
    return button
  }
  const onlyCurrent = mkMini('仅本条', () => {
    if (turns === null)
      return
    selected.clear()
    if (currentIndex >= 0)
      selected.add(turns[currentIndex].index)
    renderTurns()
  })
  const selectAll = mkMini('全选', () => {
    for (const turn of visibleTurns())
      selected.add(turn.index)
    renderTurns()
  })
  const selectNone = mkMini('全不选', () => {
    selected.clear()
    renderTurns()
  })
  turnBar.append(turnLabel, onlyCurrent, selectAll, selectNone, countLabel)
  const list = doc.createElement('div')
  list.setAttribute('style', UI.list)
  turnBox.append(turnBar, list)
  panel.append(turnBox)

  const status = doc.createElement('div')
  status.setAttribute('style', UI.status)
  status.textContent = '读取消息列表…'
  panel.append(status)

  const footer = doc.createElement('div')
  footer.setAttribute('style', UI.footer)
  const cancel = doc.createElement('button')
  cancel.type = 'button'
  cancel.setAttribute('style', UI.ghost)
  cancel.textContent = '取消'
  const run = doc.createElement('button')
  run.type = 'button'
  run.setAttribute('style', UI.primaryDisabled)
  run.textContent = '导出'
  run.disabled = true
  footer.append(cancel, run)
  panel.append(footer)
  layer.append(panel)
  doc.body.append(layer)
  openLayer = layer

  const setStatus = (text, tone) => {
    status.textContent = text
    status.style.color = tone === 'error' ? '#ff8f8f' : tone === 'ok' ? '#7ee0a8' : tone === 'warn' ? '#ffc46b' : '#a7adb6'
  }
  /**
   * 主按钮的唯一状态出口：可点时是亮蓝 + 数量，不可点时是实心灰。
   * 以前这里只在 setBusy 里改样式，勾选恢复后按钮仍带着 disabled 的
   * 半透明样式，看起来像「点不动」——正是用户反馈的那个误解。
   */
  const syncRun = () => {
    const count = selected.size
    const enabled = !busy && !finished && count > 0
    run.disabled = !enabled
    run.textContent = busy ? '导出中…' : finished ? '已导出' : count > 0 ? `导出 ${count} 条` : '导出'
    run.setAttribute('style', !enabled
      ? UI.primaryDisabled
      : hoverRun ? UI.primaryHover : UI.primary)
    cancel.disabled = busy
    cancel.setAttribute('style', busy ? `${UI.ghost};${UI.disabled}` : UI.ghost)
  }
  const setBusy = (next) => {
    busy = next
    syncRun()
  }
  run.addEventListener('mouseenter', () => {
    if (!run.disabled) {
      hoverRun = true
      syncRun()
    }
  })
  run.addEventListener('mouseleave', () => {
    hoverRun = false
    syncRun()
  })
  const close = () => {
    if (busy)
      return
    doc.removeEventListener('keydown', onKeyDown, true)
    layer.remove()
    openLayer = null
  }
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && !busy)
      close()
  }
  cancel.addEventListener('click', close)
  layer.addEventListener('click', (event) => {
    if (event.target === layer)
      close()
  })
  doc.addEventListener('keydown', onKeyDown, true)

  /** 当前可见的回合（后台类是否显示取决于开关）。 */
  function visibleTurns() {
    if (turns === null)
      return []
    return includeBackground ? turns : turns.filter((turn) => !isBackground(turn.kind))
  }

  /** 重画回合列表与计数。 */
  function renderTurns() {
    list.replaceChildren()
    const rows = visibleTurns()
    if (rows.length === 0) {
      countLabel.textContent = '0 / 0'
      run.disabled = true
      return
    }
    for (const turn of rows) {
      const checked = selected.has(turn.index)
      const meta = KIND_META[turn.kind] ?? KIND_META.answer
      const row = doc.createElement('label')
      row.setAttribute('style', checked ? UI.itemChecked : UI.item)
      const box = doc.createElement('input')
      box.type = 'checkbox'
      box.setAttribute('style', UI.checkbox)
      box.checked = checked
      box.addEventListener('change', () => {
        if (box.checked)
          selected.add(turn.index)
        else
          selected.delete(turn.index)
        renderTurns()
      })
      const who = doc.createElement('span')
      who.setAttribute('style', `${UI.who}${meta.style}`)
      who.textContent = meta.label
      const preview = doc.createElement('span')
      preview.setAttribute('style', isBackground(turn.kind) ? UI.previewMuted : UI.preview)
      const toolText = Array.isArray(turn.tools) && turn.tools.length > 0 ? `［${turn.tools.join('、')}］ ` : ''
      preview.textContent = `${toolText}${turn.preview}`
      row.append(box, who, preview)
      list.append(row)
    }
    countLabel.textContent = `已选 ${selected.size} / ${turns.length}`
    syncRun()
    const visibleIndex = currentIndex >= 0 ? rows.findIndex((turn) => turn.index === turns[currentIndex].index) : -1
    if (visibleIndex >= 0)
      list.children[visibleIndex]?.scrollIntoView?.({ block: 'nearest' })
  }

  const start = async () => {
    if (busy || selected.size === 0)
      return
    setBusy(true)
    setStatus('正在渲染…')
    try {
      const response = await fetch(`${apiBase()}/longshot/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          turns: [...selected].sort((a, b) => a - b),
          ...options,
          width: Number(options.width),
        }),
      })
      const raw = await response.text()
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        payload = undefined
      }
      if (!response.ok || payload === undefined || typeof payload.html !== 'string')
        throw new Error(payload?.error ?? `接口返回 ${response.status}`)
      setStatus(`正在生成图片…（${payload.stats.turns} 条消息）`)
      await exportLongPng(payload.html, payload.fileName, {
        width: payload.stats.width,
        onProgress: (done, total) => {
          setStatus(`正在生成图片… ${done}/${total}`)
        },
        onTruncated: () => {
          setStatus('内容超出长图上限，超出部分已截断：请减少勾选或改用更窄的版式。', 'warn')
        },
      })
      setStatus(`已导出：${payload.fileName}`, 'ok')
      busy = false
      finished = true
      cancel.textContent = '完成'
      syncRun()
      window.setTimeout(() => {
        if (openLayer === layer) {
          doc.removeEventListener('keydown', onKeyDown, true)
          layer.remove()
          openLayer = null
        }
      }, 1200)
    } catch (error) {
      setBusy(false)
      setStatus(error instanceof Error ? error.message : String(error), 'error')
    }
  }
  run.addEventListener('click', () => {
    void start()
  })

  // 拉回合清单：默认只勾「用户输入 + 最终回答」；点的是后台消息则自动放开开关。
  void (async () => {
    try {
      const response = await fetch(`${apiBase()}/longshot/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !Array.isArray(payload.turns)) {
        throw new Error(response.status === 404
          ? 'Host 半还是旧版本（缺 /longshot/turns）：请重启一次应用'
          : (payload?.error ?? `接口返回 ${response.status}`))
      }
      turns = payload.turns
      currentIndex = indexOfCurrent(turns, currentText)
      const clicked = currentIndex >= 0 ? turns[currentIndex] : undefined
      if (clicked !== undefined && isBackground(clicked.kind)) {
        includeBackground = true
        backgroundToggle.checked = true
        options.includeBackground = true
      }
      if (clicked !== undefined) {
        selected.add(clicked.index)
      } else {
        for (const turn of turns) {
          if (!isBackground(turn.kind))
            selected.add(turn.index)
        }
      }
      renderTurns()
      const hidden = turns.filter((turn) => isBackground(turn.kind)).length
      setStatus(clicked !== undefined
        ? `已定位到当前消息（${KIND_META[clicked.kind]?.label ?? '消息'}）；另有 ${hidden} 条后台/上下文默认隐藏。`
        : `没定位到当前消息，已默认勾选全部正文（${selected.size} 条）；另有 ${hidden} 条后台/上下文已隐藏。`)
    } catch (error) {
      turns = []
      renderTurns()
      setStatus(error instanceof Error ? error.message : String(error), 'error')
    }
  })()
}

exports.apply = apply
exports.inject = ['slots']
