/**
 * llm/stream waterfall 监听器：出站消息脱敏 + 入站 chunk 占位符还原。
 *
 * 出站：`next()` 不收参数，而 waterfall 的 fallback 闭包读的是 options 同一引用，
 * 因此必须**原地重赋** `options.messages`（换数组引用）与 `options.system`——
 * request 对象由循环逐请求新构建（未冻结），重赋安全；单条消息是会话投影的
 * 冻结对象，克隆进新数组承接脱敏内容；本机会话历史不受影响（保留原文）。
 *
 * 入站：包装 next() 返回的 AsyncIterable。text/reasoning/tool-call 三类 delta
 * 过 PlaceholderRestorer（按块索引分账的跨 chunk 边界缓冲）；block-end 携带的
 * 完整块是消费方（BlockAssembler）的权威版本，整块还原后丢弃对应缓冲；
 * delta-only 流（无 block-end）在 finish 前把残余缓冲合成 text-delta 补发。
 *
 * 热路径全 try/catch 回退：脱敏/还原任何异常都放原文/透传，绝不打断 LLM 调用。
 */
import {
  maskText,
  restoreText,
  type CompiledRule,
  type MaskHit,
  type MaskMap,
} from './rules.ts'

/* ─────────────── 结构化最小视图（避免引入重型 dsh 包） ─────────────── */

export interface TextBlockLike { type: 'text'; text: string }
export interface ReasoningBlockLike { type: 'reasoning'; text: string }
export interface ToolCallBlockLike { type: 'tool-call'; id: string; name: string; arguments: string }
export interface ToolResultBlockLike { type: 'tool-result'; toolCallId: string; content: ContentBlockLike[]; isError?: boolean }
export type ContentBlockLike = TextBlockLike | ReasoningBlockLike | ToolCallBlockLike | ToolResultBlockLike | { type: string } & Record<string, unknown>

export interface MessageLike {
  readonly id: unknown
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: readonly ContentBlockLike[]
  readonly source?: unknown
}

export interface GenerateOptionsLike {
  provider: string
  model: string
  messages: readonly MessageLike[]
  system?: string
  sessionId?: unknown
  [key: string]: unknown
}

export type StreamChunkLike =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlockLike }
  | { type: 'usage'; usage: unknown }
  | { type: 'finish'; reason: unknown; replayState?: unknown }
  | { type: string } & Record<string, unknown>

/* ─────────────── 出站：消息遍历脱敏 ─────────────── */

/** 克隆脱敏一个 content 块数组（不变更原对象；无关块共享引用）。 */
export function maskContentBlocks(blocks: readonly ContentBlockLike[], rules: readonly CompiledRule[], map: MaskMap): { blocks: ContentBlockLike[]; hits: MaskHit[] } {
  const out: ContentBlockLike[] = []
  const hits: MaskHit[] = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') {
      out.push(block)
      continue
    }
    switch (block.type) {
      case 'text':
      case 'reasoning': {
        const result = maskText(String((block as TextBlockLike).text ?? ''), rules, map)
        hits.push(...result.hits)
        out.push({ ...(block as TextBlockLike), text: result.text })
        break
      }
      case 'tool-call': {
        const call = block as ToolCallBlockLike
        const result = maskText(String(call.arguments ?? ''), rules, map)
        hits.push(...result.hits)
        out.push({ ...call, arguments: result.text })
        break
      }
      case 'tool-result': {
        const nested = maskContentBlocks((block as ToolResultBlockLike).content ?? [], rules, map)
        hits.push(...nested.hits)
        out.push({ ...(block as ToolResultBlockLike), content: nested.blocks })
        break
      }
      default:
        out.push(block) // image 及未知块原样保留
    }
  }
  return { blocks: out, hits }
}

