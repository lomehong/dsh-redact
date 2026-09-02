/**
 * 规则引擎：内置敏感数据类别 + 用户自定义正则 → 编译、匹配收集、重叠消解、
 * 一致性假名替换与占位符还原。
 *
 * 设计要点：
 * - 匹配按规则优先级收集，与已接受区间重叠的候选直接丢弃（先到先得），
 *   替换从文本尾部向前进行，保证区间偏移不失效；
 * - 同一真实值在同一映射表内永远得到同一占位符（`[[CODE_N]]`，N 按值首次
 *   出现顺序递增），模型因此能跨轮次理解数据关系；
 * - 脱敏必须幂等：占位符 `[[TEL_1]]` 本身不被任何内置规则命中；
 * - 需要分组提取的规则（key-value 型密钥）用 `d` 标志的 hasIndices 取值区间，
 *   只脱敏值部分，保留变量名上下文。
 */
/** 双向映射表：forward 值→占位符；reverse 占位符→值；counters 各类别下一个序号。 */
export interface MaskMap {
    forward: Map<string, string>;
    reverse: Map<string, string>;
    counters: Map<string, number>;
}
export declare function createMaskMap(): MaskMap;
/** 占位符→真实值还原；未知的同形字面量原样保留。 */
export declare function restoreText(text: string, reverse: Map<string, string>): string;
export type BuiltinCategoryId = 'secret' | 'id' | 'bank' | 'phone' | 'email';
/** 校验器：正则命中后再做语义校验（校验码/Luhn），不合法的命中不算数。 */
export type SpanValidator = (match: string) => boolean;
export interface CompiledRule {
    /** 占位符类别码（占位符 CODE 段）。 */
    code: string;
    /** 优先级：小者先收集，重叠时先到先得。 */
    priority: number;
    regex: RegExp;
    /** 可选语义校验。 */
    validate?: SpanValidator;
    /** 命中后取第几个捕获组作为脱敏值（缺省 0 = 整个匹配）。 */
    group?: number;
    /** 别名替换：命中后直接替换为该固定串——不入映射表、不做还原（单向）。
     *  与占位符规则的本质差异：无 [[CODE_N]] 编号、无 reverse 条目。 */
    replacement?: string;
}
/** 规则上限：防 YAML 手改/异常配置拖垮热路径。 */
export declare const MAX_CUSTOM_RULES = 50;
export declare const MAX_PATTERN_LENGTH = 200;
/** 内置五类的编译结果（按优先级排序）。 */
export declare function builtinRules(enabled: Record<BuiltinCategoryId, boolean>): CompiledRule[];
export interface CustomRuleInput {
    name: string;
    pattern: string;
}
/** 规则名 → 占位符类别码：取字母数字序列，空则 RULE；超长截断。 */
export declare function customRuleCode(name: string): string;
/** 编译自定义规则；正则非法/超限的条目进入 errors（跳过不参与匹配）。 */
export declare function compileCustomRules(rules: readonly CustomRuleInput[]): {
    rules: CompiledRule[];
    errors: string[];
};
export declare const MAX_TERM_RULES = 100;
export declare const MAX_TERM_LENGTH = 64;
export declare const MAX_REPLACEMENT_LENGTH = 64;
export interface TermRuleInput {
    /** 原词（字面量匹配，非正则）。 */
    term: string;
    /** 固定替换词（确定性替换，不做还原映射）。 */
    replacement: string;
}
export declare function escapeRegExp(text: string): string;
/** 编译别名替换规则：字面量匹配 → 固定串直接替换。
 *  与占位符规则的本质差异：替换串固定、不入映射表、不做还原（单向）。
 *  重叠的长词优先（"腾讯云"应先于"腾讯"命中）：按原词长度降序收集。
 *  rules 缺席（旧配置/旧持久化节）时视为空。 */
export declare function compileTermRules(rules: readonly TermRuleInput[] | undefined): {
    rules: CompiledRule[];
    errors: string[];
};
export interface MaskHit {
    code: string;
    value: string;
}
export interface MaskResult {
    text: string;
    /** 本次实际替换发生的类别（含重复值命中，用于统计）。 */
    hits: MaskHit[];
}
/** 对一段文本做脱敏；map 记账保证同一值全程同一占位符。
 *  占位符先按文本出现顺序预分配（编号 = 首次出现顺序），再从尾向头替换（偏移不失效）。 */
export declare function maskText(text: string, rules: readonly CompiledRule[], map: MaskMap): MaskResult;
