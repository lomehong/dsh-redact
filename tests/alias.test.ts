import { describe, expect, it } from 'vitest'
import {
  builtinRules,
  compileCustomRules,
  compileTermRules,
  createMaskMap,
  maskText,
  restoreText,
  MAX_TERM_RULES,
  MAX_TERM_LENGTH,
  MAX_REPLACEMENT_LENGTH,
} from '../src/rules.ts'
import { normalizeConfigInput } from '../src/index.ts'

const ALL_ON = { secret: true, id: true, bank: true, phone: true, email: true }

/** 占位符字面量必须拼接构造：完整形态出现在本文件里会被还原层改写为真实值。 */
function PH(code: string, n: number): string {
  return '[[' + code + '_' + n + ']]'
}

/** 内置规则 + 别名（模拟编排层的编译顺序：builtins → custom → terms）。 */
function mask(text: string, aliases: Array<{ term: string; replacement: string }>, map = createMaskMap()): string {
  const { rules: term } = compileTermRules(aliases)
  return maskText(text, [...builtinRules(ALL_ON), ...term], map).text
}

describe('别名规则编译：校验', () => {
  it('合法条目编译为字面量规则，替换串就位', () => {
    const { rules, errors } = compileTermRules([
      { term: '腾讯', replacement: '某公司' },
      { term: '阿里', replacement: 'XX公司' },
    ])
    expect(errors).toEqual([])
    expect(rules).toHaveLength(2)
    expect(rules.every((r) => r.replacement !== undefined)).toBe(true)
    expect(rules.every((r) => r.code === 'ALIAS')).toBe(true)
  })

  it('空原词/空替换词 → 报错并跳过', () => {
    const { rules, errors } = compileTermRules([
      { term: '', replacement: '某公司' },
      { term: '腾讯', replacement: '' },
    ])
    expect(rules).toHaveLength(0)
    expect(errors).toHaveLength(2)
  })

  it('原词与替换词相同 → 报错', () => {
    const { rules, errors } = compileTermRules([{ term: '腾讯', replacement: '腾讯' }])
    expect(rules).toHaveLength(0)
    expect(errors[0]).toContain('相同')
  })

  it('占位符形态的原词/替换词 → 拒绝（避免与还原层纠缠）', () => {
    const { rules, errors } = compileTermRules([
      { term: '腾讯', replacement: PH('TEL', 1) },
      { term: PH('TEL', 1), replacement: '某公司' },
    ])
    expect(rules).toHaveLength(0)
    expect(errors).toHaveLength(2)
    expect(errors.every((e) => e.includes('占位符形态'))).toBe(true)
  })

  it('重复原词 → 保留先定义的替换', () => {
    const { rules, errors } = compileTermRules([
      { term: '腾讯', replacement: '某公司' },
      { term: '腾讯', replacement: '另外一家' },
    ])
    expect(errors).toHaveLength(1)
    expect(rules).toHaveLength(1)
    expect(rules[0].replacement).toBe('某公司')
  })

  it('长度/条数上限', () => {
    expect(MAX_TERM_LENGTH).toBeGreaterThan(0)
    expect(MAX_REPLACEMENT_LENGTH).toBeGreaterThan(0)
    const tooLongTerm = { term: '腾'.repeat(MAX_TERM_LENGTH + 1), replacement: '某公司' }
    expect(compileTermRules([tooLongTerm]).errors[0]).toContain('上限')
    const tooLongRep = { term: '腾讯', replacement: '某'.repeat(MAX_REPLACEMENT_LENGTH + 1) }
    expect(compileTermRules([tooLongRep]).errors[0]).toContain('上限')
    const many = Array.from({ length: MAX_TERM_RULES + 1 }, (_, i) => ({ term: `词${i}`, replacement: '某公司' }))
    const { rules, errors } = compileTermRules(many)
    expect(rules).toHaveLength(MAX_TERM_RULES)
    expect(errors.some((e) => e.includes('上限'))).toBe(true)
  })
})