/** 克隆脱敏一条消息数组（单条消息是冻结投影：新对象承接脱敏内容，原对象不动）。 */
export function maskMessages(messages: readonly MessageLike[], rules: readonly CompiledRule[], map: MaskMap): { messages: MessageLike[]; hits: MaskHit[] } {
  const out: MessageLike[] = []
  const hits: MaskHit[] = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') {
      out.push(message)
      continue
    }
    const masked = maskContentBlocks(message.content ?? [], rules, map)
    hits.push(...masked.hits)
    out.push({ ...message, content: masked.blocks })
  }
  return { messages: out, hits }
}

/** 出站请求脱敏：options 是 waterfall 闭包与适配器共享的同一引用，next() 又不收参数，
 *  因此必须**原地重赋** `options.messages`（数组引用）与 `options.system`——request
 *  对象由循环逐请求新构建（未冻结），重赋安全；单条消息是冻结投影，克隆后放入新数组。
 *  返回命中列表；任何异常回退为不处理（返回空命中）。 */
export function maskOutbound(options: GenerateOptionsLike, rules: readonly CompiledRule[], map: MaskMap): MaskHit[] {
  try {
    const hits: MaskHit[] = []
    if (Array.isArray(options.messages)) {
      const masked = maskMessages(options.messages, rules, map)
      hits.push(...masked.hits)
      options.messages = masked.messages
    }
    if (typeof options.system === 'string' && options.system !== '') {
      const maskedSystem = maskText(options.system, rules, map)
      options.system = maskedSystem.text
      hits.push(...maskedSystem.hits)
    }
    return hits
  } catch {
    return []
  }
}

/* ─────────────── 入站：流式还原 ─────────────── */

/**
 * 占位符可能被拆进多个 delta。按块索引缓冲尾部：尾部若是 `[[CODE_N]]` 的
 * 严格前缀（或疑似开头 `[`/`[[`）则扣住不发，避免半截占位符漏给消费方。
 */
export class PlaceholderRestorer {
  private buffers = new Map<number, string>()

  constructor(private readonly reverse: Map<string, string>) {}

  /** 喂入一段 delta 文本，返回可安全发出的部分（已还原完整占位符）。 */
  feed(index: number, text: string): string {
    if (text === '') return ''
    const pending = (this.buffers.get(index) ?? '') + text
    const safeEnd = holdbackIndex(pending)
    this.buffers.set(index, pending.slice(safeEnd))
    return safeEnd === 0 ? '' : restoreText(pending.slice(0, safeEnd), this.reverse)
  }

  /** 块结束：返回并清空该索引的残余（已还原）。 */
  flush(index: number): string {
    const pending = this.buffers.get(index)
    if (pending === undefined || pending === '') return ''
    this.buffers.delete(index)
    return restoreText(pending, this.reverse)
  }

  /** 流结束：清空所有残余，按 index 升序返回。 */
  flushAll(): Array<{ index: number; text: string }> {
    const out: Array<{ index: number; text: string }> = []
    for (const index of [...this.buffers.keys()].sort((a, b) => a - b)) {
      const text = this.flush(index)
      if (text !== '') out.push({ index, text })
    }
    return out
  }
}

/** 尾部可完成占位符前缀（`[[`、`[[CODE`、`[[CODE_`、`[[CODE_12`、含结尾 `]]` 的中间态）。
 *  必须 ^ 锚定：holdbackIndex 逐位置测试后缀，无锚时 `[[` 在串中任意处都能命中。 */
