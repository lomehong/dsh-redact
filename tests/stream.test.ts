import { describe, expect, it } from 'vitest'
import { builtinRules, createMaskMap, type MaskHit } from '../src/rules.ts'
import {
  holdbackIndex,
  makeStreamListener,
  maskMessages,
  maskOutbound,
  maskContentBlocks,
  PlaceholderRestorer,
  restoreChunks,
  restoreBlock,
  type ContentBlockLike,
  type GenerateOptionsLike,
  type MessageLike,
  type StreamChunkLike,
} from '../src/stream.ts'

const rules = builtinRules({ secret: true, id: true, bank: true, phone: true, email: true })

function textMessage(text: string): MessageLike {
  return Object.freeze({
    id: 'm1',
    role: 'user',
    content: [Object.freeze({ type: 'text', text })],
    source: Object.freeze({ kind: 'user' }),
  }) as unknown as MessageLike
}

async function collect(iter: AsyncIterable<StreamChunkLike>): Promise<StreamChunkLike[]> {
  const out: StreamChunkLike[] = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

describe('出站脱敏：消息遍历', () => {
  it('文本块脱敏且不动冻结原对象', () => {
    const original = textMessage('手机 13812345678')
    const map = createMaskMap()
    const { messages } = maskMessages([original], rules, map)
    expect(messages[0]).not.toBe(original)
    expect((messages[0].content[0] as { text: string }).text).toBe('手机 [[TEL_1]]')
    expect((original.content[0] as { text: string }).text).toBe('手机 13812345678')
  })
  it('tool-call 的 arguments JSON 脱敏', () => {
    const call: ContentBlockLike = { type: 'tool-call', id: 'c1', name: 'edit', arguments: '{"content":"call 13812345678"}' }
    const map = createMaskMap()
    const { blocks } = maskContentBlocks([call], rules, map)
    expect((blocks[0] as { arguments: string }).arguments).toBe('{"content":"call [[TEL_1]]"}')
  })
  it('tool-result 嵌套内容递归脱敏；image 跳过', () => {
    const image = { type: 'image', attachment: { id: 'att1' } }
    const result: ContentBlockLike = {
      type: 'tool-result',
      toolCallId: 'c1',
      content: [{ type: 'text', text: '结果含 user@example.com' }, image],
    }
    const map = createMaskMap()
    const { blocks } = maskContentBlocks([result], rules, map)
    const nested = (blocks[0] as { content: ContentBlockLike[] }).content
    expect((nested[0] as { text: string }).text).toBe('结果含 [[EMAIL_1]]')
    expect(nested[1]).toBe(image)
  })
  it('maskOutbound 原地重赋 messages/system，其余字段不动', () => {
    const options: GenerateOptionsLike = {
      provider: 'deepseek',
      model: 'chat',
      messages: [textMessage('13812345678')],
      system: '客服热线 13912345678',
      sessionId: 'sess-1',
      temperature: 0.7,
    }
    const map = createMaskMap()
    const hits = maskOutbound(options, rules, map)
    // 同一对象、换数组引用：waterfall fallback 闭包读到的就是脱敏后的内容
    expect((options.messages[0].content[0] as { text: string }).text).toBe('[[TEL_1]]')
    expect(options.system).toBe('客服热线 [[TEL_2]]')
    expect(options.temperature).toBe(0.7)
    expect(options.sessionId).toBe('sess-1')
    expect(hits).toHaveLength(2)
    // 消息对象是克隆：冻结原投影不动（用独立冻结样本验证）
    const frozen = textMessage('13812345678')
    maskOutbound({ provider: 'p', model: 'm', messages: [frozen] }, rules, createMaskMap())
    expect((frozen.content[0] as { text: string }).text).toBe('13812345678')
  })
  it('异常回退：坏输入不抛出，options 不动', () => {
    const bad = { provider: 'p', model: 'm', get messages(): never { throw new Error('boom') } } as unknown as GenerateOptionsLike
    expect(maskOutbound(bad, rules, createMaskMap())).toEqual([])
  })
})

describe('流式还原：边界缓冲', () => {
  it('holdbackIndex 判定', () => {
    expect(holdbackIndex('abc[[TE')).toBe(3)
    expect(holdbackIndex('abc[')).toBe(3)
    expect(holdbackIndex('abc[[TEL_1]]')).toBe(12) // 完整占位符不扣留（[[TEL_1]] 共 9 字符）
    expect(holdbackIndex('abc[[tel')).toBe(8) // 小写非占位符形态
    expect(holdbackIndex('')).toBe(0)
  })
  it('占位符完整到达 → 直接还原', () => {
    const map = createMaskMap()
    map.reverse.set('[[TEL_1]]', '13812345678')
    const r = new PlaceholderRestorer(map.reverse)
    expect(r.feed(0, '手机 [[TEL_1]] 完')).toBe('手机 13812345678 完')
  })
  it('占位符跨三个 chunk 拆分 → 拼齐后还原', () => {
    const map = createMaskMap()
    map.reverse.set('[[TEL_1]]', '13812345678')
    const r = new PlaceholderRestorer(map.reverse)
    expect(r.feed(0, '手机 [[TE')).toBe('手机 ')
    expect(r.feed(0, 'L_1')).toBe('')
    expect(r.feed(0, ']] 完')).toBe('13812345678 完')
    expect(r.flush(0)).toBe('')
  })
  it('flush 补发未闭合的疑似前缀（流中断场景）', () => {
    const map = createMaskMap()
    map.reverse.set('[[TEL_1]]', '13812345678')
    const r = new PlaceholderRestorer(map.reverse)
    expect(r.feed(0, '值 [[TEL_1')).toBe('值 ')
    expect(r.flush(0)).toBe('[[TEL_1')
  })
  it('多块索引独立缓冲', () => {
    const map = createMaskMap()
    map.reverse.set('[[EMAIL_1]]', 'user@example.com')
    map.reverse.set('[[TEL_1]]', '13812345678')
    const r = new PlaceholderRestorer(map.reverse)
    expect(r.feed(0, '[[EMAIL_')).toBe('')
    expect(r.feed(1, '[[TEL_1]] ok')).toBe('13812345678 ok')
    expect(r.feed(0, '1]] done')).toBe('user@example.com done')
  })
  it('flushAll 按 index 升序', () => {
    const map = createMaskMap()
    map.reverse.set('[[TEL_1]]', 'x')
    const r = new PlaceholderRestorer(map.reverse)
    r.feed(2, '[[TEL_1')
    r.feed(0, '[[TEL_1')
    expect(r.flushAll()).toEqual([
      { index: 0, text: '[[TEL_1' },
      { index: 2, text: '[[TEL_1' },
    ])
  })
  it('restoreBlock 覆盖 text/reasoning/tool-call/tool-result；无关块原样', () => {
    const map = createMaskMap()
    map.reverse.set('[[TEL_1]]', '13812345678')
    map.reverse.set('[[EMAIL_1]]', 'a@b.com')
    expect(restoreBlock({ type: 'text', text: '[[TEL_1]]' }, map.reverse)).toEqual({ type: 'text', text: '13812345678' })
    expect(restoreBlock({ type: 'reasoning', text: '[[TEL_1]]' }, map.reverse)).toEqual({ type: 'reasoning', text: '13812345678' })
    expect(restoreBlock({ type: 'tool-call', id: 'c', name: 'n', arguments: '{"v":"[[TEL_1]]"}' }, map.reverse)).toEqual({ type: 'tool-call', id: 'c', name: 'n', arguments: '{"v":"13812345678"}' })
    const restored = restoreBlock({ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: '[[EMAIL_1]]' }] }, map.reverse)
    expect((restored as { content: Array<{ text: string }> }).content[0].text).toBe('a@b.com')
    const image = { type: 'image' } as ContentBlockLike
    expect(restoreBlock(image, map.reverse)).toBe(image)
  })
})

