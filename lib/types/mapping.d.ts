/**
 * 会话映射表：按 sessionId 分账的一致性假名映射 + 命中统计 + 日志专用全局映射。
 *
 * - 同会话内同一真实值永远同一占位符；跨会话隔离（编号独立）；
 * - 会话 7 天不活跃或总量超上限时清理（lastActive 触碰于每次取用）；
 * - 日志打码用独立全局映射：只出不进、不还原、不落盘；
 * - 统计按类别累计命中次数与最近命中时间，随 state.json 落盘供设置页展示。
 */
import { type CompiledRule, type MaskMap, type MaskHit } from './rules.ts';
export declare const SESSION_TTL_MS: number;
export declare const MAX_SESSIONS = 200;
export interface CategoryStat {
    count: number;
    lastAt?: number;
}
export interface RedactStats {
    categories: Record<string, CategoryStat>;
}
export interface SessionMapEntry {
    map: MaskMap;
    lastActive: number;
}
export declare class MappingStore {
    private sessions;
    /** 日志打码专用（无会话语义，不还原不落盘）。 */
    readonly logMap: MaskMap;
    private stats;
    sessionMap(sessionId: string, now: number): MaskMap;
    /** 命中统计：value 仅用于去重前计数（本函数不保留 value）。 */
    recordHits(hits: readonly MaskHit[], now: number): void;
    /** 启动时并入落盘统计（内存侧在此之上继续累计）。 */
    mergePersistedStat(code: string, count: number, lastAt: number | undefined): void;
    /** 脱敏一步到位：规则 × 会话映射 × 统计。 */
    mask(text: string, rules: readonly CompiledRule[], sessionId: string, now: number): string;
    snapshotStats(): RedactStats;
    sessionCount(): number;
    /** 清理 7 天不活跃会话；超总量上限时按最久未活跃淘汰。返回清理数。 */
    prune(now: number, ttlMs?: number, maxSessions?: number): number;
    clearSessions(): void;
    toPersistable(): PersistedMaps;
    loadPersistable(data: PersistedMaps, now: number): void;
}
export interface PersistedMaps {
    sessions: Record<string, {
        lastActive: number;
        reverse: Record<string, string>;
    }>;
}
export declare function isPlaceholderShape(text: string): boolean;
