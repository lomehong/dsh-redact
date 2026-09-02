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
export type AuditKind = 'test-flood' | 'restore-flood';
export interface AuditWarning {
    at: number;
    kind: AuditKind;
    /** 触发主体：test 端点为 'test-endpoint'；还原为 sessionId。 */
    subject: string;
    message: string;
}
export interface AuditOptions {
    log?: (line: string) => void;
    /** 检测窗口（毫秒）。默认 10 分钟。 */
    windowMs?: number;
    /** 测试端点调用阈值（窗口内次数）。默认 30。 */
    testMaxCalls?: number;
    /** 单会话占位符还原阈值（窗口内还原个数）。默认 100。 */
    restoreMaxPerSession?: number;
    /** 告警环上限（保留最近 N 条）。默认 20。 */
    maxWarnings?: number;
}
export declare class ProbeAudit {
    private readonly windowMs;
    private readonly testMaxCalls;
    private readonly restoreMaxPerSession;
    private readonly maxWarnings;
    private readonly log;
    private readonly testCalls;
    private readonly restores;
    private readonly warnings;
    /** 同 kind(+subject) 的告警冷却：每窗口最多告警一次，避免刷屏。 */
    private readonly lastWarnAt;
    constructor(options?: AuditOptions);
    /** 记录一次测试端点调用；越限返回告警（否则 undefined）。 */
    recordTestCall(now: number): AuditWarning | undefined;
    /** 记录一次会话内占位符还原（n = 本次还原的占位符个数）。越限返回告警。 */
    recordRestore(subject: string, now: number, n: number): AuditWarning | undefined;
    /** 告警快照（新→旧），供状态接口与设置页展示。 */
    snapshot(): AuditWarning[];
    private maybeWarn;
}
