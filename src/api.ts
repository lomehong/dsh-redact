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
import type { Context } from '@deepseek-ai/cordis'
import { normalizeConfigInput, type RedactConfig } from './index.ts'

export interface StatusProvider {
  config: () => RedactConfig
  stats: () => {
    categories: Record<string, { count: number; lastAt?: number }>
    sessions: number
    ruleErrors: string[]
  }
  test: (text: string) => string
  clearMaps: () => void
  replaceConfig: (next: RedactConfig) => Promise<void>
}

interface ReqLike {
  method?: string
  headers: Record<string, string | string[] | undefined>
  on: (event: string, cb: (chunk?: Buffer) => void) => void
}

interface ResLike {
  writeHead: (status: number, headers: Record<string, string>) => void
  end: (body: string) => void
}

interface WebServerLike {
  register: (route: { kind: 'exact'; path: string; handler: (req: ReqLike, res: ResLike) => void | Promise<void> }) => () => void
}

interface ScopedCtx {
  webServer: WebServerLike
  effect: (fn: () => () => void) => void
}

const MAX_BODY_BYTES = 1024 * 1024

function readBody(req: ReqLike): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk) => {
      if (chunk === undefined) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体超过 1MB 上限'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ResLike, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** 跨站写防护：带 Origin 的请求必须同源（GET 无 Origin 直接放行）。 */
function sameOrigin(req: ReqLike): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(String(origin)).host === host
  } catch {
    return false
  }
}

export function registerRedactApi(ctx: Context, provider: StatusProvider, log: (line: string) => void): void {
  ;(ctx as unknown as { inject: (names: string[], fn: (scoped: unknown) => void) => void }).inject(['webServer'], (scoped: unknown) => {
    const web = (scoped as unknown as ScopedCtx)
    const disposers: Array<() => void> = []

    const safe = (handler: (req: ReqLike, res: ResLike) => void | Promise<void>): ((req: ReqLike, res: ResLike) => Promise<void>) => {
      return async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log(`HTTP 处理器异常：${message}`)
          try { sendJson(res, 500, { ok: false, error: message }) } catch { /* 响应头已发出 */ }
        }
      }
    }

    disposers.push(web.webServer.register({ kind: 'exact', path: '/redact/api/config', handler: safe(async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, config: provider.config() })
        return
      }
      if (req.method !== 'PUT') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin denied' })
        return
      }
      try {
        const body = await readBody(req)
        const parsed = normalizeConfigInput(JSON.parse(body))
        await provider.replaceConfig(parsed)
        sendJson(res, 200, { ok: true, config: parsed })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`配置保存失败：${message}`)
        sendJson(res, 400, { ok: false, error: message })
      }
    }) }))

    disposers.push(web.webServer.register({ kind: 'exact', path: '/redact/api/status', handler: safe((_req, res) => {
      sendJson(res, 200, { ok: true, status: provider.stats() })
    }) }))

    disposers.push(web.webServer.register({ kind: 'exact', path: '/redact/api/test', handler: safe(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin denied' })
        return
      }
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body) as { text?: unknown }
        const text = typeof parsed.text === 'string' ? parsed.text : ''
        if (text.length > 100_000) throw new Error('测试文本超过 100KB 上限')
        sendJson(res, 200, { ok: true, masked: provider.test(text) })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }) }))

    disposers.push(web.webServer.register({ kind: 'exact', path: '/redact/api/clear-maps', handler: safe(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin denied' })
        return
      }
      provider.clearMaps()
      log('会话映射表已清空（进行中会话的占位符将无法继续还原，直至新值重新编号）')
      sendJson(res, 200, { ok: true })
    }) }))

    web.effect(() => () => {
      for (const dispose of disposers) dispose()
    })
  })
}
