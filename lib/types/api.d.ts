/**
 * 设置界面 HTTP API（webServer 在位时注册；同源回环访问，与宿主威胁模型一致）。
 *
 * - GET  /redact/api/config      当前生效配置
 * - PUT  /redact/api/config      整节保存（经 settings 服务，热生效；sameOrigin）
 * - GET  /redact/api/status      统计（类别命中/最近命中）、会话映射数、规则编译健康
 * - POST /redact/api/test        测试框：{text} → {masked}（一次性映射，不污染会话计数）
 * - POST /redact/api/clear-maps  清空全部会话映射（sameOrigin）
 *
 * 关键约束：处理器任何异常/拒绝都不能逃逸（cordis 升级 fatal 杀进程）——统一 safe() 包装。
 * sameOrigin 教训（dsh-plugin-manager 实证）：同源 GET 不带 Origin 头，GET 放行；
 * 带 Origin 才校验；POST/PUT 一律校验。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type RedactConfig } from './index.ts';
import type { AuditWarning } from './audit.ts';
export interface StatusProvider {
    config: () => RedactConfig;
    stats: () => {
        categories: Record<string, {
            count: number;
            lastAt?: number;
        }>;
        sessions: number;
        ruleErrors: string[];
        /** 探针行为审计告警（新→旧）。 */
        audit?: AuditWarning[];
    };
    test: (text: string) => string;
    /** 测试端点每次调用回报一次（探针审计挂钩）。 */
    onTestCall?: () => void;
    clearMaps: () => void;
    replaceConfig: (next: RedactConfig) => Promise<void>;
}
export declare function registerRedactApi(ctx: Context, provider: StatusProvider, log: (line: string) => void): void;
