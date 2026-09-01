import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { type CustomRuleInput } from './rules.ts';
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
}
export declare const Config: z<Schemastery.ObjectS<{
    /** 发往 LLM 的消息脱敏（总开关）。 */
    maskLlm: z<boolean, boolean>;
    /** 模型输出中的占位符还原为真实值。 */
    restoreOutput: z<boolean, boolean>;
    /** 日志输出打码（只打码不还原）。 */
    maskLogs: z<boolean, boolean>;
    categories: z<Schemastery.ObjectS<{
        secret: z<boolean, boolean>;
        id: z<boolean, boolean>;
        bank: z<boolean, boolean>;
        phone: z<boolean, boolean>;
        email: z<boolean, boolean>;
    }>, Schemastery.ObjectT<{
        secret: z<boolean, boolean>;
        id: z<boolean, boolean>;
        bank: z<boolean, boolean>;
        phone: z<boolean, boolean>;
        email: z<boolean, boolean>;
    }>>;
    customRules: z<({
        name?: string | null;
        pattern?: string | null;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        name: z<string, string>;
        pattern: z<string, string>;
    }>[]>;
}>, Schemastery.ObjectT<{
    /** 发往 LLM 的消息脱敏（总开关）。 */
    maskLlm: z<boolean, boolean>;
    /** 模型输出中的占位符还原为真实值。 */
    restoreOutput: z<boolean, boolean>;
    /** 日志输出打码（只打码不还原）。 */
    maskLogs: z<boolean, boolean>;
    categories: z<Schemastery.ObjectS<{
        secret: z<boolean, boolean>;
        id: z<boolean, boolean>;
        bank: z<boolean, boolean>;
        phone: z<boolean, boolean>;
        email: z<boolean, boolean>;
    }>, Schemastery.ObjectT<{
        secret: z<boolean, boolean>;
        id: z<boolean, boolean>;
        bank: z<boolean, boolean>;
        phone: z<boolean, boolean>;
        email: z<boolean, boolean>;
    }>>;
    customRules: z<({
        name?: string | null;
        pattern?: string | null;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        name: z<string, string>;
        pattern: z<string, string>;
    }>[]>;
}>>;
export declare const name = "redact";
/** UI 提交的配置规范化与合法性检查（自定义正则当场编译，非法拒绝保存）。 */
export declare function normalizeConfigInput(payload: unknown): RedactConfig;
export declare function apply(ctx: Context, config: RedactConfig): Promise<void>;
