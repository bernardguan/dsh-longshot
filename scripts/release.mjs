/**
 * 一键发版：校验 → 构建 → 测试 → 改版本 → 写 CHANGELOG → 提交 → 打标签。
 *
 * 设计取舍：
 * - **不自动 push**。推送是唯一会把事情变公开的动作，留给维护者按提示执行，
 *   也给「先看一眼 diff」留出机会。
 * - **不依赖任何包**。只用 node:fs / node:child_process。
 * - **git 不在 PATH 也能跑**：用 `GIT_BIN` 指定（本机是便携 MinGit）。
 * - `--dry-run` 只打印计划，不写文件、不执行 git 写操作。
 *
 * 用法：
 *   node scripts/release.mjs patch "修了空会话导致的 500"
 *   node scripts/release.mjs minor "支持 PDF 导出"
 *   node scripts/release.mjs patch "..." --dry-run
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KINDS = ['patch', 'minor', 'major']

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const positional = args.filter((arg) => arg !== '--dry-run')
const [kind, ...rest] = positional
const message = rest.join(' ').trim()

if (!KINDS.includes(kind) || message === '') {
  console.error('用法：node scripts/release.mjs <patch|minor|major> "<一句话说明>" [--dry-run]')
  process.exit(2)
}

/** 解析 git 可执行文件：优先 GIT_BIN，其次 PATH。 */
const gitBin = (() => {
  if (process.env.GIT_BIN !== undefined && process.env.GIT_BIN !== '')
    return process.env.GIT_BIN
  const candidates = ['git', 'C:/Program Files/Git/cmd/git.exe']
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      // 试下一个
    }
  }
  console.error('找不到 git：请把 git 加进 PATH，或用 GIT_BIN 指定可执行文件路径。')
  process.exit(2)
})()

const git = (args2, options = {}) => execFileSync(gitBin, args2, { cwd: root, encoding: 'utf8', ...options }).trim()
const runNode = (script) => execFileSync(process.execPath, [script], { cwd: root, stdio: 'inherit' })
const say = (text) => console.log(`${dryRun ? '[dry-run] ' : ''}${text}`)

/** 计算下一个版本号。 */
function nextVersion(current, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
  if (match === null)
    throw new Error(`package.json 里的版本不是 semver：${current}`)
  let [major, minor, patch] = match.slice(1).map(Number)
  if (bump === 'major') {
    major += 1
    minor = 0
    patch = 0
  }
  else if (bump === 'minor') {
    minor += 1
    patch = 0
  }
  else {
    patch += 1
  }
  return `${major}.${minor}.${patch}`
}

/** 北京时间 YYYY-MM-DD（CHANGELOG 用）。 */
function today() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

// --- 1. 环境校验 ---
const pkgPath = resolve(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const currentVersion = pkg.version
const version = nextVersion(currentVersion, kind)
const tag = `v${version}`

say(`仓库：${root}`)
say(`版本：${currentVersion} → ${version}（${kind}）`)
say(`说明：${message}`)

if (!dryRun) {
  const dirty = git(['status', '--porcelain'])
  if (dirty !== '') {
    console.error('工作区不干净，先提交或 stash：\n' + dirty)
    process.exit(1)
  }
  const existing = git(['tag', '--list', tag])
  if (existing !== '') {
    console.error(`标签 ${tag} 已存在`)
    process.exit(1)
  }
}

// --- 2. 构建 + 测试 ---
say('构建客户端 bundle…')
if (!dryRun)
  runNode('scripts/build-client.mjs')

say('跑测试（Host 冒烟 + 客户端纯函数）…')
if (!dryRun) {
  runNode('test/smoke.mjs')
  runNode('test/client-unit.mjs')
}

// --- 3. 改版本号 ---
say(`package.json version → ${version}`)
if (!dryRun) {
  pkg.version = version
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

  const hostPath = resolve(root, 'lib/index.js')
  const host = readFileSync(hostPath, 'utf8')
  const patched = host.replace(/const VERSION = '\d+\.\d+\.\d+'/, `const VERSION = '${version}'`)
  if (patched === host)
    throw new Error('lib/index.js 里没找到 `const VERSION = ...`，无法同步版本号')
  writeFileSync(hostPath, patched, 'utf8')
}

// --- 4. 写 CHANGELOG（插在第一个 `## ` 之前）---
say('CHANGELOG 顶部插入新版本段落')
if (!dryRun) {
  const changelogPath = resolve(root, 'CHANGELOG.md')
  const changelog = readFileSync(changelogPath, 'utf8')
  const anchor = changelog.search(/^## /m)
  if (anchor < 0)
    throw new Error('CHANGELOG.md 里没有找到 `## ` 段落标题')
  const section = `## ${version} — ${today()}\n\n${message}\n\n`
  writeFileSync(changelogPath, changelog.slice(0, anchor) + section + changelog.slice(anchor), 'utf8')
}

// --- 5. 提交 + 打标签 ---
say(`git commit -m "chore(release): ${tag}"`)
say(`git tag -a ${tag} -m "${tag} — ${message}"`)
if (!dryRun) {
  git(['add', '-A'])
  git(['commit', '-m', `chore(release): ${tag}`])
  git(['tag', '-a', tag, '-m', `${tag} — ${message}`])
}

// --- 6. 收尾提示（推送是人工动作）---
console.log(`
${dryRun ? '（dry-run 未做任何写入）' : '本地已完成，尚未推送。'}下一步：

  git push origin main
  git push origin ${tag}

推送后：
  1) CI 会跑一遍（.github/workflows/ci.yml）；
  2) 到 https://github.com/bernardguan/dsh-longshot/releases/new?tag=${tag} 建 Release，
     标题 ${tag}，描述可直接抄 CHANGELOG 顶部这段。
`)
