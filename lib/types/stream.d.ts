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
import { type CompiledRule, type MaskHit, type MaskMap } from './rules.ts';
export interface TextBlockLike {
    type: 'text';
    text: string;
}
export interface ReasoningBlockLike {
    type: 'reasoning';
    text: string;
}
export interface ToolCallBlockLike {
    type: 'tool-call';
    id: string;
    name: string;
    arguments: string;
}
export interface ToolResultBlockLike {
    type: 'tool-result';
    toolCallId: string;
    content: ContentBlockLike[];
    isError?: boolean;
}
export type ContentBlockLike = TextBlockLike | ReasoningBlockLike | ToolCallBlockLike | ToolResultBlockLike | {
    type: string;
} & Record<string, unknown>;
export interface MessageLike {
    readonly id: unknown;
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: readonly ContentBlockLike[];
    readonly source?: unknown;
}
export interface GenerateOptionsLike {
    provider: string;
    model: string;
    messages: readonly MessageLike[];
    system?: string;
    sessionId?: unknown;
    [key: string]: unknown;
}
export type StreamChunkLike = {
    type: 'block-start';
    index: number;
    blockType: string;
} | {
    type: 'text-delta';
    index: number;
    text: string;
} | {
    type: 'reasoning-delta';
    index: number;
    text: string;
} | {
    type: 'tool-call-delta';
    index: number;
    id: string;
    name?: string;
    argumentsDelta: string;
} | {
    type: 'block-end';
    index: number;
    block: ContentBlockLike;
} | {
    type: 'usage';
    usage: unknown;
} | {
    type: 'finish';
    reason: unknown;
    replayState?: unknown;
} | {
    type: string;
} & Record<string, unknown>;
/** 克隆脱敏一个 content 块数组（不变更原对象；无关块共享引用）。 */
export declare function maskContentBlocks(blocks: readonly ContentBlockLike[], rules: readonly CompiledRule[], map: MaskMap): {
    blocks: ContentBlockLike[];
    hits: MaskHit[];
};
/** 克隆脱敏一条消息数组（单条消息是冻结投影：新对象承接脱敏内容，原对象不动）。 */
export declare function maskMessages(messages: readonly MessageLike[], rules: readonly CompiledRule[], map: MaskMap): {
    messages: MessageLike[];
    hits: MaskHit[];
};
/** 出站请求脱敏：options 是 waterfall 闭包与适配器共享的同一引用，next() 又不收参数，
 *  因此必须**原地重赋** `options.messages`（数组引用）与 `options.system`——request
 *  对象由循环逐请求新构建（未冻结），重赋安全；单条消息是冻结投影，克隆后放入新数组。
 *  返回命中列表；任何异常回退为不处理（返回空命中）。 */
export declare function maskOutbound(options: GenerateOptionsLike, rules: readonly CompiledRule[], map: MaskMap): MaskHit[];
/**
 * 占位符可能被拆进多个 delta。按块索引缓冲尾部：尾部若是 `[[CODE_N]]` 的
 * 严格前缀（或疑似开头 `[`/`[[`）则扣住不发，避免半截占位符漏给消费方。
 */
export declare class PlaceholderRestorer {
    private readonly reverse;
    private readonly onRestore?;
    private buffers;
    /** 探针审计：每次还原后回报本次处理的占位符形态匹配数（含未知占位——猜测本身即信号）。 */
    constructor(reverse: Map<string, string>, onRestore?: ((n: number) => void) | undefined);
    /** 喂入一段 delta 文本，返回可安全发出的部分（已还原完整占位符）。 */
    feed(index: number, text: string): string;
    /** 块结束：返回并清空该索引的残余（已还原）。 */
    flush(index: number): string;
    /** 还原并回报占位符匹配数（探针审计挂钩）。 */
    private restoreSegment;
    /** 流结束：清空所有残余，按 index 升序返回。 */
    flushAll(): Array<{
        index: number;
        text: string;
    }>;
}
/** 返回 pending 中可安全发出的截止位置：其后若有疑似占位符前缀则扣住。 */
export declare function holdbackIndex(pending: string): number;
/** 还原一个完整 content 块（block-end 权威块 / 合成块）。无关块原样返回。 */
export declare function restoreBlock(block: ContentBlockLike, reverse: Map<string, string>): ContentBlockLike;
/** 包装 chunk 流做入站还原；任何异常透传原始 chunk（宁可不还原，不可断流）。 */
export declare function restoreChunks(chunks: AsyncIterable<StreamChunkLike>, restorer: PlaceholderRestorer, reverse: Map<string, string>): AsyncGenerator<StreamChunkLike>;
export interface StreamDeps {
    /** 取 sessionId 对应映射表（含创建/触碰）。 */
    mapFor(options: GenerateOptionsLike): MaskMap;
    /** 命中统计回调。 */
    onHits(hits: readonly MaskHit[]): void;
    /** 当前生效的脱敏规则（空数组 = 出站跳过）。 */
    rules: () => readonly CompiledRule[];
    /** 入站占位符还原开关。 */
    restore: () => boolean;
    /** 探针审计：占位符还原计数回调（可缺席）。 */
    onRestore?: (options: GenerateOptionsLike, n: number) => void;
    /** 冻结请求（0.1.2 起 agent-loop 对请求 deepFreeze）时的出站通道：
     *  以脱敏后的克隆再次经 llm.stream 下发（提供方负责解析 llm 服务）。
     *  缺省时冻结请求只能放弃出站脱敏（降级不生效，不阻断调用）。 */
    streamDirect?: (options: GenerateOptionsLike) => AsyncIterable<StreamChunkLike>;
}
/** llm/stream 监听器主体：`(options, next) => Promise<AsyncIterable>`。
 *  cordis waterfall 会 await 监听器返回值，Promise 形态合法。 */
export declare function makeStreamListener(deps: StreamDeps): (options: GenerateOptionsLike, next: () => AsyncIterable<StreamChunkLike>) => Promise<AsyncIterable<StreamChunkLike>>;
