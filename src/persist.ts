/**
 * 状态持久化：~/.dsh/redact/state.json（临时文件 + 原子重命名）。
 * 保存会话映射（占位符↔真实值反向表 + 活跃时间）与类别命中统计。
 * 原文本本就在本地会话存储中，映射落盘不增加暴露面。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PersistedMaps, RedactStats } from './mapping.ts'

export interface PersistedState {
  version: 1
  maps: PersistedMaps
  stats: RedactStats
}

export function stateFilePath(homeDir: string): string {
  return join(homeDir, 'redact', 'state.json')
}

/** 测试可覆盖的 DSH home：优先专用环境变量，其次跟随宿主 DSH_HOME，兜底 ~/.dsh。 */
export function dshHome(): string {
  return process.env.DSH_REDACT_HOME
    ?? process.env.DSH_HOME
    ?? join(homedir(), '.dsh')
}

export async function loadState(homeDir: string): Promise<PersistedState | undefined> {
  try {
    const raw = JSON.parse(await readFile(stateFilePath(homeDir), 'utf8')) as PersistedState
    if (raw === null || typeof raw !== 'object' || raw.version !== 1) return undefined
    if (raw.maps === null || typeof raw.maps !== 'object') return undefined
    if (raw.stats === null || typeof raw.stats !== 'object') return undefined
    return raw
  } catch {
    return undefined // 文件不存在或损坏：全新状态
  }
}

export async function saveState(homeDir: string, state: PersistedState): Promise<void> {
  const path = stateFilePath(homeDir)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}