const PLACEHOLDER_PREFIX_RE = /^\[\[(?:[A-Z0-9]{0,24}(?:_(?:\d{0,10})?)?)?$/

/** 返回 pending 中可安全发出的截止位置：其后若有疑似占位符前缀则扣住。 */
export function holdbackIndex(pending: string): number {
  // 只需检查尾部窗口（占位符最长 = 2 + 24 + 1 + 10 + 2 = 39，窗口取 48）
  const windowStart = Math.max(0, pending.length - 48)
  for (let i = windowStart; i < pending.length; i++) {
    if (PLACEHOLDER_PREFIX_RE.test(pending.slice(i))) return i
  }
  // 孤立的结尾 '[' 也可能是跨 chunk 的 '[['
  if (pending.endsWith('[')) return pending.length - 1
  return pending.length
}

/** 还原一个完整 content 块（block-end 权威块 / 合成块）。无关块原样返回。 */
export function restoreBlock(block: ContentBlockLike, reverse: Map<string, string>): ContentBlockLike {
  if (block === null || typeof block !== 'object') return block
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return { ...(block as TextBlockLike), text: restoreText(String((block as TextBlockLike).text ?? ''), reverse) }
    case 'tool-call':
      return { ...(block as ToolCallBlockLike), arguments: restoreText(String((block as ToolCallBlockLike).arguments ?? ''), reverse) }
    case 'tool-result':
      return { ...(block as ToolResultBlockLike), content: (block as ToolResultBlockLike).content.map((b) => restoreBlock(b, reverse)) }
    default:
      return block
  }
}

/** 包装 chunk 流做入站还原；任何异常透传原始 chunk（宁可不还原，不可断流）。 */
export async function* restoreChunks(chunks: AsyncIterable<StreamChunkLike>, restorer: PlaceholderRestorer, reverse: Map<string, string>): AsyncGenerator<StreamChunkLike> {
  for await (const chunk of chunks) {
    try {
      switch (chunk?.type) {
        case 'text-delta':
        case 'reasoning-delta': {
          const text = restorer.feed((chunk as { index: number }).index, (chunk as { text: string }).text)
          if (text !== '') yield { ...(chunk as object), text } as StreamChunkLike
          break
        }
        case 'tool-call-delta': {
          const argumentsDelta = restorer.feed((chunk as { index: number }).index, (chunk as { argumentsDelta: string }).argumentsDelta)
          if (argumentsDelta !== '') yield { ...(chunk as object), argumentsDelta } as StreamChunkLike
          break
        }
        case 'block-end': {
          restorer.flush((chunk as { index: number }).index) // 权威块包含全部内容，缓冲作废
          yield { ...(chunk as object), block: restoreBlock((chunk as { block: ContentBlockLike }).block, reverse) } as StreamChunkLike
          break
        }
        case 'finish': {
          // delta-only 流（无 block-end）的残余缓冲合成 text-delta 补发
          for (const { index, text } of restorer.flushAll()) {
            yield { type: 'text-delta', index, text }
          }
          yield chunk
          break
        }
        default:
          yield chunk
      }
    } catch {
      yield chunk
    }
  }
}

/* ─────────────── waterfall 适配 ─────────────── */

export interface StreamDeps {
  /** 取 sessionId 对应映射表（含创建/触碰）。 */
  mapFor(options: GenerateOptionsLike): MaskMap
  /** 命中统计回调。 */
  onHits(hits: readonly MaskHit[]): void
  /** 当前生效的脱敏规则（空数组 = 出站跳过）。 */
  rules: () => readonly CompiledRule[]
  /** 入站占位符还原开关。 */
  restore: () => boolean
}

/** llm/stream 监听器主体：`(options, next) => Promise<AsyncIterable>`。
 *  cordis waterfall 会 await 监听器返回值，Promise 形态合法。 */
export function makeStreamListener(deps: StreamDeps): (options: GenerateOptionsLike, next: () => AsyncIterable<StreamChunkLike>) => Promise<AsyncIterable<StreamChunkLike>> {
  return async (options, next) => {
    try {
      const activeRules = deps.rules()
      if (activeRules.length > 0) {
        const hits = maskOutbound(options, activeRules, deps.mapFor(options))
        deps.onHits(hits)
      }
    } catch {
      /* 出站脱敏失败：放原文，不打断调用 */
    }
    const chunks = await next()
    try {
      if (!deps.restore()) return chunks
      const reverse = deps.mapFor(options).reverse
      return restoreChunks(chunks, new PlaceholderRestorer(reverse), reverse)
    } catch {
      return chunks
    }
  }
}
