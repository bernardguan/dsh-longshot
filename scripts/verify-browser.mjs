/**
 * 浏览器端自检：不启动桌面端，用一个最小 DOM 桩把 lib/client.js 跑起来，
 * 走一遍「注册 slot → 点按钮 → 打开面板 → 请求渲染 → canvas 光栅 → 拿到 PNG Blob」。
 *
 * 输出：tmp/harness.html（给 headless Chrome 执行）以及事后解码出的 tmp/harness.png。
 *
 * 用法：
 *   node scripts/verify-browser.mjs            # 生成 harness
 *   chrome --headless=new --dump-dom file:///.../harness.html > dom.txt
 *   node scripts/verify-browser.mjs decode dom.txt
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2] ?? 'build'

if (mode === 'decode') {
  const domPath = process.argv[3]
  const outPath = process.argv[4] ?? resolve(root, '../../tmp/harness.png')
  const dom = readFileSync(domPath, 'utf8')
  const match = /id="out"[^>]*>([A-Za-z0-9+/=\s]+)</.exec(dom)
  if (match === null) {
    const log = /id="log"[^>]*>([\s\S]*?)<\/pre>/.exec(dom)?.[1] ?? '(无日志)'
    console.error('没有拿到 PNG 数据。页面日志：\n' + decodeEntities(log))
    process.exit(1)
  }
  const bytes = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
  writeFileSync(outPath, bytes)
  const log = /id="log"[^>]*>([\s\S]*?)<\/pre>/.exec(dom)?.[1] ?? ''
  console.log(decodeEntities(log).trim())
  console.log(`\nPNG ${(bytes.length / 1024).toFixed(1)} KiB → ${outPath}`)
  process.exit(0)
}

const bundle = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
const sample = readFileSync(resolve(root, '../../tmp/preview.html'), 'utf8')
/** 模拟 slot 注入的「当前消息纯文本」：取值与样品里的第一条助手消息一致。 */
const currentAssistantText = '我核对了本机实际安装的插件产物（`dsh-companion` 0.6.0），下面这些按钮与提示文案都来自它的真实代码。'

