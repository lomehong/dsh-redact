/**
 * 「数据脱敏」设置页：开关组 + 内置类别 + 自定义规则 CRUD + 脱敏测试框 + 命中统计。
 * - 经插件 HTTP API（/redact/api/*）读写配置，保存即热生效
 * - 脏状态跟踪（未保存标识 / 放弃更改）；颜色接入 dsw-alias 设计令牌，自动适配明暗主题
 * - 写请求带 Origin（同源校验），读请求统一 AbortSignal.timeout
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react'
import type { RedactKey } from './locales.ts'

export interface RedactSettingsTabInjected {
  t: (key: RedactKey) => string
}

interface RedactConfigDto {
  maskLlm: boolean
  restoreOutput: boolean
  maskLogs: boolean
  categories: { secret: boolean; id: boolean; bank: boolean; phone: boolean; email: boolean }
  customRules: Array<{ name: string; pattern: string }>
}

interface StatsDto {
  categories: Record<string, { count: number; lastAt?: number }>
  sessions: number
  ruleErrors: string[]
}

const c = {
  text: 'var(--dsw-alias-label-primary, #1f2329)',
  textSecondary: 'var(--dsw-alias-label-secondary, #4e5969)',
  bgBase: 'var(--dsw-alias-bg-base, #ffffff)',
  bgLayer: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
  border: 'var(--dsw-alias-separator-primary, #e5e6eb)',
  accent: 'var(--dsw-alias-state-business-primary, #3370ff)',
  accentBg: 'var(--dsw-alias-state-business-primary-bg-hover, rgba(51,112,255,.08))',
  ok: 'var(--dsw-alias-state-success-primary, #00b42a)',
  warn: 'var(--dsw-alias-state-warning-primary, #ff7d00)',
  error: 'var(--dsw-alias-state-error-primary, #f53f3f)',
}

const sectionStyle: CSSProperties = {
  border: `1px solid ${c.border}`, borderRadius: 8, padding: '12px 16px', background: c.bgBase, marginBottom: 12,
}
const sectionTitleStyle: CSSProperties = {
  fontSize: 13, fontWeight: 600, color: c.text, margin: '0 0 8px',
}
const rowStyle: CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0',
}
const btnStyle: CSSProperties = {
  padding: '4px 10px', borderRadius: 6, border: `1px solid ${c.border}`,
  background: c.bgBase, color: c.textSecondary, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
}
const primaryBtn: CSSProperties = {
  ...btnStyle, background: c.accent, color: '#fff', border: 'none', fontWeight: 600, padding: '6px 22px', fontSize: 13,
}
const inputStyle: CSSProperties = {
  padding: '4px 8px', borderRadius: 6, border: `1px solid ${c.border}`,
  background: c.bgBase, color: c.text, fontSize: 13, minWidth: 0, width: '100%', fontFamily: 'monospace',
}
const hintStyle: CSSProperties = {
  fontSize: 12, color: c.textSecondary, lineHeight: 1.5,
}
const errorStyle: CSSProperties = {
  fontSize: 12, color: c.error, lineHeight: 1.5,
}
const chipStyle: CSSProperties = {
  padding: '2px 10px', borderRadius: 999, fontSize: 12, border: `1px solid ${c.border}`, background: c.bgLayer, color: c.text,
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const hasBody = init?.body !== undefined
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    ...(hasBody ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(10_000),
  })
  return (await res.json()) as T
}

const CATEGORY_CODES = ['secret', 'id', 'bank', 'phone', 'email'] as const

const STAT_COLORS: Record<string, string> = {
  SECRET: c.error, ID: c.warn, BANK: c.warn, TEL: c.accent, EMAIL: c.ok,
}

export function RedactSettingsTab({ t }: RedactSettingsTabInjected): JSX.Element {
  const [config, setConfig] = useState<RedactConfigDto | null>(null)
  const [dirty, setDirty] = useState(false)
  const [savedTick, setSavedTick] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [loadError, setLoadError] = useState(false)
  const [stats, setStats] = useState<StatsDto | null>(null)
  const [testInput, setTestInput] = useState('')
  const [testOutput, setTestOutput] = useState('')
  const [clearedTick, setClearedTick] = useState(false)
  const savedTimer = useRef<number | undefined>(undefined)

  const loadConfig = useCallback(async () => {
    try {
      const res = await api<{ ok: boolean; config: RedactConfigDto }>('/redact/api/config')
      setConfig(res.config)
      setDirty(false)
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }, [])

  const refreshStats = useCallback(async () => {
    try {
      const res = await api<{ ok: boolean; status: StatsDto }>('/redact/api/status')
      setStats(res.status)
    } catch { /* 状态失败不打断配置区 */ }
  }, [])

  useEffect(() => {
    void loadConfig()
    void refreshStats()
    const timer = window.setInterval(() => { void refreshStats() }, 10_000)
    return () => { window.clearInterval(timer) }
  }, [loadConfig, refreshStats])

  const update = (mutate: (draft: RedactConfigDto) => void): void => {
    setConfig((prev) => {
      if (prev === null) return prev
      const draft = structuredClone(prev)
      mutate(draft)
      return draft
    })
    setDirty(true)
    setSavedTick(false)
  }

  const save = async (): Promise<void> => {
    if (config === null) return
    setSaveError('')
    try {
      const res = await api<{ ok: boolean; error?: string }>('/redact/api/config', { method: 'PUT', body: config })
      if (!res.ok) throw new Error(res.error ?? 'unknown')
      setDirty(false)
      setSavedTick(true)
      window.clearTimeout(savedTimer.current)
      savedTimer.current = window.setTimeout(() => setSavedTick(false), 2500)
      void refreshStats()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    }
  }

  const runTest = async (): Promise<void> => {
    if (testInput === '') return
    try {
      const res = await api<{ ok: boolean; masked?: string }>('/redact/api/test', { method: 'POST', body: { text: testInput } })
      setTestOutput(res.masked ?? '')
    } catch {
      setTestOutput('')
    }
  }

  const clearMaps = async (): Promise<void> => {
    try {
      await api('/redact/api/clear-maps', { method: 'POST', body: {} })
      setClearedTick(true)
      window.setTimeout(() => setClearedTick(false), 2000)
      void refreshStats()
    } catch { /* ignore */ }
  }

  const fmt = (key: RedactKey, params?: Record<string, string | number>): string => {
    let text = t(key)
    for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v))
    return text
  }

  const statEntries = useMemo(() => Object.entries(stats?.categories ?? {}).sort((a, b) => b[1].count - a[1].count), [stats])

  if (loadError && config === null) {
    return <div style={{ ...hintStyle, color: c.error }}>{t('statusError')}</div>
  }
  if (config === null) {
    return <div style={hintStyle}>{t('loading')}</div>
  }

  return (
    <div style={{ maxWidth: 860 }}>
      {/* ── 开关 ── */}
      <div style={sectionStyle}>
        <p style={sectionTitleStyle}>{t('switchesTitle')}</p>
        {([
          ['maskLlm', 'maskLlmHint'],
          ['restoreOutput', 'restoreOutputHint'],
          ['maskLogs', 'maskLogsHint'],
        ] as const).map(([key, hint]) => (
          <div key={key} style={rowStyle}>
            <input
              type="checkbox"
              checked={config[key]}
              onChange={(e: ChangeEvent<HTMLInputElement>) => update((draft) => { draft[key] = e.target.checked })}
              style={{ marginTop: 3 }}
            />
            <div>
              <div style={{ fontSize: 13, color: c.text }}>{t(key)}</div>
              <div style={hintStyle}>{t(hint)}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── 内置类别 ── */}
      <div style={sectionStyle}>
        <p style={sectionTitleStyle}>{t('categoriesTitle')}</p>
        {CATEGORY_CODES.map((code) => (
          <div key={code} style={rowStyle}>
            <input
              type="checkbox"
              checked={config.categories[code]}
              onChange={(e: ChangeEvent<HTMLInputElement>) => update((draft) => { draft.categories[code] = e.target.checked })}
              style={{ marginTop: 3 }}
            />
            <div>
              <div style={{ fontSize: 13, color: c.text }}>{t(`cat${code[0].toUpperCase()}${code.slice(1)}` as RedactKey)}</div>
              <div style={hintStyle}>{t(`cat${code[0].toUpperCase()}${code.slice(1)}Hint` as RedactKey)}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── 自定义规则 ── */}
      <div style={sectionStyle}>
        <p style={sectionTitleStyle}>{t('rulesTitle')}</p>
        {config.customRules.length === 0 && <div style={hintStyle}>{t('ruleEmpty')}</div>}
        {config.customRules.map((rule, index) => (
          <div key={index} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
            <input
              value={rule.name}
              placeholder={t('ruleName')}
              onChange={(e: ChangeEvent<HTMLInputElement>) => update((draft) => { draft.customRules[index].name = e.target.value })}
              style={{ ...inputStyle, width: 180, fontFamily: 'inherit' }}
            />
            <input
              value={rule.pattern}
              placeholder={t('rulePattern')}
              onChange={(e: ChangeEvent<HTMLInputElement>) => update((draft) => { draft.customRules[index].pattern = e.target.value })}
              style={inputStyle}
            />
            <button type="button" style={btnStyle} onClick={() => update((draft) => { draft.customRules.splice(index, 1) })}>
              {t('ruleDelete')}
            </button>
          </div>
        ))}
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            style={btnStyle}
            onClick={() => update((draft) => { draft.customRules.push({ name: '', pattern: '' }) })}
          >
            + {t('ruleAdd')}
          </button>
        </div>
        {(stats?.ruleErrors.length ?? 0) > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ ...hintStyle, color: c.warn, fontWeight: 600 }}>{t('ruleErrors')}</div>
            {stats!.ruleErrors.map((message, i) => <div key={i} style={errorStyle}>{message}</div>)}
          </div>
        )}
      </div>

      {/* ── 测试框 ── */}
      <div style={sectionStyle}>
        <p style={sectionTitleStyle}>{t('testTitle')}</p>
        <textarea
          value={testInput}
          placeholder={t('testPlaceholder')}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setTestInput(e.target.value)}
          style={{ ...inputStyle, minHeight: 64, resize: 'vertical' }}
        />
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" style={btnStyle} onClick={() => { void runTest() }}>{t('testRun')}</button>
          {testOutput !== '' && (
            <span style={{ fontSize: 12, color: c.textSecondary }}>{t('testResult')}：</span>
          )}
        </div>
        {testOutput !== '' && (
          <div style={{ ...sectionStyle, marginTop: 8, background: c.bgLayer, fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
            {testOutput}
          </div>
        )}
      </div>

      {/* ── 统计 ── */}
      <div style={sectionStyle}>
        <p style={sectionTitleStyle}>{t('statsTitle')}</p>
        {statEntries.length === 0 && <div style={hintStyle}>{t('statNone')}</div>}
        {statEntries.map(([code, stat]) => (
          <div key={code} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '3px 0' }}>
            <span style={{ ...chipStyle, color: STAT_COLORS[code] ?? c.text, borderColor: STAT_COLORS[code] ?? c.border }}>{code}</span>
            <span style={{ fontSize: 13, color: c.text }}>{t('statCount')} {stat.count}</span>
            {stat.lastAt !== undefined && (
              <span style={hintStyle}>{t('statLastAt')} {new Date(stat.lastAt).toLocaleString()}</span>
            )}
          </div>
        ))}
        <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={hintStyle}>{fmt('sessionsCount', { n: stats?.sessions ?? 0 })}</span>
          <button type="button" style={btnStyle} onClick={() => { void clearMaps() }}>{t('clearMaps')}</button>
          {clearedTick && <span style={{ ...hintStyle, color: c.ok }}>{t('clearMapsDone')}</span>}
        </div>
      </div>

      {/* ── 保存 ── */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 4 }}>
        <button type="button" style={primaryBtn} disabled={!dirty} onClick={() => { void save() }}>{t('save')}</button>
        {dirty && (
          <>
            <span style={{ ...hintStyle, color: c.warn }}>{t('dirty')}</span>
            <button type="button" style={btnStyle} onClick={() => { void loadConfig() }}>{t('discard')}</button>
          </>
        )}
        {savedTick && <span style={{ ...hintStyle, color: c.ok }}>{t('saved')}</span>}
        {saveError !== '' && <span style={errorStyle}>{t('saveFailed')}：{saveError}</span>}
      </div>
    </div>
  )
}
