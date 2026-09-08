/**
 * 回归：占位符 [[CODE_N]] 被 delta 边界拆在 `]]` 两个字符之间时的还原。
 * 修复前：前一 delta 以 [[CODE_N] 结尾直接发出，合并结果含裸占位符（还原失败）。
 */
import { describe, expect, it } from 'vitest'
import { PlaceholderRestorer, holdbackIndex } from '../src/stream.ts'

describe('holdback：]] 跨 chunk 拆分（回归）', () => {
  const reverse = new Map([['[[TEL_1]]', '13800001111']])

  it('拆在 ]] 之间：两段合并后应被完整还原', () => {
    const r = new PlaceholderRestorer(reverse)
    const out1 = r.feed(0, '他的手机号是 [[TEL_1]')
    const out2 = r.feed(0, '] 后面')
    expect(out1).toBe('他的手机号是 ') // 前缀安全区发出，[[TEL_1] 被扣
    expect(out1 + out2).toBe('他的手机号是 13800001111 后面') // 下一段到齐后合并还原
  })

  it('holdbackIndex 对 [[CODE_N] 结尾返回扣留位置', () => {
    expect(holdbackIndex('x[[TEL_1]')).toBe(1) // 从 [[ 起扣
  })

  it('完整占位符在 chunk 尾部不扣（restoreSegment 直接还原）', () => {
    expect(holdbackIndex('手机号 [[TEL_1]]')).toBe('手机号 [[TEL_1]]'.length)
    const r = new PlaceholderRestorer(reverse)
    const out = r.feed(0, '手机号 [[TEL_1]]')
    expect(out).toBe('手机号 13800001111')
  })
})
