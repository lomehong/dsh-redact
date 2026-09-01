import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinRules, createMaskMap, maskText, restoreText } from '../src/rules.ts'
import { MappingStore, isPlaceholderShape } from '../src/mapping.ts'
import { dshHome, loadState, saveState, stateFilePath } from '../src/persist.ts'

const ALL_ON = { secret: true, id: true, bank: true, phone: true, email: true }
const rules = builtinRules(ALL_ON)
const T0 = 1_700_000_000_000

describe('会话映射一致性', () => {
  it('同一值全程同一占位符；不同值按序编号', () => {
    const store = new MappingStore()
    const out1 = store.mask('A 13812345678 B', rules, 's1', T0)
    const out2 = store.mask('A 13812345678 B 13912345678', rules, 's1', T0)
    expect(out1).toBe('A [[TEL_1]] B')
    expect(out2).toBe('A [[TEL_1]] B [[TEL_2]]')
  })
  it('会话间隔离：同值各自从 1 编号', () => {
    const store = new MappingStore()
    expect(store.mask('13812345678', rules, 's1', T0)).toBe('[[TEL_1]]')
    expect(store.mask('13812345678', rules, 's2', T0)).toBe('[[TEL_1]]')
    expect(store.sessionCount()).toBe(2)
  })
  it('还原走同会话反向表', () => {
    const store = new MappingStore()
    const masked = store.mask('13812345678', rules, 's1', T0)
    const map = store.sessionMap('s1', T0)
    expect(restoreText(masked, map.reverse)).toBe('13812345678')
  })
  it('日志全局映射独立于会话映射', () => {
    const store = new MappingStore()
    expect(maskText('13812345678', rules, store.logMap).text).toBe('[[TEL_1]]')
    expect(store.sessionCount()).toBe(0)
  })
  it('createMaskMap 独立实例互不影响', () => {
    const a = createMaskMap()
    const b = createMaskMap()
    expect(maskText('13812345678', rules, a).text).toBe('[[TEL_1]]')
    expect(maskText('13812345678', rules, b).text).toBe('[[TEL_1]]')
  })
})

describe('统计', () => {
  it('按类别累计命中与最近时间', () => {
    const store = new MappingStore()
    store.mask('13812345678 和 13912345678', rules, 's1', T0)
    store.mask('user@example.com', rules, 's1', T0 + 1000)
    const stats = store.snapshotStats()
    expect(stats.categories.TEL.count).toBe(2)
    expect(stats.categories.TEL.lastAt).toBe(T0)
    expect(stats.categories.EMAIL.count).toBe(1)
    expect(stats.categories.EMAIL.lastAt).toBe(T0 + 1000)
  })
  it('合并落盘统计取和与较新时间', () => {
    const store = new MappingStore()
    store.mergePersistedStat('TEL', 5, T0)
    store.mergePersistedStat('TEL', 3, T0 - 100)
    const stats = store.snapshotStats()
    expect(stats.categories.TEL.count).toBe(8)
    expect(stats.categories.TEL.lastAt).toBe(T0)
  })
})

describe('清理策略', () => {
  it('TTL 过期清理', () => {
    const store = new MappingStore()
    store.sessionMap('old', T0)
    store.sessionMap('new', T0 + 1000)
    // old 年龄 = TTL+500（清理）；new 年龄 = TTL-500（保留）
    const removed = store.prune(T0 + 7 * 24 * 3600_000 + 500)
    expect(removed).toBe(1)
    expect(store.sessionCount()).toBe(1)
  })
  it('总量上限按最久未活跃淘汰', () => {
    const store = new MappingStore()
    for (let i = 0; i < 205; i++) store.sessionMap(`s${i}`, T0 + i)
    store.prune(T0 + 205, 7 * 24 * 3600_000, 200)
    expect(store.sessionCount()).toBe(200)
  })
  it('clearSessions 清空', () => {
    const store = new MappingStore()
    store.sessionMap('s1', T0)
    store.clearSessions()
    expect(store.sessionCount()).toBe(0)
  })
})

describe('持久化往返', () => {
  it('toPersistable → loadPersistable 后还原与编号衔接', () => {
    const store = new MappingStore()
    store.mask('13812345678', rules, 's1', T0)
    const dump = store.toPersistable()

    const restored = new MappingStore()
    restored.loadPersistable(dump, T0)
    expect(restored.sessionCount()).toBe(1)
    // 统计不随映射持久化（统计走 mergePersistedStat）
    expect(restored.snapshotStats().categories.TEL).toBeUndefined()
    const map = restored.sessionMap('s1', T0)
    expect(restoreText('[[TEL_1]]', map.reverse)).toBe('13812345678')
    // 正向表重建：同值拿到同一占位符（不重新编号）
    expect(restored.mask('13812345678', rules, 's1', T0)).toBe('[[TEL_1]]')
    // 计数器衔接：新值接续编号
    expect(restored.mask('13912345678', rules, 's1', T0)).toBe('[[TEL_2]]')
  })
  it('loadPersistable 丢弃非法占位符', () => {
    const store = new MappingStore()
    store.loadPersistable({ sessions: { s1: { lastActive: T0, reverse: { '[[TEL_1]]': 'ok', 'not-a-placeholder': 'x', '[[TEL_2]]': '' } } } }, T0)
    const map = store.sessionMap('s1', T0)
    expect(map.reverse.size).toBe(1)
  })
  it('loadPersistable 触发过期清理', () => {
    const store = new MappingStore()
    store.loadPersistable({ sessions: { old: { lastActive: T0, reverse: {} } } }, T0 + 8 * 24 * 3600_000)
    expect(store.sessionCount()).toBe(0)
  })
})

describe('isPlaceholderShape', () => {
  it('形态判定', () => {
    expect(isPlaceholderShape('[[TEL_1]]')).toBe(true)
    expect(isPlaceholderShape('[[R_123]]')).toBe(true)
    expect(isPlaceholderShape('[[tel_1]]')).toBe(false)
    expect(isPlaceholderShape('[[TEL_]]')).toBe(false)
    expect(isPlaceholderShape('[[TEL_99999999999]]')).toBe(false)
  })
})

describe('state.json 读写', () => {
  let home = ''
  const savedEnv = process.env.DSH_REDACT_HOME
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.DSH_REDACT_HOME
    else process.env.DSH_REDACT_HOME = savedEnv
    if (home !== '') await rm(home, { recursive: true, force: true })
    home = ''
  })
  it('save → load 往返；损坏文件回退 undefined', async () => {
    home = await mkdtemp(join(tmpdir(), 'redact-persist-'))
    await saveState(home, { version: 1, maps: { sessions: { s1: { lastActive: T0, reverse: { '[[TEL_1]]': '13812345678' } } } }, stats: { categories: { TEL: { count: 2, lastAt: T0 } } } })
    const loaded = await loadState(home)
    expect(loaded?.version).toBe(1)
    expect(loaded?.maps.sessions.s1.reverse['[[TEL_1]]']).toBe('13812345678')
    expect(loaded?.stats.categories.TEL.count).toBe(2)
    await writeFile(stateFilePath(home), '{broken', 'utf8')
    expect(await loadState(home)).toBeUndefined()
  })
  it('dshHome 环境变量优先级', () => {
    process.env.DSH_REDACT_HOME = '/data/r'
    process.env.DSH_HOME = '/data/dsh'
    expect(dshHome()).toBe('/data/r')
    delete process.env.DSH_REDACT_HOME
    expect(dshHome()).toBe('/data/dsh')
    delete process.env.DSH_HOME
    expect(dshHome()).toBe(join(homedir(), '.dsh'))
  })
})
