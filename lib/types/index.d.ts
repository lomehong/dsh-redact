import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { type CustomRuleInput, type TermRuleInput } from './rules.ts';
export interface RedactConfig {
    maskLlm: boolean;
    restoreOutput: boolean;
    maskLogs: boolean;
    categories: {
        secret: boolean;
        id: boolean;
        bank: boolean;
        phone: boolean;
        email: boolean;
    };
    customRules: CustomRuleInput[];
    /** 实体别名替换：原词 → 固定替换词（单向，不还原）。旧配置/组合基线可缺席。 */
    aliases?: TermRuleInput[];
}
export declare const Config: z<RedactConfig>;
export declare const name = "redact";
/** UI 提交的配置规范化与合法性检查（自定义正则当场编译，非法拒绝保存）。 */
export declare function normalizeConfigInput(payload: unknown): RedactConfig;
export declare function apply(ctx: Context, config: RedactConfig): Promise<void>;
