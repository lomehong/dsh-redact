import { describe, expect, it } from 'vitest'
import { builtinRules, compileTermRules, createMaskMap, maskText, restoreText } from '../src/rules.ts'

describe('确认：别名规则的真实行为（出站/入站两向）', () => {
  const aliases = compileTermRules([{ term: '腾讯', replacement: '某公司' }]).rules
  const all = [...builtinRules({ secret: true, id: true, bank: true, phone: true, email: true }), ...aliases]
  const map = createMaskMap()

  it('出站：「腾讯」被替换为「某公司」', () => {
    const { text } = maskText('帮我分析腾讯的财报', all, map)
    console.log('出站结果:', JSON.stringify(text))
    expect(text).toBe('帮我分析某公司的财报')
  })

  it('入站：替换词「某公司」是否被还原回「腾讯」', () => {
    // 模拟模型回复中出现替换词——reverse 表里是否有「某公司 → 腾讯」？
    console.log('reverse 是否含替换词条目:', map.reverse.has('某公司'))
    const restored = restoreText('某公司 2025 年营收创新高，某公司的股价也涨了', map.reverse)
    console.log('入站还原结果:', JSON.stringify(restored))
    // 记录事实（不断言方向，让输出说话）
  })

  it('对照：占位符规则是双向的（出站打码/入站还原）', () => {
    const map2 = createMaskMap()
    const out = maskText('联系 13812345678', all, map2)
    console.log('出站结果:', JSON.stringify(out.text))
    const restored = restoreText(out.text, map2.reverse)
    console.log('入站还原:', JSON.stringify(restored))
    expect(restored).toBe('联系 13812345678') // 占位符规则确实双向
  })
})
