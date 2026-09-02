/**
 * 探针行为审计：对两类可观测的探测信号做滑动窗口速率检测，越限打告警。
 *
 * - 测试框高频调用：/redact/api/test 是免映射的一次性脱敏预言机（可迭代试探
 *   规则效果），短窗口高频调用是典型探测形态；
 * - 占位符还原激增：单会话在短窗口内大量占位符被还原——模型若在输出里枚举
 *   [[CODE_N]] 猜测，命中项会经还原层流向 UI/工具，还原计数即探测信号。
 *
 * 定位（README「威胁模型与边界」）：审计提供**可观测性**，不承诺阻断——
 * 对确定性的对抗 agent，内容级遮蔽只能提升成本。告警写入状态接口与宿主日志。
 */
const DEFAULTS = {
    windowMs: 10 * 60_000,
    testMaxCalls: 30,
    restoreMaxPerSession: 100,
    maxWarnings: 20,
};
/** 窗口内时间戳数组的总和（weight 累计，见 restore 的按量记账）。 */
function windowSum(entries, now, windowMs) {
    let sum = 0;
    for (const e of entries) {
        if (now - e.at <= windowMs)
            sum += e.n;
    }
    return sum;
}
function pruneEntries(entries, now, windowMs) {
    while (entries.length > 0 && now - entries[0].at > windowMs)
        entries.shift();
}
export class ProbeAudit {
    windowMs;
    testMaxCalls;
    restoreMaxPerSession;
    maxWarnings;
    log;
    testCalls = [];
    restores = new Map();
    warnings = [];
    /** 同 kind(+subject) 的告警冷却：每窗口最多告警一次，避免刷屏。 */
    lastWarnAt = new Map();
    constructor(options = {}) {
        this.windowMs = options.windowMs ?? DEFAULTS.windowMs;
        this.testMaxCalls = options.testMaxCalls ?? DEFAULTS.testMaxCalls;
        this.restoreMaxPerSession = options.restoreMaxPerSession ?? DEFAULTS.restoreMaxPerSession;
        this.maxWarnings = options.maxWarnings ?? DEFAULTS.maxWarnings;
        this.log = options.log;
    }
    /** 记录一次测试端点调用；越限返回告警（否则 undefined）。 */
    recordTestCall(now) {
        this.testCalls.push(now);
        while (this.testCalls.length > 0 && now - this.testCalls[0] > this.windowMs)
            this.testCalls.shift();
        return this.maybeWarn('test-flood', 'test-endpoint', now, this.testCalls.length, this.testMaxCalls, '测试框');
    }
    /** 记录一次会话内占位符还原（n = 本次还原的占位符个数）。越限返回告警。 */
    recordRestore(subject, now, n) {
        if (n <= 0)
            return undefined;
        let entries = this.restores.get(subject);
        if (entries === undefined) {
            entries = [];
            this.restores.set(subject, entries);
        }
        entries.push({ at: now, n });
        pruneEntries(entries, now, this.windowMs);
        return this.maybeWarn('restore-flood', subject, now, windowSum(entries, now, this.windowMs), this.restoreMaxPerSession, `会话 ${subject.slice(0, 12)}…`);
    }
    /** 告警快照（新→旧），供状态接口与设置页展示。 */
    snapshot() {
        return [...this.warnings].reverse();
    }
    maybeWarn(kind, subject, now, observed, threshold, label) {
        if (observed <= threshold)
            return undefined;
        const cooldownKey = `${kind}:${subject}`;
        const last = this.lastWarnAt.get(cooldownKey) ?? 0;
        if (now - last <= this.windowMs)
            return undefined; // 冷却期内：不重复告警
        this.lastWarnAt.set(cooldownKey, now);
        const message = `${label} 在 ${Math.round(this.windowMs / 60000)} 分钟窗口内触发 ${observed} 次（阈值 ${threshold}）——疑似探测行为，建议关注`;
        const warning = { at: now, kind, subject, message };
        this.warnings.push(warning);
        while (this.warnings.length > this.maxWarnings)
            this.warnings.shift();
        try {
            this.log?.(`[探针审计] ${message}`);
        }
        catch { /* 日志失败不影响审计 */ }
        return warning;
    }
}
