/**
 * 日志打码：包装 cordis LoggerService 的 exporter 汇出层。
 *
 * 一切日志输出必经 exporter（`Logger.format(exporter, message)` 由 exporter
 * 驱动），因此包装两层即可全量覆盖：
 * 1. 现有 exporters Map 的条目逐个替换为打码代理（宿主控制台 exporter 先于
 *    插件注册，必须补包）；
 * 2. `service.exporter()` 方法替换为包装版，后续插件/宿主注册的 exporter
 *    天然被覆盖；注册方返回的 disposer 原样透传（按 key 删除，不受影响）。
 *
 * 打码 = 深遍历 message.args 中的字符串做假名替换（独立全局映射，只打码
 * 不还原）。传给原 exporter 的是浅拷贝 message（不改动 service.buffer 中的
 * 原记录，也避免触碰带 getter 的奇异对象）。
 *
 * cordis logger 的 this 陷阱（v0.2.0 启动事故教训）：凡摘出方法引用一律先
 * `.bind(service)`，否则 detached 调用抛 TypeError 且被 cordis 升级为 fatal。
 */
import { maskText, type CompiledRule } from './rules.ts'
import type { MaskMap } from './rules.ts'

export interface LogMessageLike {
  sn: number
  ts: number
  name: string
  type: string
  level: number
  args: unknown[]
}

export interface ExporterLike {
  export(message: LogMessageLike): void
  [key: string]: unknown
}

export interface LoggerServiceLike {
  exporters: Map<number, ExporterLike>
  exporter(exporter: ExporterLike): unknown
  [key: string]: unknown
}

const MAX_WALK_DEPTH = 4

/** 深遍历字符串打码；只处理 string/数组/普通对象，其余原样（避免触发 getter）。 */
export function maskValue(value: unknown, rules: readonly CompiledRule[], map: MaskMap, depth = 0): unknown {
  if (typeof value === 'string') return value === '' ? value : maskText(value, rules, map).text
  if (depth >= MAX_WALK_DEPTH) return value
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const masked = maskValue(item, rules, map, depth + 1)
      if (masked !== item) changed = true
      return masked
    })
    return changed ? out : value
  }
  if (isPlainObject(value)) {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const masked = maskValue(item, rules, map, depth + 1)
      if (masked !== item) changed = true
      out[key] = masked
    }
    return changed ? out : value
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function wrapExporter(original: ExporterLike, rules: () => readonly CompiledRule[], map: MaskMap, enabled: () => boolean): ExporterLike {
  const wrapped = Object.create(original) as ExporterLike
  wrapped.export = (message: LogMessageLike): void => {
    if (!enabled() || !Array.isArray(message?.args)) {
      original.export(message)
      return
    }
    try {
      const args = message.args.map((arg) => maskValue(arg, rules(), map))
      original.export({ ...message, args })
    } catch {
      original.export(message) // 打码失败宁可放原文，不可打断日志写出
    }
  }
  return wrapped
}

export interface LogMaskHandle {
  dispose(): void
}

/** 安装日志打码。返回卸载句柄：还原方法补丁与已替换的 Map 条目。 */
export function installLogMask(
  service: LoggerServiceLike,
  rules: () => readonly CompiledRule[],
  map: MaskMap,
  enabled: () => boolean,
  log: (line: string) => void,
): LogMaskHandle {
  const replaced: Array<{ key: number; original: ExporterLike }> = []

  // 1. 补包现有 exporter（重复安装防御：已是代理的对象跳过——代理自身带标记）
  try {
    for (const [key, exporter] of [...service.exporters]) {
      if (exporter === null || typeof exporter !== 'object' || typeof exporter.export !== 'function') continue
      if ((exporter as { __dshRedactWrapped?: boolean }).__dshRedactWrapped === true) continue
      const wrapped = wrapExporter(exporter, rules, map, enabled)
      ;(wrapped as { __dshRedactWrapped?: boolean }).__dshRedactWrapped = true
      service.exporters.set(key, wrapped)
      replaced.push({ key, original: exporter })
    }
  } catch (error) {
    log(`包装现有日志 exporter 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 2. 补丁注册方法：后续注册的 exporter 也走代理；disposer 透传
  const originalRegister = service.exporter.bind(service)
  const patched = (target: ExporterLike): unknown => {
    if (target !== null && typeof target === 'object' && typeof target.export === 'function'
      && (target as { __dshRedactWrapped?: boolean }).__dshRedactWrapped !== true) {
      const wrapped = wrapExporter(target, rules, map, enabled)
      ;(wrapped as { __dshRedactWrapped?: boolean }).__dshRedactWrapped = true
      return originalRegister(wrapped)
    }
    return originalRegister(target)
  }
  try {
    ;(service as { exporter: unknown }).exporter = patched
  } catch (error) {
    log(`补丁日志注册方法失败：${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    dispose(): void {
      try {
        ;(service as { exporter: unknown }).exporter = originalRegister
      } catch { /* ignore */ }
      for (const { key, original } of replaced) {
        const current = service.exporters.get(key)
        if (current !== undefined && (current as { __dshRedactWrapped?: boolean }).__dshRedactWrapped === true) {
          service.exporters.set(key, original)
        }
      }
    },
  }
}
