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
const PLACEHOLDER_RE = /\[\[([A-Z][A-Z0-9]{0,23})_(\d{1,10})\]\]/g

/** 双向映射表：forward 值→占位符；reverse 占位符→值；counters 各类别下一个序号。 */
export interface MaskMap {
  forward: Map<string, string>
  reverse: Map<string, string>
  counters: Map<string, number>
}

export function createMaskMap(): MaskMap {
  return { forward: new Map(), reverse: new Map(), counters: new Map() }
}

/** 占位符→真实值还原；未知的同形字面量原样保留。 */
export function restoreText(text: string, reverse: Map<string, string>): string {
  if (!text.includes('[[')) return text
  return text.replace(PLACEHOLDER_RE, (placeholder) => reverse.get(placeholder) ?? placeholder)
}

/* ─────────────── 规则定义与编译 ─────────────── */

export type BuiltinCategoryId = 'secret' | 'id' | 'bank' | 'phone' | 'email'

/** 校验器：正则命中后再做语义校验（校验码/Luhn），不合法的命中不算数。 */
export type SpanValidator = (match: string) => boolean

export interface CompiledRule {
  /** 占位符类别码（占位符 CODE 段）。 */
  code: string
  /** 优先级：小者先收集，重叠时先到先得。 */
  priority: number
  regex: RegExp
  /** 可选语义校验。 */
  validate?: SpanValidator
  /** 命中后取第几个捕获组作为脱敏值（缺省 0 = 整个匹配）。 */
  group?: number
}

/** 规则上限：防 YAML 手改/异常配置拖垮热路径。 */
export const MAX_CUSTOM_RULES = 50
export const MAX_PATTERN_LENGTH = 200

/** 内置规则定义（原始形态，供编译与设置页文案共用）。 */
/** 内置 SECRET 模式：group 指定只脱敏捕获组（保留变量名/协议前缀的可读性）。 */
const SECRET_PATTERNS: Array<{ re: RegExp; group?: number }> = [
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
]

function compileBuiltin(id: BuiltinCategoryId, priority: number, patterns: Array<{ re: RegExp; group?: number }>, validate?: SpanValidator): CompiledRule[] {
  const code = id.toUpperCase()
  return patterns.map(({ re, group }) => ({
    code,
    priority,
    regex: re,
    ...(validate !== undefined ? { validate } : {}),
    ...(group !== undefined ? { group } : {}),
  }))
}

/* 身份证校验（GB 11643-1999 加权因子与校验码表）。 */
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const ID_CHECK = '10X98765432'

function plausibleDate(year: number, month: number, day: number): boolean {
  return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31
}

function validId18(id: string): boolean {
  for (let i = 0; i < 17; i++) {
    const c = id.charCodeAt(i) - 48
    if (c < 0 || c > 9) return false
  }
  if (!plausibleDate(Number(id.slice(6, 10)), Number(id.slice(10, 12)), Number(id.slice(12, 14)))) return false
  let sum = 0
  for (let i = 0; i < 17; i++) sum += (id.charCodeAt(i) - 48) * ID_WEIGHTS[i]
  return ID_CHECK[sum % 11] === id[17].toUpperCase()
}

function validId15(id: string): boolean {
  // 15 位为一代证：出生段 YYMMDD 视作 19xx
  return plausibleDate(1900 + Number(id.slice(6, 8)), Number(id.slice(8, 10)), Number(id.slice(10, 12)))
}

function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** 内置五类的编译结果（按优先级排序）。 */
export function builtinRules(enabled: Record<BuiltinCategoryId, boolean>): CompiledRule[] {
  const rules: CompiledRule[] = []
  if (enabled.secret) {
    rules.push(...compileBuiltin('secret', 1, SECRET_PATTERNS))
  }
  if (enabled.id) {
    rules.push(
      { code: 'ID', priority: 2, regex: /(?<!\d)\d{17}[\dXx](?!\d)/g, validate: validId18 },
      { code: 'ID', priority: 2, regex: /(?<!\d)\d{15}(?!\d)/g, validate: validId15 },
    )
  }
  if (enabled.bank) {
    rules.push({ code: 'BANK', priority: 3, regex: /(?<!\d)\d{13,19}(?!\d)/g, validate: luhn })
  }
  if (enabled.phone) {
    rules.push({ code: 'TEL', priority: 4, regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g })
  }
  if (enabled.email) {
    rules.push({ code: 'EMAIL', priority: 5, regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g })
  }
  return rules
}

export interface CustomRuleInput {
  name: string
  pattern: string
}

/** 规则名 → 占位符类别码：取字母数字序列，空则 RULE；超长截断。 */
export function customRuleCode(name: string): string {
  const ascii = (name.match(/[A-Za-z0-9]+/g) ?? []).join('').toUpperCase()
  const base = (ascii === '' ? 'RULE' : ascii).slice(0, 20)
  return base
}

