import { describe, expect, it } from 'vitest'
import {
  builtinRules,
  compileCustomRules,
  createMaskMap,
  customRuleCode,
  maskText,
  restoreText,
  MAX_CUSTOM_RULES,
  MAX_PATTERN_LENGTH,
} from '../src/rules.ts'

const ALL_ON = { secret: true, id: true, bank: true, phone: true, email: true }
const rules = () => builtinRules(ALL_ON)

function mask(text: string, map = createMaskMap()): string {
  return maskText(text, rules(), map).text
}

describe('内置规则：密钥/凭据（SECRET）', () => {
  it.each([
    ['sk-abc123def456ghi789'],
    ['AKIAIOSFODNN7EXAMPLE'],
    ['ghp_AbcdefGhijklmnopqrstuvwx0123456789ABCD'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'],
    ['Bearer abcdef1234567890abcdef'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEpA\n-----END RSA PRIVATE KEY-----'],
  ])('整串脱敏：%s', (sample) => {
    const masked = mask(`前缀 ${sample} 后缀`)
    expect(masked).toMatch(/\[\[SECRET_1\]\]/)
    expect(masked).not.toContain(sample.slice(0, 10))
  })

  it('key=value 型只脱敏值部分，保留变量名', () => {
    const masked = mask('password: SuperSecret123')
    expect(masked).toBe('password: [[SECRET_1]]')
  })

  it('短凭据不误伤（长度门槛）', () => {
    expect(mask('password: short')).toBe('password: short')
    expect(mask('Bearer abc')).toBe('Bearer abc')
  })
})

describe('内置规则：身份证（ID）', () => {
  it('18 位校验码通过 → 脱敏', () => {
    expect(mask('身份证 11010519491231002X 客户')).toBe('身份证 [[ID_1]] 客户')
  })
  it('18 位校验码不通过 → 不脱敏', () => {
    expect(mask('110105194912310021')).toBe('110105194912310021')
  })
  it('15 位一代证（出生段合理）→ 脱敏', () => {
    expect(mask('110105491231002')).toBe('[[ID_1]]')
  })
  it('日期段不合理 → 不脱敏', () => {
    // 校验码恰好正确但出生段 19491332 非法 — 构造：先用合法样本换月份
    expect(mask('110105194913310 02X')).not.toContain('[[ID_')
  })
})

describe('内置规则：银行卡（BANK，Luhn）', () => {
  it('Luhn 通过 → 脱敏', () => {
    expect(mask('卡号 4111111111111111。')).toBe('卡号 [[BANK_1]]。')
  })
  it('Luhn 不通过 → 不脱敏', () => {
    expect(mask('4111111111111112')).toBe('4111111111111112')
  })
})

describe('内置规则：手机号（TEL）', () => {
  it('标准手机号 → 脱敏', () => {
    expect(mask('联系 13812345678 谢谢')).toBe('联系 [[TEL_1]] 谢谢')
  })
  it('不合法号段（12 开头）→ 不脱敏', () => {
    expect(mask('12812345678')).toBe('12812345678')
  })
  it('长数字段内不截取手机号', () => {
    expect(mask('订单号 1138123456789012')).not.toContain('[[TEL_')
  })
})

describe('内置规则：邮箱（EMAIL）', () => {
  it('标准邮箱 → 脱敏', () => {
    expect(mask('发给 user@example.com')).toBe('发给 [[EMAIL_1]]')
  })
  it('邮箱本地部分恰为手机号时，TEL 优先命中', () => {
    const masked = mask('13812345678@example.com')
    expect(masked).toBe('[[TEL_1]]@example.com')
  })
})

describe('优先级与重叠消解', () => {
  it('Bearer 后接邮箱：凭据优先，邮箱单独命中', () => {
    const map = createMaskMap()
    const result = maskText('Bearer abcdef1234567890 和 user@example.com', rules(), map)
    expect(result.text).toBe('Bearer [[SECRET_1]] 和 [[EMAIL_1]]')
  })
  it('18 位身份证优先于银行卡模式（13-19 位数字段）', () => {
    expect(mask('11010519491231002X')).toBe('[[ID_1]]')
  })
  it('混合内容一次性脱敏并保持一致性', () => {
    const map = createMaskMap()
    const text = '张三 13812345678，邮箱 zhangsan@example.com，卡 4111111111111111；重复手机 13812345678'
    const { text: masked } = maskText(text, rules(), map)
    expect(masked).toBe('张三 [[TEL_1]]，邮箱 [[EMAIL_1]]，卡 [[BANK_1]]；重复手机 [[TEL_1]]')
  })
  it('幂等：脱敏结果再脱敏不变', () => {
    const map = createMaskMap()
    const once = maskText('13812345678 / user@example.com / sk-abc123def456ghi789', rules(), map).text
    const twice = maskText(once, rules(), map).text
    expect(twice).toBe(once)
  })
})

describe('自定义规则', () => {
  it('规则名提取字母数字作为类别码', () => {
    expect(customRuleCode('orderID 12')).toBe('ORDERID12')
    expect(customRuleCode('工单号')).toBe('RULE')
  })
  it('命中自定义正则', () => {
    const map = createMaskMap()
    const { rules: custom } = compileCustomRules([{ name: 'orderID', pattern: 'TK-\\d{6}' }])
    const { text } = maskText('工单 TK-123456 已建', [...rules(), ...custom], map)
    expect(text).toBe('工单 [[ORDERID_1]] 已建')
  })
  it('非法正则进入 errors 且不参与匹配', () => {
    const { rules: custom, errors } = compileCustomRules([{ name: 'bad', pattern: '([unclosed' }])
    expect(custom).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('bad')
  })
  it('正则超长被拒', () => {
    const { rules: custom, errors } = compileCustomRules([{ name: 'long', pattern: 'a'.repeat(MAX_PATTERN_LENGTH + 1) }])
    expect(custom).toHaveLength(0)
    expect(errors[0]).toContain('上限')
  })
  it(`超过 ${MAX_CUSTOM_RULES} 条上限被忽略`, () => {
    const many = Array.from({ length: MAX_CUSTOM_RULES + 2 }, (_, i) => ({ name: `r${i}`, pattern: `X${i}` }))
    const { rules: custom, errors } = compileCustomRules(many)
    expect(custom).toHaveLength(MAX_CUSTOM_RULES)
    expect(errors.some((e) => e.includes('上限'))).toBe(true)
  })
})

describe('还原', () => {
  it('占位符还原为真实值', () => {
    const map = createMaskMap()
    const { text: masked } = maskText('手机 13812345678', rules(), map)
    expect(restoreText(masked, map.reverse)).toBe('手机 13812345678')
  })
  it('一段内容多个同类别值：各自占位符、全部可还原', () => {
    const map = createMaskMap()
    const original = '张三 13812345678、李四 13912345678、王五 15612345678 各自联系'
    const { text: masked } = maskText(original, rules(), map)
    expect(masked).toBe('张三 [[TEL_1]]、李四 [[TEL_2]]、王五 [[TEL_3]] 各自联系')
    expect(restoreText(masked, map.reverse)).toBe(original)
  })
  it('一段内容多类别多值混合：每个值独立占位符、全部可还原', () => {
    const map = createMaskMap()
    const original = [
      '密钥一 sk-abc123def456ghi789',
      '密钥二 sk-xyz789uvw456rst123',
      '手机 13812345678 与 18612345678',
      '邮箱 alice@example.com、bob@test.org',
      '卡号 4111111111111111',
      '重复手机 13812345678',
    ].join('\n')
    const { text: masked } = maskText(original, rules(), map)
    expect(masked).toContain('[[SECRET_1]]')
    expect(masked).toContain('[[SECRET_2]]')
    expect(masked).toContain('[[TEL_1]]')
    expect(masked).toContain('[[TEL_2]]')
    expect(masked).toContain('[[EMAIL_1]]')
    expect(masked).toContain('[[EMAIL_2]]')
    expect(masked).toContain('[[BANK_1]]')
    expect(masked).not.toContain('13812345678')
    expect(masked).not.toContain('sk-')
    // 逐值还原回原文（含重复值的两次出现）
    expect(restoreText(masked, map.reverse)).toBe(original)
  })
  it('未知同形占位符原样保留', () => {
    const map = createMaskMap()
    expect(restoreText('[[UNKNOWN_9]]', map.reverse)).toBe('[[UNKNOWN_9]]')
  })
  it('无占位符文本快速路径', () => {
    expect(restoreText('普通文本 [[ 无占位', createMaskMap().reverse)).toBe('普通文本 [[ 无占位')
  })
})

describe('类别开关', () => {
  it('关闭的类别不参与匹配', () => {
    const onlyPhone = builtinRules({ secret: false, id: false, bank: false, phone: true, email: false })
    const map = createMaskMap()
    const { text } = maskText('13812345678 user@example.com', onlyPhone, map)
    expect(text).toBe('[[TEL_1]] user@example.com')
  })
})
