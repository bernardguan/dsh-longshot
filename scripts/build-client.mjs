/**
 * 客户端半构建：把 src/raster.js + src/ui.js 内联成单个
 * `window.__ModuleLoader__.load({ id, factory })` 产物。
 *
 * 为什么不用打包器：DSH 的客户端插件 bundle 由宿主原样下发给浏览器，模块系统
 * 只认 __ModuleLoader__ 注册（factory 内只能 require 基座模块，不支持相对 import
 * 与 CSS module）。这里把所有源码拼进同一个工厂闭包，天然满足该契约，也省掉了
 * 一条只能在本机跑的构建链。
 *
 * 用法：node scripts/build-client.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(resolve(root, relative), 'utf8')

const raster = read('src/raster.js')
const ui = read('src/ui.js')

const banner = `/**
 * dsh-longshot —— 客户端半（构建产物，请勿直接编辑）。
 * 源码：src/raster.js（光栅引擎）+ src/ui.js（按钮与面板）；构建：scripts/build-client.mjs
 */
window.__ModuleLoader__.load({
  id: "dsh-longshot",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

`

const footer = `
    return module.exports;
  }
});
`

const bundle = banner + raster + '\n\n' + ui + footer
mkdirSync(resolve(root, 'lib'), { recursive: true })
writeFileSync(resolve(root, 'lib/client.js'), bundle, 'utf8')
console.log(`lib/client.js  ${(Buffer.byteLength(bundle) / 1024).toFixed(1)} KiB`)