describe('restoreChunks 流处理', () => {
  const reverse = () => {
    const m = createMaskMap()
    m.reverse.set('[[TEL_1]]', '13812345678')
    return m.reverse
  }
  async function run(chunks: StreamChunkLike[], rev: Map<string, string>): Promise<StreamChunkLike[]> {
    return collect(restoreChunks(chunks as never, new PlaceholderRestorer(rev), rev))
  }
  it('text-delta 还原 + 空 delta 被抑制', async () => {
    const out = await run([
      { type: 'text-delta', index: 0, text: '' },
      { type: 'text-delta', index: 0, text: '[[TEL_' },
      { type: 'text-delta', index: 0, text: '1]] ok' },
    ], reverse())
    expect(out.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text)).toEqual(['13812345678 ok'])
  })
  it('reasoning-delta 同样还原', async () => {
    const out = await run([{ type: 'reasoning-delta', index: 1, text: '[[TEL_1]]' }], reverse())
    expect((out[0] as { text: string }).text).toBe('13812345678')
  })
  it('tool-call-delta 的 JSON 片段跨块还原', async () => {
    const out = await run([
      { type: 'tool-call-delta', index: 0, id: 'c1', name: 'write', argumentsDelta: '{"path":"a.txt","content":"[[TEL_' },
      { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '1]]"}' },
    ], reverse())
    expect(out.map((c) => (c as { argumentsDelta: string }).argumentsDelta).join('')).toBe('{"path":"a.txt","content":"13812345678"}')
  })
  it('block-end 权威块整块还原并丢弃缓冲（不合成 delta）', async () => {
    const out = await run([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '[[TEL_' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '完整 [[TEL_1]]' } },
    ], reverse())
    // block-start 直通；疑似前缀被扣住且由权威块覆盖（无合成 delta）；block-end 整块还原
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('block-start')
    expect((out[1] as { block: { text: string } }).block.text).toBe('完整 13812345678')
  })
  it('finish 前补发 delta-only 残余缓冲', async () => {
    const out = await run([
      { type: 'text-delta', index: 0, text: '值 [[TEL_1' },
      { type: 'finish', reason: { kind: 'stop' } },
    ], reverse())
    expect(out).toHaveLength(3)
    expect(out[1]).toEqual({ type: 'text-delta', index: 0, text: '[[TEL_1' })
    expect(out[2].type).toBe('finish')
  })
  it('usage/finish/未知 chunk 原样透传', async () => {
    const usage = { type: 'usage', usage: { input: 1 } } as StreamChunkLike
    const weird = { type: 'custom-thing', x: 1 } as unknown as StreamChunkLike
    const out = await run([usage, weird], reverse())
    expect(out[0]).toBe(usage)
    expect(out[1]).toBe(weird)
  })
})

