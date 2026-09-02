import { describe, expect, it } from 'vitest'
import { ProbeAudit } from '../src/audit.ts'
import { createMaskMap, restoreText } from '../src/rules.ts'
import { PlaceholderRestorer } from '../src/stream.ts'

/** 占位符字面量必须拼接构造：完整形态出现在本文件里会被还原层改写为真实值。 */
function PH(code: string, n: number): string {
  return '[[' + code + '_' + n + ']]'
}

const MIN = 60_000

describe('ProbeAudit：测试框高频调用', () => {
  it('窗口内超过阈值 → 告警一次（冷却去重）', () => {
    const audit = new ProbeAudit({ windowMs: 10 * MIN, testMaxCalls: 3, log: () => {} })
    const t0 = 1_000_000
    let warnings = 0
    for (let i = 0; i < 5; i++) {
      const w = audit.recordTestCall(t0 + i * MIN)
      if (w !== undefined) warnings++
    }
    // 4 次调用即越过阈值 3，但冷却期内只告警一次
    expect(warnings).toBe(1)
    const snapshot = audit.snapshot()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].kind).toBe('test-flood')
    expect(snapshot[0].subject).toBe('test-endpoint')
  })

  it('窗口滑出后冷却解除，可再次告警', () => {
    const audit = new ProbeAudit({ windowMs: 10 * MIN, testMaxCalls: 2, log: () => {} })
    const t0 = 1_000_000
    let count = 0
    for (let i = 0; i < 3; i++) if (audit.recordTestCall(t0 + i) !== undefined) count++
    expect(count).toBe(1) // 首窗口告警一次
    // 窗口滑出后再次越限 → 第二次告警
    for (let i = 10; i < 14; i++) if (audit.recordTestCall(t0 + i * MIN) !== undefined) count++
    expect(count).toBe(2)
  })

  it('低频正常使用不告警', () => {
    const audit = new ProbeAudit({ windowMs: 10 * MIN, testMaxCalls: 30, log: () => {} })
    const t0 = 1_000_000
    for (let i = 0; i < 10; i++) expect(audit.recordTestCall(t0 + i * MIN)).toBeUndefined()
    expect(audit.snapshot()).toHaveLength(0)
  })

  it('告警环封顶（保留最近 N 条）', () => {
    const audit = new ProbeAudit({ windowMs: 10 * MIN, testMaxCalls: 0, maxWarnings: 2, log: () => {} })
    const t0 = 1_000_000
    for (let w = 0; w < 5; w++) audit.recordTestCall(t0 + w * 20 * MIN)
    expect(audit.snapshot().length).toBe(2)
    // 新→旧：首条是最近的
    expect(audit.snapshot()[0].at).toBeGreaterThan(audit.snapshot()[1].at)
  })
})

describe('ProbeAudit：占位符还原激增（按会话）', () => {
  it('单会话窗口内还原个数超阈值 → 告警', () => {
    const audit = new ProbeAudit({ windowMs: 10 * MIN, restoreMaxPerSession: 10, log: () => {} })
    const t0 = 1_000_000
    let warning
    // 每次还原 3 个占位符，4 次 = 12 > 10
    for (let i = 0; i < 4; i++) warning = audit.recordRestore('sess-a', t0 + i, 3)
    expect(warning).toBeDefined()
    expect(warning!.kind).toBe('restore-flood')
    expect(warning!.subject).toBe('sess-a')
  })

  it('按会话隔离：两个会话各 60 个不告警，合计 120 也不误伤', () => {
    const audit = new ProbeAudit({ windowMs: 10 * MIN, restoreMaxPerSession: 100, log: () => {} })
    const t0 = 1_000_000
    for (let i = 0; i < 6; i++) {
      expect(audit.recordRestore('sess-a', t0 + i, 10)).toBeUndefined()
      expect(audit.recordRestore('sess-b', t0 + i, 10)).toBeUndefined()
    }
    expect(audit.snapshot()).toHaveLength(0)
  })

  it('还原个数为 0 时不记账不告警', () => {
    const audit = new ProbeAudit({ windowMs: 10 * MIN, restoreMaxPerSession: 1, log: () => {} })
    expect(audit.recordRestore('sess-a', 1_000_000, 0)).toBeUndefined()
    expect(audit.snapshot()).toHaveLength(0)
  })
})

describe('PlaceholderRestorer：还原计数挂钩', () => {
  it('完整占位符在 feed 时立即还原并回报计数（holdback 只针对跨 chunk 半截占位符）', () => {
    const reverse = new Map<string, string>([[PH('TEL', 1), PH('TEL', 2)]])
    const seen: number[] = []
    const restorer = new PlaceholderRestorer(reverse, (n) => { seen.push(n) })
    expect(restorer.feed(0, PH('TEL', 1))).toBe(PH('TEL', 2))
    expect(restorer.flush(0)).toBe('')
    expect(seen).toEqual([1])
  })

  it('跨 chunk 拆分的占位符：计数在 flush 完成还原时回报', () => {
    const reverse = new Map<string, string>([[PH('TEL', 1), PH('TEL', 2)]])
    const seen: number[] = []
    const restorer = new PlaceholderRestorer(reverse, (n) => { seen.push(n) })
    expect(restorer.feed(0, '[[TEL')).toBe('')          // 半截：扣住
    expect(restorer.feed(0, '_1]]')).toBe(PH('TEL', 2)) // 补齐：还原
    expect(seen).toEqual([1])
  })

  it('无占位符的文本不触发计数', () => {
    const reverse = new Map<string, string>([[PH('TEL', 1), PH('TEL', 2)]])
    const seen: number[] = []
    const restorer = new PlaceholderRestorer(reverse, (n) => { seen.push(n) })
    expect(restorer.feed(0, '普通文本 without any placeholder')).toBe('普通文本 without any placeholder')
    expect(restorer.flush(0)).toBe('')
    expect(seen).toHaveLength(0)
  })
})
