/**
 * 客户端半的纯函数单测（不需要浏览器、不需要 DOM）。
 *
 * lib/client.js 是给浏览器用的 `window.__ModuleLoader__` 产物，这里用一个最小桩
 * 把工厂跑起来，只测那些**不依赖 canvas/DOM** 的判定逻辑：
 * - 长图高度上限与截断标志（200000 / 200001 这类边界，不值得真起浏览器跑 40 万像素）
 * - 回合类型的后台判定
 *
 * 用法：node test/client-unit.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let registration
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      registration = entry
    },
  },
}

// 产物是纯脚本（顶层就调 window.__ModuleLoader__.load），用 eval 而不是 import，
// 这样不依赖 Node 对 .js 的模块判定（package.json 里是 type: module，但内容是浏览器脚本）。
const source = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', source)(globalThis.window)

if (registration === undefined)
  throw new Error('bundle 没有注册到 __ModuleLoader__')

const fakeReact = {
  createElement: () => ({}),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}
const exports = registration.factory((spec) => {
  if (spec === 'react')
    return fakeReact
  throw new Error(`unexpected require: ${spec}`)
})

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) })
  if (!condition)
    console.error(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// --- bundle 契约 ---
check('bundle id 正确', registration.id === 'dsh-longshot', String(registration.id))
check('声明 inject = [slots]', JSON.stringify(exports.inject) === '["slots"]', JSON.stringify(exports.inject))
check('导出 apply', typeof exports.apply === 'function')
check('导出测试钩子', typeof exports.__test === 'object' && exports.__test !== null)

const { planStageHeight, isBackground, KIND_META } = exports.__test ?? {}

// --- 高度上限与截断（边界值）---
const cases = [
  { input: 0, height: 1, truncated: false, why: '空内容也至少 1px' },
  { input: 1, height: 1, truncated: false },
  { input: 199_999, height: 199_999, truncated: false },
  { input: 200_000, height: 200_000, truncated: false, why: '正好到上限，不算截断' },
  { input: 200_001, height: 200_000, truncated: true, why: '超出 1px 就要报截断' },
  { input: 10_000_000, height: 200_000, truncated: true, why: '极端值收敛到上限' },
]
for (const item of cases) {
  const plan = planStageHeight(item.input)
  check(`高度 ${item.input} → ${item.height}${item.truncated ? ' + 截断' : ''}`,
    plan.height === item.height && plan.truncated === item.truncated,
    JSON.stringify(plan) + (item.why ? `（${item.why}）` : ''))
}
check('高度计划是纯函数（同输入同输出）',
  JSON.stringify(planStageHeight(200_001)) === JSON.stringify(planStageHeight(200_001)))
check('非法输入不产生 NaN 高度', Number.isFinite(planStageHeight(Number.MAX_SAFE_INTEGER).height))

// --- 回合类型判定 ---
check('step 属于后台', isBackground('step') === true)
check('context 属于后台', isBackground('context') === true)
check('user 不属于后台', isBackground('user') === false)
check('answer 不属于后台', isBackground('answer') === false)
check('未知类型不属于后台（防御）', isBackground('whatever') === false)

for (const kind of ['user', 'answer', 'step', 'context']) {
  check(`KIND_META 覆盖 ${kind}`, typeof KIND_META?.[kind]?.label === 'string' && typeof KIND_META[kind].style === 'string')
}
check('KIND_META 只有四种', Object.keys(KIND_META ?? {}).length === 4, String(Object.keys(KIND_META ?? {}).length))

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0)
  process.exitCode = 1
else
  console.log('客户端纯函数单测全部通过')