const panelOnly = process.argv[2] === 'panel'
const exportMode = process.argv[2] === 'all' ? 'all' : (process.argv[2] === 'panelbg' ? 'panelbg' : 'default')
const harness = `<!doctype html>
<meta charset="utf-8">
<title>dsh-longshot harness</title>
<pre id="log"></pre>
<pre id="out"></pre>
<script>window.__SAMPLE__ = ${JSON.stringify(sample)}</script>
<script>const PANEL_ONLY = ${panelOnly}; const EXPORT_MODE = ${JSON.stringify(exportMode)}</script>
<script>
  const logEl = document.getElementById('log')
  const log = (message) => { logEl.textContent += message + '\\n' }
  const realFetch = window.fetch.bind(window)
  let registration
  window.__ModuleLoader__ = { load: (entry) => { registration = entry } }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  }
  const requireShim = (spec) => {
    if (spec === 'react') return React
    throw new Error('unexpected require: ' + spec)
  }
  window.__downloads = []
  HTMLAnchorElement.prototype.click = function () { window.__downloads.push(this.href) }
</script>
<script>${bundle}</script>
<script>
  void (async () => {
    try {
      if (registration === undefined) throw new Error('bundle 没有注册到 __ModuleLoader__')
      const exports = registration.factory(requireShim)
      log('bundle id = ' + registration.id + ' | inject = ' + JSON.stringify(exports.inject))
      let component
      let options
      const ctx = {
        effect: (fn) => { fn(); return () => {} },
        slots: {
          inject: (_name, contribute) => { contribute(); return () => {} },
          register: (opts, comp) => { options = opts; component = comp; return () => {} },
        },
      }
      exports.apply(ctx)
      log('slot = ' + options.name + ' | id = ' + options.id)
      // 模拟 slot 注入的 props：sessionId + 当前消息纯文本（用于默认勾选）。
      const currentText = ${JSON.stringify(currentAssistantText)}
      const element = component({ sessionId: 'session-preview-0001', messageId: 'msg-2', text: currentText })
      log('trigger = ' + element.props.children)
      const TURNS = [
        { index: 0, role: 'user', kind: 'user', tools: [], preview: 'dsh-companion 的使用方法，如何导出长图？', chars: 20 },
        { index: 1, role: 'assistant', kind: 'answer', tools: [], preview: currentText.length <= 90 ? currentText : currentText.slice(0, 90) + '…', chars: 1200 },
        { index: 2, role: 'user', kind: 'context', tools: [], preview: '<system-reminder> The following workspace instructions may be relevant…', chars: 840 },
        { index: 3, role: 'assistant', kind: 'step', tools: ['grep'], preview: '找到了：lib/client/components/ 下只有 7 个 .js', chars: 200 },
      ]
      window.fetch = async (url, init) => {
        const body = JSON.parse(init.body)
        log('fetch ' + url + ' body=' + JSON.stringify(body))
        if (String(url).endsWith('/longshot/turns')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ turns: TURNS }),
            text: async () => JSON.stringify({ turns: TURNS }),
          }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => JSON.stringify({
            fileName: 'harness.png',
            stats: { turns: Array.isArray(body.turns) ? body.turns.length : TURNS.length, chars: 0, width: body.width },
            html: window.__SAMPLE__,
          }),
        }
      }
      element.props.onClick({ preventDefault() {}, stopPropagation() {} })
      // 等回合清单加载完，检查默认勾选是否落在「当前这条」上。
      const waitFor = async (probe, label) => {
        const until = Date.now() + 15000
        while (Date.now() < until) {
          const value = probe()
          if (value !== undefined && value !== null)
            return value
          await new Promise((r) => setTimeout(r, 100))
        }
        throw new Error('等待超时：' + label)
      }
      const checked = await waitFor(() => {
        const boxes = [...document.querySelectorAll('input[type=checkbox]')]
        const checkedIndexes = boxes.map((b, i) => (b.checked ? i : -1)).filter((i) => i >= 0)
        return boxes.length >= 6 ? checkedIndexes : undefined
      }, '回合勾选列表')
      log('默认勾选的复选框序号 = ' + JSON.stringify(checked) + '（4 个选项框 + 2 个可见回合 = 6 个盒子）')
      if (EXPORT_MODE === 'all' || EXPORT_MODE === 'panelbg') {
        const bgToggle = [...document.querySelectorAll('label')].find((l) => l.textContent.includes('包含后台步骤与注入上下文'))
        if (bgToggle === undefined) throw new Error('找不到「包含后台步骤与注入上下文」开关')
        bgToggle.querySelector('input').click()
        await new Promise((r) => setTimeout(r, 200))
        const rowsNow = [...document.querySelectorAll('input[type=checkbox]')]
        log('打开后台开关后复选框总数 = ' + rowsNow.length)
        const allButton = [...document.querySelectorAll('button')].find((b) => b.textContent === '全选')
        allButton.click()
        await new Promise((r) => setTimeout(r, 200))
      }
      if (PANEL_ONLY || EXPORT_MODE === 'panelbg') { log('panel-only：停在面板，不导出'); return }
      const runButton = [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('导出') && b.textContent !== '导出范围')
      if (runButton === undefined) throw new Error('面板里没有「导出」按钮')
      const runCs = getComputedStyle(runButton)
      log('导出按钮：' + JSON.stringify(runButton.textContent) + ' | disabled=' + runButton.disabled + ' | bg=' + runCs.backgroundColor + ' | opacity=' + runCs.opacity)
      log('panel rendered, clicking 导出')
      runButton.click()
      const deadline = Date.now() + 90000
      while (window.__downloads.length === 0 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 200))
      if (window.__downloads.length === 0) throw new Error('90s 内没有产生下载 Blob')
      const blob = await (await realFetch(window.__downloads[0])).blob()
      log('blob = ' + blob.type + ' / ' + blob.size + ' bytes')
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
      document.getElementById('out').textContent = base64
      log('done')
    } catch (error) {
      log('FAILED: ' + (error && error.message ? error.message : String(error)))
      log('stack: ' + (error && error.stack ? String(error.stack).slice(0, 500) : ''))
    }
  })()
</script>
`

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

const outPath = resolve(root, '../../tmp/harness.html')
writeFileSync(outPath, harness, 'utf8')
console.log(`harness → ${outPath}`)
