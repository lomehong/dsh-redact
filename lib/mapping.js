/**
 * 会话映射表：按 sessionId 分账的一致性假名映射 + 命中统计 + 日志专用全局映射。
 *
 * - 同会话内同一真实值永远同一占位符；跨会话隔离（编号独立）；
 * - 会话 7 天不活跃或总量超上限时清理（lastActive 触碰于每次取用）；
 * - 日志打码用独立全局映射：只出不进、不还原、不落盘；
 * - 统计按类别累计命中次数与最近命中时间，随 state.json 落盘供设置页展示。
 */
import { createMaskMap, maskText } from "./rules.js";
export const SESSION_TTL_MS = 7 * 24 * 3600_000;
export const MAX_SESSIONS = 200;
export class MappingStore {
    sessions = new Map();
    /** 日志打码专用（无会话语义，不还原不落盘）。 */
    logMap = createMaskMap();
    stats = { categories: {} };
    sessionMap(sessionId, now) {
        let entry = this.sessions.get(sessionId);
        if (entry === undefined) {
            entry = { map: createMaskMap(), lastActive: now };
            this.sessions.set(sessionId, entry);
        }
        entry.lastActive = now;
        return entry.map;
    }
    /** 命中统计：value 仅用于去重前计数（本函数不保留 value）。 */
    recordHits(hits, now) {
        for (const hit of hits) {
            const stat = this.stats.categories[hit.code] ?? { count: 0 };
            stat.count += 1;
            stat.lastAt = now;
            this.stats.categories[hit.code] = stat;
        }
    }
    /** 启动时并入落盘统计（内存侧在此之上继续累计）。 */
    mergePersistedStat(code, count, lastAt) {
        const stat = this.stats.categories[code] ?? { count: 0 };
        stat.count = Math.max(stat.count, 0) + count;
        if (lastAt !== undefined && (stat.lastAt === undefined || lastAt > stat.lastAt))
            stat.lastAt = lastAt;
        this.stats.categories[code] = stat;
    }
    /** 脱敏一步到位：规则 × 会话映射 × 统计。 */
    mask(text, rules, sessionId, now) {
        const map = this.sessionMap(sessionId, now);
        const { text: masked, hits } = maskText(text, rules, map);
        this.recordHits(hits, now);
        return masked;
    }
    snapshotStats() {
        return { categories: Object.fromEntries(Object.entries(this.stats.categories).map(([code, s]) => [code, { ...s }])) };
    }
    sessionCount() {
        return this.sessions.size;
    }
    /** 清理 7 天不活跃会话；超总量上限时按最久未活跃淘汰。返回清理数。 */
    prune(now, ttlMs = SESSION_TTL_MS, maxSessions = MAX_SESSIONS) {
        let removed = 0;
        for (const [id, entry] of this.sessions) {
            if (now - entry.lastActive > ttlMs) {
                this.sessions.delete(id);
                removed++;
            }
        }
        if (this.sessions.size > maxSessions) {
            const ordered = [...this.sessions.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
            const excess = this.sessions.size - maxSessions; // 先取定值：size 随删除变化
            for (let i = 0; i < excess; i++) {
                this.sessions.delete(ordered[i][0]);
                removed++;
            }
        }
        return removed;
    }
    clearSessions() {
        this.sessions.clear();
    }
    /* ── 持久化载荷（会话映射反向表足够还原；正向表可由 reverse 推导重建） ── */
    toPersistable() {
        const sessions = {};
        for (const [id, entry] of this.sessions) {
            const reverse = {};
            for (const [placeholder, value] of entry.map.reverse)
                reverse[placeholder] = value;
            sessions[id] = { lastActive: entry.lastActive, reverse };
        }
        return { sessions };
    }
    loadPersistable(data, now) {
        this.sessions.clear();
        for (const [id, saved] of Object.entries(data.sessions ?? {})) {
            if (saved === null || typeof saved !== 'object')
                continue;
            const map = createMaskMap();
            let maxByCode = new Map();
            for (const [placeholder, value] of Object.entries(saved.reverse ?? {})) {
                if (typeof placeholder !== 'string' || typeof value !== 'string')
                    continue;
                if (!isPlaceholderShape(placeholder) || value === '')
                    continue;
                map.reverse.set(placeholder, value);
                map.forward.set(value, placeholder);
                const m = /^\[\[([A-Z][A-Z0-9]{0,23})_(\d{1,10})\]\]$/.exec(placeholder);
                if (m !== null) {
                    const seen = maxByCode.get(m[1]) ?? 0;
                    if (Number(m[2]) > seen)
                        maxByCode.set(m[1], Number(m[2]));
                }
            }
            maxByCode = maxByCode; // 保持计数器与已编号占位符衔接
            const entry = { map, lastActive: typeof saved.lastActive === 'number' ? saved.lastActive : now };
            this.sessions.set(id, entry);
            for (const [code, max] of maxByCode)
                map.counters.set(code, max);
        }
        this.prune(now);
    }
}
export function isPlaceholderShape(text) {
    return /^\[\[([A-Z][A-Z0-9]{0,23})_(\d{1,10})\]\]$/.test(text);
}