describe('别名替换：脱敏行为', () => {
  it('用户示例：腾讯 → 某公司、阿里 → XX公司（固定串，无编号）', () => {
    const masked = mask('腾讯和阿里都在云上有业务', [
      { term: '腾讯', replacement: '某公司' },
      { term: '阿里', replacement: 'XX公司' },
    ])
    expect(masked).toBe('某公司和XX公司都在云上有业务')
  })

  it('确定性：同一原词永远同一替换词，且不占用占位符编号空间', () => {
    const map = createMaskMap()
    const first = mask('腾讯发布了对腾讯的评价', [{ term: '腾讯', replacement: '某公司' }], map)
    expect(first).toBe('某公司发布了对某公司的评价')
    // 别名不入映射表：forward/reverse 保持为空
    expect(map.forward.size).toBe(0)
    expect(map.reverse.size).toBe(0)
    // 手机号仍走占位符编号（从 1 开始，未被别名挤占）
    const withPhone = mask('腾讯 ' + PH('TEL', 1), [{ term: '腾讯', replacement: '某公司' }], map)
    expect(withPhone).toBe('某公司 ' + PH('TEL', 1))
  })

  it('单向：替换词不被还原层还原', () => {
    const map = createMaskMap()
    const masked = mask('腾讯和阿里都参会', [
      { term: '腾讯', replacement: '某公司' },
      { term: '阿里', replacement: 'XX公司' },
    ], map)
    // 别名替换无映射条目：还原层对其无操作（单向）
    expect(restoreText(masked, map.reverse)).toBe(masked)
    expect(masked).toContain('某公司')
    expect(masked).toContain('XX公司')
  })

  it('幂等：对已脱敏文本重复脱敏结果不变（替换词不含任何原词）', () => {
    const aliases = [{ term: '腾讯', replacement: '某公司' }]
    const once = mask('腾讯的服务', aliases)
    expect(once).toBe('某公司的服务')
    const twice = mask(once, aliases)
    expect(twice).toBe('某公司的服务')
  })

  it('长词优先：定义了 腾讯 与 腾讯云 时，腾讯云 命中 腾讯云 的替换', () => {
    const masked = mask('腾讯云与腾讯合作', [
      { term: '腾讯', replacement: '某公司' },
      { term: '腾讯云', replacement: '某云厂商' },
    ])
    expect(masked).toBe('某云厂商与某公司合作')
  })

  it('正则元字符原词按字面量匹配', () => {
    const masked = mask('a.b+c 与 aXb+c', [{ term: 'a.b+c', replacement: '【点分】' }])
    expect(masked).toBe('【点分】 与 aXb+c')
  })

  it('与自定义正则重叠时让位：自定义规则（更高优先级）先到先得', () => {
    // 自定义正则命中「腾讯控股」整段；别名「腾讯」span 与之重叠 → 丢弃
    const { rules: custom } = compileCustomRules([{ name: '公司全称', pattern: '腾讯控股' }])
    const { rules: alias } = compileTermRules([{ term: '腾讯', replacement: '某公司' }])
    const masked = maskText('腾讯控股发布财报', [...builtinRules(ALL_ON), ...custom, ...alias], createMaskMap()).text
    expect(masked).not.toContain('某公司')
    expect(masked).toContain('[[RULE_1]]')
  })

  it('替换词包含原词时单遍构造不会连锁替换，但重复应用会增长（文档化边界）', () => {
    // 替换词包含原词属病态配置：单遍构造不会连锁（本遍内替换串不再扫描），
    // 但对同一文本重复调用 maskText 会持续增长——引擎约定 maskText 每条流只过一遍。
    const aliases = [{ term: '甲子', replacement: '甲子资本' }]
    const once = mask('甲子和甲子再次合作', aliases)
    expect(once).toBe('甲子资本和甲子资本再次合作')
  })
})

describe('别名规则：配置校验（normalizeConfigInput）', () => {
  const base = {
    maskLlm: true,
    restoreOutput: true,
    maskLogs: true,
    categories: { secret: true, id: true, bank: true, phone: true, email: true },
    customRules: [],
  }

  it('合法别名通过并进入配置', () => {
    const cfg = normalizeConfigInput({ ...base, aliases: [{ term: '腾讯', replacement: '某公司' }] })
    expect(cfg.aliases).toEqual([{ term: '腾讯', replacement: '某公司' }])
  })

  it('原词/替换词为空 → 拒绝', () => {
    expect(() => normalizeConfigInput({ ...base, aliases: [{ term: '', replacement: 'x' }] })).toThrow(/原词不能为空/)
    expect(() => normalizeConfigInput({ ...base, aliases: [{ term: '腾讯', replacement: '' }] })).toThrow(/替换词不能为空/)
  })

  it('重复原词 → 拒绝', () => {
    expect(() => normalizeConfigInput({
      ...base,
      aliases: [
        { term: '腾讯', replacement: '某公司' },
        { term: '腾讯', replacement: '另外一家' },
      ],
    })).toThrow(/重复定义/)
  })

  it('占位符形态 → 拒绝', () => {
    const ph = PH('TEL', 1)
    expect(() => normalizeConfigInput({ ...base, aliases: [{ term: '腾讯', replacement: ph }] })).toThrow(/占位符形态/)
  })

  it('超过 100 条上限 → 拒绝', () => {
    const aliases = Array.from({ length: 101 }, (_, i) => ({ term: `词${i}`, replacement: '某公司' }))
    expect(() => normalizeConfigInput({ ...base, aliases })).toThrow(/100 条上限/)
  })

  it('未提供 aliases 字段时默认空数组（兼容旧配置载荷）', () => {
    const cfg = normalizeConfigInput({ ...base })
    expect(cfg.aliases).toEqual([])
  })
})