describe('冻结请求（0.1.2 agent-loop deepFreeze）', () => {
  function frozenOptions(text: string, system?: string): GenerateOptionsLike {
    return Object.freeze({
      provider: 'p', model: 'm', sessionId: 's1',
      messages: Object.freeze([textMessage(text)]),
      ...(system !== undefined ? { system } : {}),
    }) as unknown as GenerateOptionsLike
  }

  it('冻结 + streamDirect：克隆脱敏二次下发，原请求不动，还原只在外层一次', async () => {
    const map = createMaskMap()
    let hitCount = 0
    const listener = makeStreamListener({
      mapFor: () => map,
      onHits: (hits) => { hitCount += hits.length },
      rules: () => rules,
      restore: () => true,
      streamDirect: (clone) =>
        // 模拟真实二次派发：重入同一监听器（WeakSet 命中 → 跳过脱敏与还原）
        listener(clone, async () => (async function* () {
          yield { type: 'text-delta', index: 0, text: '收到 [[TEL_1]]' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()),
    })
    const options = frozenOptions('手机 13812345678', '热线 13912345678')
    const result = await listener(options, async () => {
      throw new Error('冻结路径不应调用 next()')
    })
    const chunks = await collect(result)
    expect((options.messages[0].content[0] as { text: string }).text).toBe('手机 13812345678')
    expect(options.system).toBe('热线 13912345678')
    expect((chunks[0] as { text: string }).text).toBe('收到 13812345678')
    expect(chunks[1].type).toBe('finish')
    expect(hitCount).toBe(2) // 消息 1 次 + system 1 次
  })

  it('冻结 + streamDirect 抛异常 → 回退 next() 原文放行', async () => {
    const listener = makeStreamListener({
      mapFor: () => createMaskMap(),
      onHits: () => {},
      rules: () => rules,
      restore: () => true,
      streamDirect: () => { throw new Error('llm service unavailable') },
    })
    const options = frozenOptions('手机 13812345678')
    let nextCalled = false
    const result = await listener(options, async () => {
      nextCalled = true
      return (async function* () { yield { type: 'text-delta', index: 0, text: 'plain' } })()
    })
    const chunks = await collect(result)
    expect(nextCalled).toBe(true)
    expect((chunks[0] as { text: string }).text).toBe('plain')
  })

  it('冻结 + 无 streamDirect：放行原文（降级不生效，不阻断）', async () => {
    const listener = makeStreamListener({ mapFor: () => createMaskMap(), onHits: () => {}, rules: () => rules, restore: () => true })
    const options = frozenOptions('手机 13812345678')
    let nextCalled = false
    const result = await listener(options, async () => {
      nextCalled = true
      return (async function* () { yield { type: 'text-delta', index: 0, text: 'plain [[TEL_1]]' } })()
    })
    const chunks = await collect(result)
    expect(nextCalled).toBe(true)
    expect((chunks[0] as { text: string }).text).toBe('plain [[TEL_1]]')
  })

  it('可变请求仍走原地重赋（不触发二次下发）', async () => {
    let nestedCalls = 0
    const listener = makeStreamListener({
      mapFor: () => createMaskMap(),
      onHits: () => {},
      rules: () => rules,
      restore: () => true,
      streamDirect: () => { nestedCalls++; return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })() },
    })
    const options: GenerateOptionsLike = { provider: 'p', model: 'm', messages: [textMessage('13812345678')] }
    const result = await listener(options, async () => (async function* () { yield { type: 'text-delta', index: 0, text: 'x' } })())
    await collect(result)
    expect((options.messages[0].content[0] as { text: string }).text).toBe('[[TEL_1]]')
    expect(nestedCalls).toBe(0)
  })
})

describe('makeStreamListener 端到端', () => {
  it('出站替换 messages；入站还原；命中统计回调', async () => {
    const map = createMaskMap()
    let hitCount = 0
    const onHits = (hits: readonly MaskHit[]) => { hitCount += hits.length }
    const listener = makeStreamListener({ mapFor: () => map, onHits, rules: () => rules, restore: () => true })
    const options: GenerateOptionsLike = {
      provider: 'p', model: 'm',
      messages: [textMessage('手机 13812345678')],
      sessionId: 's1',
    }
    const upstream: StreamChunkLike[] = [
      { type: 'text-delta', index: 0, text: '收到 [[TEL_1]]' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const result = await listener(options, async () => {
      const optionsCopy: GenerateOptionsLike = options
      return (async function* () {
        expect((optionsCopy.messages[0].content[0] as { text: string }).text).toBe('手机 [[TEL_1]]')
        for (const c of upstream) yield c
      })()
    })
    const chunks = await collect(result)
    expect((chunks[0] as { text: string }).text).toBe('收到 13812345678')
    expect(chunks[1].type).toBe('finish')
    expect(hitCount).toBe(1)
  })
  it('规则为空（开关关闭）→ 出入站均原样', async () => {
    const map = createMaskMap()
    const listener = makeStreamListener({ mapFor: () => map, onHits: () => {}, rules: () => [], restore: () => true })
    const options: GenerateOptionsLike = { provider: 'p', model: 'm', messages: [textMessage('13812345678')] }
    const result = await listener(options, async () => (async function* () { yield { type: 'text-delta', index: 0, text: 'x' } })())
    const chunks = await collect(result)
    expect(chunks).toEqual([{ type: 'text-delta', index: 0, text: 'x' }])
    expect((options.messages[0].content[0] as { text: string }).text).toBe('13812345678')
  })
  it('restore 开关关闭 → 入站占位符不还原', async () => {
    const map = createMaskMap()
    map.reverse.set('[[TEL_1]]', '13812345678')
    const listener = makeStreamListener({ mapFor: () => map, onHits: () => {}, rules: () => rules, restore: () => false })
    const result = await listener(
      { provider: 'p', model: 'm', messages: [] },
      async () => (async function* () { yield { type: 'text-delta', index: 0, text: '值 [[TEL_1]]' } })(),
    )
    const chunks = await collect(result)
    expect((chunks[0] as { text: string }).text).toBe('值 [[TEL_1]]')
  })
  it('mapFor 抛异常 → 请求与流原样透传（不打断调用）', async () => {
    const listener = makeStreamListener({
      mapFor: () => { throw new Error('boom') },
      onHits: () => {},
      rules: () => rules,
      restore: () => true,
    })
    const options: GenerateOptionsLike = { provider: 'p', model: 'm', messages: [textMessage('13812345678')] }
    const result = await listener(options, async () => (async function* () { yield { type: 'text-delta', index: 0, text: 'plain' } })())
    const chunks = await collect(result)
    expect(chunks).toEqual([{ type: 'text-delta', index: 0, text: 'plain' }])
  })
})
