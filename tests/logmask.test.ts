import { describe, expect, it } from 'vitest'
import { builtinRules, createMaskMap } from '../src/rules.ts'
import { installLogMask, maskValue, type ExporterLike, type LoggerServiceLike, type LogMessageLike } from '../src/logmask.ts'

const rules = builtinRules({ secret: true, id: true, bank: true, phone: true, email: true })

function message(args: unknown[]): LogMessageLike {
  return { sn: 1, ts: 2, name: 'test', type: 'info', level: 1, args }
}

function harness(): { svc: LoggerServiceLike; seen: LogMessageLike[]; registerCount: () => number } {
  const seen: LogMessageLike[] = []
  let count = 0
  const svc: LoggerServiceLike = {
    exporters: new Map(),
    exporter(target: ExporterLike): unknown {
      const key = ++count
      svc.exporters.set(key, target)
      return () => svc.exporters.delete(key)
    },
  }
  return { svc, seen, registerCount: () => count }
}

describe('maskValue 深遍历', () => {
  it('字符串打码；数字/布尔原样', () => {
    const map = createMaskMap()
    expect(maskValue('手机 13812345678', rules, map)).toBe('手机 [[TEL_1]]')
    expect(maskValue(12345, rules, map)).toBe(12345)
    expect(maskValue(true, rules, map)).toBe(true)
  })
  it('嵌套对象/数组打码；无敏感内容时返回原引用', () => {
    const map = createMaskMap()
    const dirty = { user: { phone: '13812345678' }, tags: ['user@example.com'], n: 1 }
    const masked = maskValue(dirty, rules, map) as typeof dirty
    expect(masked.user.phone).toBe('[[TEL_1]]')
    expect(masked.tags[0]).toBe('[[EMAIL_1]]')
    expect(masked.n).toBe(1)
    const clean = { a: 1, b: ['x'] }
    expect(maskValue(clean, rules, map)).toBe(clean)
  })
  it('超深度截断（不抛错）', () => {
    const map = createMaskMap()
    const deep = { a: { b: { c: { d: { e: '13812345678' } } } } }
    expect(maskValue(deep, rules, map, 0)).toBe(deep) // 第 5 层超出 MAX_WALK_DEPTH，原样
  })
  it('Error 实例等奇异对象不深遍历、原样返回', () => {
    const map = createMaskMap()
    const err = new Error('13812345678')
    expect(maskValue(err, rules, map)).toBe(err)
  })
})

describe('installLogMask', () => {
  it('现有 exporter 被包装：args 打码、原对象不动', () => {
    const h = harness()
    const seen: LogMessageLike[] = []
    h.svc.exporter({ export: (m) => { seen.push(m) } })
    const enabled = () => true
    const handle = installLogMask(h.svc, () => rules, createMaskMap(), enabled, () => {})
    h.svc.exporters.forEach((e) => e.export(message(['手机 13812345678'])))
    expect(seen).toHaveLength(1)
    expect(seen[0].args[0]).toBe('手机 [[TEL_1]]')
    expect(seen[0].sn).toBe(1)
    handle.dispose()
  })
  it('后续注册的 exporter 也被包装；disposer 透传可注销', () => {
    const h = harness()
    const handle = installLogMask(h.svc, () => rules, createMaskMap(), () => true, () => {})
    const seen: LogMessageLike[] = []
    const disposer = h.svc.exporter({ export: (m) => { seen.push(m) } }) as () => void
    h.svc.exporters.forEach((e) => e.export(message(['user@example.com'])))
    expect(seen[0].args[0]).toBe('[[EMAIL_1]]')
    disposer()
    expect(h.svc.exporters.size).toBe(0)
    handle.dispose()
  })
  it('enabled=false 时放行原文；恢复后继续打码', () => {
    const h = harness()
    let on = false
    const handle = installLogMask(h.svc, () => rules, createMaskMap(), () => on, () => {})
    const seen: LogMessageLike[] = []
    h.svc.exporter({ export: (m) => { seen.push(m) } })
    h.svc.exporters.forEach((e) => e.export(message(['13812345678'])))
    expect(seen[0].args[0]).toBe('13812345678')
    on = true
    h.svc.exporters.forEach((e) => e.export(message(['13812345678'])))
    expect(seen[1].args[0]).toBe('[[TEL_1]]')
    handle.dispose()
  })
  it('规则函数返回空数组 → 不打码（配置关闸）', () => {
    const h = harness()
    const handle = installLogMask(h.svc, () => [], createMaskMap(), () => true, () => {})
    const seen: LogMessageLike[] = []
    h.svc.exporter({ export: (m) => { seen.push(m) } })
    h.svc.exporters.forEach((e) => e.export(message(['13812345678'])))
    expect(seen[0].args[0]).toBe('13812345678')
    handle.dispose()
  })
  it('dispose 还原方法补丁与已替换条目', () => {
    const h = harness()
    const seen: LogMessageLike[] = []
    h.svc.exporter({ export: (m) => { seen.push(m) } })
    const original = [...h.svc.exporters.values()][0]
    const handle = installLogMask(h.svc, () => rules, createMaskMap(), () => true, () => {})
    // 安装后 Map 里是代理
    expect(h.svc.exporters.size).toBe(1)
    handle.dispose()
    expect(h.svc.exporters.size).toBe(1)
    expect([...h.svc.exporters.values()][0]).toBe(original)
    // 方法补丁已还原：再注册的 exporter 不再被包装
    const late: LogMessageLike[] = []
    h.svc.exporter({ export: (m) => { late.push(m) } })
    h.svc.exporters.forEach((e) => e.export(message(['13812345678'])))
    expect(late[0].args[0]).toBe('13812345678')
    expect(seen[0].args[0]).toBe('13812345678') // 已还原为原 exporter：输出不再打码
  })
  it('重复安装不叠加包装（幂等防御）', () => {
    const h = harness()
    const originalCalls: LogMessageLike[] = []
    h.svc.exporter({ export: (m) => { originalCalls.push(m) } })
    const first = installLogMask(h.svc, () => rules, createMaskMap(), () => true, () => {})
    const second = installLogMask(h.svc, () => rules, createMaskMap(), () => true, () => {})
    // 第二次安装遇到已包装条目跳过：底层数仍恰好打到一次
    h.svc.exporters.forEach((e) => e.export(message(['13812345678'])))
    expect(originalCalls).toHaveLength(1)
    expect(originalCalls[0].args[0]).toBe('[[TEL_1]]')
    first.dispose()
    second.dispose()
  })
})
