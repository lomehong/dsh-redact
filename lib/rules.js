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
/* ─────────────── 占位符与还原 ─────────────── */
/** 占位符形态 `[[CODE_N]]`：CODE 为大写字母开头的字母数字（≤24），N 为序号。 */
const PLACEHOLDER_RE = /\[\[([A-Z][A-Z0-9]{0,23})_(\d{1,10})\]\]/g;
export function createMaskMap() {
    return { forward: new Map(), reverse: new Map(), counters: new Map() };
}
/** 占位符→真实值还原；未知的同形字面量原样保留。 */
export function restoreText(text, reverse) {
    if (!text.includes('[['))
        return text;
    return text.replace(PLACEHOLDER_RE, (placeholder) => reverse.get(placeholder) ?? placeholder);
}
/** 规则上限：防 YAML 手改/异常配置拖垮热路径。 */
export const MAX_CUSTOM_RULES = 50;
export const MAX_PATTERN_LENGTH = 200;
/** 内置规则定义（原始形态，供编译与设置页文案共用）。 */
/** 内置 SECRET 模式：group 指定只脱敏捕获组（保留变量名/协议前缀的可读性）。 */
const SECRET_PATTERNS = [
    // OpenAI/DeepSeek 风格
    { re: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/g },
    // AWS Access Key ID
    { re: /\bAKIA[0-9A-Z]{16}\b/g },
    // GitHub token（经典 36+ 与 fine-grained）
    { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g },
    { re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
    // Slack token
    { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
    // JWT 三段式
    { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    // Bearer 凭据（保留 Bearer 前缀，只脱敏值）
    { re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/gi, group: 1 },
    // PEM 私钥块
    { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{0,8000}?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
    // key = value 型赋值（保留变量名，只脱敏值）
    { re: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd|private[_-]?key)\b["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{8,})/gi, group: 1 },
];
function compileBuiltin(id, priority, patterns, validate) {
    const code = id.toUpperCase();
    return patterns.map(({ re, group }) => ({
        code,
        priority,
        regex: re,
        ...(validate !== undefined ? { validate } : {}),
        ...(group !== undefined ? { group } : {}),
    }));
}
/* 身份证校验（GB 11643-1999 加权因子与校验码表）。 */
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = '10X98765432';
function plausibleDate(year, month, day) {
    return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}
function validId18(id) {
    for (let i = 0; i < 17; i++) {
        const c = id.charCodeAt(i) - 48;
        if (c < 0 || c > 9)
            return false;
    }
    if (!plausibleDate(Number(id.slice(6, 10)), Number(id.slice(10, 12)), Number(id.slice(12, 14))))
        return false;
    let sum = 0;
    for (let i = 0; i < 17; i++)
        sum += (id.charCodeAt(i) - 48) * ID_WEIGHTS[i];
    return ID_CHECK[sum % 11] === id[17].toUpperCase();
}
function validId15(id) {
    // 15 位为一代证：出生段 YYMMDD 视作 19xx
    return plausibleDate(1900 + Number(id.slice(6, 8)), Number(id.slice(8, 10)), Number(id.slice(10, 12)));
}
function luhn(digits) {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48;
        if (d < 0 || d > 9)
            return false;
        if (double) {
            d *= 2;
            if (d > 9)
                d -= 9;
        }
        sum += d;
        double = !double;
    }
    return sum % 10 === 0;
}
/** 内置五类的编译结果（按优先级排序）。 */
export function builtinRules(enabled) {
    const rules = [];
    if (enabled.secret) {
        rules.push(...compileBuiltin('secret', 1, SECRET_PATTERNS));
    }
    if (enabled.id) {
        rules.push({ code: 'ID', priority: 2, regex: /(?<!\d)\d{17}[\dXx](?!\d)/g, validate: validId18 }, { code: 'ID', priority: 2, regex: /(?<!\d)\d{15}(?!\d)/g, validate: validId15 });
    }
    if (enabled.bank) {
        rules.push({ code: 'BANK', priority: 3, regex: /(?<!\d)\d{13,19}(?!\d)/g, validate: luhn });
    }
    if (enabled.phone) {
        rules.push({ code: 'TEL', priority: 4, regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g });
    }
    if (enabled.email) {
        rules.push({ code: 'EMAIL', priority: 5, regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g });
    }
    return rules;
}
/** 规则名 → 占位符类别码：取字母数字序列，空则 RULE；超长截断。 */
export function customRuleCode(name) {
    const ascii = (name.match(/[A-Za-z0-9]+/g) ?? []).join('').toUpperCase();
    const base = (ascii === '' ? 'RULE' : ascii).slice(0, 20);
    return base;
}
/** 编译自定义规则；正则非法/超限的条目进入 errors（跳过不参与匹配）。 */
export function compileCustomRules(rules) {
    const out = [];
    const errors = [];
    const seenCodes = new Map();
    for (let i = 0; i < rules.length && i < MAX_CUSTOM_RULES; i++) {
        const rule = rules[i];
        const name = String(rule?.name ?? '').trim();
        const pattern = String(rule?.pattern ?? '');
        if (name === '' || pattern === '') {
            errors.push(`自定义规则 #${i + 1}：名称与正则均不能为空`);
            continue;
        }
        if (pattern.length > MAX_PATTERN_LENGTH) {
            errors.push(`自定义规则「${name}」：正则超过 ${MAX_PATTERN_LENGTH} 字符上限`);
            continue;
        }
        try {
            const regex = new RegExp(pattern, 'g');
            let code = customRuleCode(name);
            const n = (seenCodes.get(code) ?? 0) + 1;
            seenCodes.set(code, n);
            if (n > 1)
                code = `${code}${n}`; // 同名规则的类别码区分，占位符才不会共享序号空间
            out.push({ code, priority: 6 + i, regex });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`自定义规则「${name}」：正则非法（${message}）`);
        }
    }
    if (rules.length > MAX_CUSTOM_RULES)
        errors.push(`自定义规则超过 ${MAX_CUSTOM_RULES} 条上限，多余条目已忽略`);
    return { rules: out, errors };
}
/* ─────────────── 实体别名替换（原词 → 固定替换词） ─────────────── */
export const MAX_TERM_RULES = 100;
export const MAX_TERM_LENGTH = 64;
export const MAX_REPLACEMENT_LENGTH = 64;
/** 别名优先级：排在内置（1–5）与自定义正则（6+）之后——敏感数据命中优先，
 *  别名只处理未被更敏感规则覆盖的部分（绝不在密钥/证件命中区里掏洞）。 */
const TERM_PRIORITY_BASE = 1000;
export function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** 编译别名替换规则：字面量匹配 → 固定串直接替换。
 *  与占位符规则的本质差异：替换串固定、不入映射表、不做还原（单向）。
 *  重叠的长词优先（"腾讯云"应先于"腾讯"命中）：按原词长度降序收集。
 *  rules 缺席（旧配置/旧持久化节）时视为空。 */
export function compileTermRules(rules) {
    const out = [];
    const errors = [];
    const seenTerms = new Set();
    const list = Array.isArray(rules) ? rules : [];
    const cleaned = list.map((rule) => ({
        term: String(rule?.term ?? '').trim(),
        replacement: String(rule?.replacement ?? '').trim(),
    }));
    if (cleaned.length > MAX_TERM_RULES)
        errors.push(`别名规则超过 ${MAX_TERM_RULES} 条上限，多余条目已忽略`);
    for (let i = 0; i < cleaned.length && i < MAX_TERM_RULES; i++) {
        const { term, replacement } = cleaned[i];
        if (term === '' || replacement === '') {
            errors.push(`别名规则 #${i + 1}：原词与替换词均不能为空`);
            continue;
        }
        if (term.length > MAX_TERM_LENGTH) {
            errors.push(`别名规则 #${i + 1}：原词超过 ${MAX_TERM_LENGTH} 字符上限`);
            continue;
        }
        if (replacement.length > MAX_REPLACEMENT_LENGTH) {
            errors.push(`别名规则 #${i + 1}：替换词超过 ${MAX_REPLACEMENT_LENGTH} 字符上限`);
            continue;
        }
        if (term === replacement) {
            errors.push(`别名规则 #${i + 1}：原词与替换词相同（无意义）`);
            continue;
        }
        // 占位符形态的原词/替换词都会与还原层（[[CODE_N]]）纠缠：一律拒绝。
        // 注意用非全局副本：PLACEHOLDER_RE 带 g 标志有 lastIndex 状态，test() 会串值。
        const placeholderForm = /\[\[[A-Z][A-Z0-9]{0,23}_\d{1,10}\]\]/;
        if (placeholderForm.test(term) || placeholderForm.test(replacement)) {
            errors.push(`别名规则 #${i + 1}：原词/替换词不能是占位符形态 [[CODE_N]]`);
            continue;
        }
        if (seenTerms.has(term)) {
            errors.push(`别名规则 #${i + 1}：原词「${term}」重复（保留先定义的替换）`);
            continue;
        }
        seenTerms.add(term);
        out.push({
            code: 'ALIAS',
            priority: TERM_PRIORITY_BASE + out.length,
            regex: new RegExp(escapeRegExp(term), 'g'),
            replacement,
        });
    }
    // 重叠别名长词优先（转义后的 source 长度单调对应原词长度）
    out.sort((a, b) => b.regex.source.length - a.regex.source.length);
    return { rules: out, errors };
}
function collectSpans(text, rules) {
    const accepted = [];
    for (const rule of rules) {
        regexScan(text, rule, (start, end, value) => {
            for (const span of accepted) {
                if (start < span.end && span.start < end)
                    return; // 与高优先级命中重叠：丢弃
            }
            accepted.push({ start, end, value, code: rule.code, ...(rule.replacement !== undefined ? { replacement: rule.replacement } : {}) });
        });
    }
    return accepted;
}
function regexScan(text, rule, emit) {
    // hasIndices 需要 d 标志；调用方持有原始 g 正则，这里按需重建带 d 的副本
    const needsIndices = rule.group !== undefined && rule.group > 0;
    const flags = needsIndices ? `${rule.regex.flags}d` : rule.regex.flags;
    const re = needsIndices ? new RegExp(rule.regex.source, flags) : rule.regex;
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        if (m[0].length === 0) {
            re.lastIndex++; // 防零宽匹配死循环
            continue;
        }
        if (needsIndices) {
            const index = (m.indices?.[rule.group]);
            if (index === undefined)
                continue;
            if (index[1] - index[0] === 0)
                continue;
            const value = text.slice(index[0], index[1]);
            if (rule.validate !== undefined && !rule.validate(value))
                continue;
            emit(index[0], index[1], value);
        }
        else {
            if (rule.validate !== undefined && !rule.validate(m[0]))
                continue;
            emit(m.index, m.index + m[0].length, m[0]);
        }
    }
}
/** 对一段文本做脱敏；map 记账保证同一值全程同一占位符。
 *  占位符先按文本出现顺序预分配（编号 = 首次出现顺序），再从尾向头替换（偏移不失效）。 */
export function maskText(text, rules, map) {
    const spans = collectSpans(text, rules);
    if (spans.length === 0)
        return { text, hits: [] };
    const hits = spans.map((span) => ({ code: span.code, value: span.value }));
    for (const span of [...spans].sort((a, b) => a.start - b.start)) {
        // 别名替换：固定串直接替换，不占映射表（单向，无还原条目）
        span.placeholder = span.replacement ?? assignPlaceholder(map, span.code, span.value);
    }
    spans.sort((a, b) => b.start - a.start);
    let out = text;
    for (const span of spans) {
        out = out.slice(0, span.start) + span.placeholder + out.slice(span.end);
    }
    return { text: out, hits };
}
/** 取值的一致性占位符；新值按类别计数器顺序编号。 */
function assignPlaceholder(map, code, value) {
    const existing = map.forward.get(value);
    if (existing !== undefined)
        return existing;
    const n = (map.counters.get(code) ?? 0) + 1;
    map.counters.set(code, n);
    const placeholder = `[[${code}_${n}]]`;
    map.forward.set(value, placeholder);
    map.reverse.set(placeholder, value);
    return placeholder;
}