/** 编译自定义规则；正则非法/超限的条目进入 errors（跳过不参与匹配）。 */
export function compileCustomRules(rules: readonly CustomRuleInput[]): { rules: CompiledRule[]; errors: string[] } {
  const out: CompiledRule[] = []
  const errors: string[] = []
  const seenCodes = new Map<string, number>()
  for (let i = 0; i < rules.length && i < MAX_CUSTOM_RULES; i++) {
    const rule = rules[i]
    const name = String(rule?.name ?? '').trim()
    const pattern = String(rule?.pattern ?? '')
    if (name === '' || pattern === '') {
      errors.push(`自定义规则 #${i + 1}：名称与正则均不能为空`)
      continue
    }
    if (pattern.length > MAX_PATTERN_LENGTH) {
      errors.push(`自定义规则「${name}」：正则超过 ${MAX_PATTERN_LENGTH} 字符上限`)
      continue
    }
    try {
      const regex = new RegExp(pattern, 'g')
      let code = customRuleCode(name)
      const n = (seenCodes.get(code) ?? 0) + 1
      seenCodes.set(code, n)
      if (n > 1) code = `${code}${n}` // 同名规则的类别码区分，占位符才不会共享序号空间
      out.push({ code, priority: 6 + i, regex })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`自定义规则「${name}」：正则非法（${message}）`)
    }
  }
  if (rules.length > MAX_CUSTOM_RULES) errors.push(`自定义规则超过 ${MAX_CUSTOM_RULES} 条上限，多余条目已忽略`)
  return { rules: out, errors }
}

/* ─────────────── 匹配收集与替换 ─────────────── */

interface Span {
  start: number
  end: number
  value: string
  code: string
  /** 替换前预分配的一致性占位符（保证编号与文本出现顺序一致）。 */
  placeholder?: string
}

function collectSpans(text: string, rules: readonly CompiledRule[]): Span[] {
  const accepted: Span[] = []
  for (const rule of rules) {
    regexScan(text, rule, (start, end, value) => {
      for (const span of accepted) {
        if (start < span.end && span.start < end) return // 与高优先级命中重叠：丢弃
      }
      accepted.push({ start, end, value, code: rule.code })
    })
  }
  return accepted
}

function regexScan(text: string, rule: CompiledRule, emit: (start: number, end: number, value: string) => void): void {
  // hasIndices 需要 d 标志；调用方持有原始 g 正则，这里按需重建带 d 的副本
  const needsIndices = rule.group !== undefined && rule.group > 0
  const flags = needsIndices ? `${rule.regex.flags}d` : rule.regex.flags
  const re = needsIndices ? new RegExp(rule.regex.source, flags) : rule.regex
  re.lastIndex = 0
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++ // 防零宽匹配死循环
      continue
    }
    if (needsIndices) {
      const index = (m.indices?.[rule.group!]) as [number, number] | undefined
      if (index === undefined) continue
      if (index[1] - index[0] === 0) continue
      const value = text.slice(index[0], index[1])
      if (rule.validate !== undefined && !rule.validate(value)) continue
      emit(index[0], index[1], value)
    } else {
      if (rule.validate !== undefined && !rule.validate(m[0])) continue
      emit(m.index, m.index + m[0].length, m[0])
    }
  }
}

export interface MaskHit {
  code: string
  value: string
}

export interface MaskResult {
  text: string
  /** 本次实际替换发生的类别（含重复值命中，用于统计）。 */
  hits: MaskHit[]
}

/** 对一段文本做脱敏；map 记账保证同一值全程同一占位符。
 *  占位符先按文本出现顺序预分配（编号 = 首次出现顺序），再从尾向头替换（偏移不失效）。 */
export function maskText(text: string, rules: readonly CompiledRule[], map: MaskMap): MaskResult {
  const spans = collectSpans(text, rules)
  if (spans.length === 0) return { text, hits: [] }
  const hits: MaskHit[] = spans.map((span) => ({ code: span.code, value: span.value }))
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    span.placeholder = assignPlaceholder(map, span.code, span.value)
  }
  spans.sort((a, b) => b.start - a.start)
  let out = text
  for (const span of spans) {
    out = out.slice(0, span.start) + span.placeholder + out.slice(span.end)
  }
  return { text: out, hits }
}

/** 取值的一致性占位符；新值按类别计数器顺序编号。 */
function assignPlaceholder(map: MaskMap, code: string, value: string): string {
  const existing = map.forward.get(value)
  if (existing !== undefined) return existing
  const n = (map.counters.get(code) ?? 0) + 1
  map.counters.set(code, n)
  const placeholder = `[[${code}_${n}]]`
  map.forward.set(value, placeholder)
  map.reverse.set(placeholder, value)
  return placeholder
}
