#!/usr/bin/env node
/**
 * Local-dev refresh: rebuild redact from source and push the artifacts
 * into the dsh web profile's installed copy, bypassing pnpm's file:/injected
 * caching (which does not re-pack unchanged-version local packages).
 *
 *   node refresh-local.mjs
 *
 * Restart `dsh web` / DSH Desktop afterwards. Idempotent.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(fileURLToPath(import.meta.url))
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', 'web')
const pkgName = '@dsh-extra/dsh-redact'
const dest = join(profileDir, 'node_modules', ...pkgName.split('/'))

// link: 安装时 dest 就是本仓库（realpath 相同）：lib 已是构建产物本体，无需也不可复制
try {
  if (realpathSync(dest) === realpathSync(repo)) {
    console.log('[redact] profile 中为 link: 安装（即本仓库），lib 构建后即为生效产物，无需复制。重启 dsh 即可加载。')
    process.exit(0)
  }
} catch { /* dest 不存在时走下方常规检查 */ }

if (!existsSync(dest)) {
  console.error(`[redact] ${pkgName} 尚未安装到 profile（${dest} 不存在）。先在 profile 里 pnpm/npm add file: 本目录`)
  process.exit(1)
}

console.log('[redact] 构建 lib（tsc + esbuild client）…')
for (const [command, args] of [
  ['npx', ['tsc', '-b', 'tsconfig.json']],
  ['node', ['scripts/build-client.mjs']],
]) {
  const result = spawnSync(command, args, { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    console.error(`[redact] 命令失败: ${command} ${args.join(' ')}（exit ${result.status}）`)
    process.exit(1)
  }
}

// 部署门禁：插件加载期异常会被 cordis 升级为 fatal 杀死整个宿主（实测），
// 刷进 profile 前先跑全量测试，失败即中止
if (existsSync(join(repo, 'node_modules', 'vitest'))) {
  console.log('[redact] 部署门禁：全量测试…')
  const test = spawnSync('npx', ['vitest', 'run'],
    { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' })
  if (test.status !== 0) {
    console.error('[redact] 测试未通过，已中止刷入 profile')
    process.exit(1)
  }
}

const srcLib = join(repo, 'lib')
if (!existsSync(srcLib)) {
  console.error('[redact] 构建产物 lib/ 不存在')
  process.exit(1)
}
rmSync(join(dest, 'lib'), { recursive: true, force: true })
cpSync(srcLib, join(dest, 'lib'), { recursive: true })
// 同步 package.json：让插件清单显示真实版本（lib 才是运行时本体）
cpSync(join(repo, 'package.json'), join(dest, 'package.json'))

console.log(`[redact] 已同步 lib + package.json → profile（${pkgName}）`)
console.log('[redact] 完成。重启 dsh web / DSH Desktop 后生效。')
