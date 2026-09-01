/**
 * 编排层集成测试：mock 宿主 cordis 上下文（事件注册 / 服务发现 / webServer 路由 /
 * this 陷阱 logger），走 apply() 全流程验证 llm/stream 监听注册、出站脱敏、入站还原、
 * settings.register 配置热重载、HTTP API（config/status/test/clear-maps）与日志打码装配。
 * 设置服务 mock 语义对齐 0.1.1-rc.2 / 0.1.2+ 的 SettingsProvider.register。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, normalizeConfigInput, type RedactConfig } from '../src/index.ts'
import type { GenerateOptionsLike, StreamChunkLike } from '../src/stream.ts'

type StreamListener = (options: GenerateOptionsLike, next: () => AsyncIterable<StreamChunkLike>) => AsyncIterable<StreamChunkLike>

interface RouteHandler {
  (req: { method?: string; headers: Record<string, string>; on: (event: string, cb: (c?: Buffer) => void) => void },
   res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body: string) => void }): void | Promise<void>
}

const BASE_CONFIG: RedactConfig = {
  maskLlm: true, restoreOutput: true, maskLogs: true,
  categories: { secret: true, id: true, bank: true, phone: true, email: true },
  customRules: [],
}

function makeHarness() {
  const listeners: Record<string, Array<(payload: never, next: never) => unknown>> = {}
  const disposers: Array<() => void> = []
  const routes: Record<string, RouteHandler> = {}
  const logs: string[] = []
  const settingsWrites: unknown[] = []
  const webServer = {
    register: (route: { path: string; handler: RouteHandler }) => {
      routes[route.path] = route.handler
      return () => { delete routes[route.path] }
    },
  }
  const ctx = {
    logger: {
      exporters: new Map<number, { export: (m: unknown) => void }>(),
      exporter(target: { export: (m: unknown) => void }): unknown {
        const key = 1 + ctx.logger.exporters.size
        ctx.logger.exporters.set(key, target)
        return () => ctx.logger.exporters.delete(key)
      },
      // 语义对齐真实 LoggerService：方法依赖 this；记录经 exporters 汇出
      info(this: { prefix?: string; exporters: Map<number, { export: (m: unknown) => void }> }, line: string) {
        if (this === undefined || (this as { prefix?: string }).prefix === undefined) throw new TypeError('this is not a function')
        for (const exporter of this.exporters.values()) {
          exporter.export({ sn: 1, ts: 2, name: 'test', type: 'info', level: 1, args: [line] })
        }
      },
      prefix: '[redact]',
    },
    get: () => undefined,
    on: (event: string, listener: (payload: never, next: never) => unknown) => { (listeners[event] ??= []).push(listener) },
    inject: (names: string[], fn: (scoped: unknown) => void) => {
      if (names.includes('webServer')) {
        fn({ webServer, effect: (f: () => () => void) => { disposers.push(f()) } })
        return
      }
      // settings 服务 mock：语义对齐 SettingsProvider.register（get/watch/update/replace）
      const settingsService = {
        register(_ns: string, _schema: unknown, options?: { base?: unknown }) {
          const scope: { base: unknown; user: Record<string, unknown>; watchers: Set<(next: unknown) => void> } = {
            base: options?.base, user: {}, watchers: new Set(),
          }
          const get = (): Record<string, unknown> => ({ ...((scope.base ?? {}) as Record<string, unknown>), ...scope.user })
          return {
            get,
            watch: (cb: (next: unknown) => void) => {
              scope.watchers.add(cb)
              return () => { scope.watchers.delete(cb) }
            },
            update: async (patch: Record<string, unknown>) => {
              Object.assign(scope.user, patch)
              for (const cb of [...scope.watchers]) cb(get())
            },
            replace: async (section: Record<string, unknown>) => {
              scope.user = { ...section }
              settingsWrites.push({ ...section })
              for (const cb of [...scope.watchers]) cb(get())
            },
          }
        },
      }
      fn({ settings: settingsService, effect: (f: () => () => void) => { disposers.push(f()) } })
    },
    effect: (f: () => () => void) => { disposers.push(f()) },
  }
  const call = async (path: string, init?: { method?: string; body?: unknown; origin?: string }): Promise<{ status: number; body: any }> => {
    const handler = routes[path]
    if (handler === undefined) throw new Error(`no route: ${path}`)
    const headers: Record<string, string> = {}
    if (init?.origin !== undefined) headers.origin = init.origin
    headers.host = 'localhost:3210'
    const req = {
      method: init?.method ?? 'GET',
      headers,
      on: (event: string, cb: (c?: Buffer) => void) => {
        if (event === 'data' && init?.body !== undefined) cb(Buffer.from(JSON.stringify(init.body)))
        if (event === 'end') cb()
      },
    }
    let status = 0
    let raw = ''
    await handler(req, { writeHead: (s: number) => { status = s }, end: (body: string) => { raw = body } })
    return { status, body: JSON.parse(raw) }
  }
  const streamListener = (): StreamListener => listeners['llm/stream']?.[0] as unknown as StreamListener
  return { ctx, logs, routes, call, settingsWrites, streamListener, disposers }
}

async function boot(config: RedactConfig = BASE_CONFIG) {
  const h = makeHarness()
  await apply(h.ctx as never, config)
  return h
}

async function* yieldChunks(chunks: StreamChunkLike[]): AsyncGenerator<StreamChunkLike> {
  for (const c of chunks) yield c
}

async function collect(iter: AsyncIterable<StreamChunkLike>): Promise<StreamChunkLike[]> {
  const out: StreamChunkLike[] = []
  for await (const c of iter) out.push(c)
  return out
}

function userOptions(text: string, sessionId = 'sess-1'): GenerateOptionsLike {
  return {
    provider: 'deepseek', model: 'chat',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
    sessionId,
  }
}

describe('编排层（apply 全流程，mock 宿主）', () => {
  let home = ''
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'redact-orch-'))
    process.env.DSH_REDACT_HOME = home
  })
  afterEach(async () => {
    delete process.env.DSH_REDACT_HOME
    await rm(home, { recursive: true, force: true })
  })

  it('llm/stream：出站脱敏 + 入站还原 + 命中进统计', async () => {
    const h = await boot()
    const listener = h.streamListener()
    expect(listener).toBeDefined()
    const result = await listener(userOptions('手机 13812345678'), () => yieldChunks([
      { type: 'text-delta', index: 0, text: '收到 [[TEL_1]]' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]))
    const chunks = await collect(result)
    expect((chunks[0] as { text: string }).text).toBe('收到 13812345678')
    const status = await h.call('/redact/api/status')
    expect(status.body.status.categories.TEL.count).toBeGreaterThanOrEqual(1)
  })

  it('同会话跨请求占位符一致；跨会话独立', async () => {
    const h = await boot()
    const listener = h.streamListener()
    // 第一次请求：s1 会话建立映射
    const first = userOptions('13812345678', 's1')
    await collect(await listener(first, () => yieldChunks([{ type: 'finish', reason: { kind: 'stop' } }])))
    expect((first.messages[0].content[0] as { text: string }).text).toBe('[[TEL_1]]')
    // 第二次请求同会话同值：同一占位符（options 被原地改写，直接断言）
    const second = userOptions('13812345678', 's1')
    await collect(await listener(second, () => yieldChunks([{ type: 'finish', reason: { kind: 'stop' } }])))
    expect((second.messages[0].content[0] as { text: string }).text).toBe('[[TEL_1]]')
    // 新值接续编号
    const third = userOptions('13912345678', 's1')
    await collect(await listener(third, () => yieldChunks([{ type: 'finish', reason: { kind: 'stop' } }])))
    expect((third.messages[0].content[0] as { text: string }).text).toBe('[[TEL_2]]')
    // 跨会话隔离：s2 的同值也编为 [[TEL_1]]
    const other = userOptions('13812345678', 's2')
    await collect(await listener(other, () => yieldChunks([{ type: 'finish', reason: { kind: 'stop' } }])))
    expect((other.messages[0].content[0] as { text: string }).text).toBe('[[TEL_1]]')
    const status = await h.call('/redact/api/status')
    expect(status.body.status.categories.TEL.count).toBe(4)
    expect(status.body.status.sessions).toBe(2)
  })

  it('PUT config 热生效：关闸后透传', async () => {
    const h = await boot()
    const saved = await h.call('/redact/api/config', {
      method: 'PUT',
      origin: 'http://localhost:3210',
      body: { ...BASE_CONFIG, maskLlm: false },
    })
    expect(saved.body.ok).toBe(true)
    expect(h.settingsWrites).toHaveLength(1)
    const listener = h.streamListener()
    const options = userOptions('13812345678')
    const result = await listener(options, () => yieldChunks([{ type: 'text-delta', index: 0, text: 'x' }]))
    await collect(result)
    expect((options.messages[0].content[0] as { text: string }).text).toBe('13812345678')
  })

  it('PUT config 跨源拒绝', async () => {
    const h = await boot()
    const saved = await h.call('/redact/api/config', {
      method: 'PUT',
      origin: 'http://evil.example',
      body: BASE_CONFIG,
    })
    expect(saved.status).toBe(403)
    expect(h.settingsWrites).toHaveLength(0)
  })

  it('PUT config 非法正则被拒绝（400）', async () => {
    const h = await boot()
    const saved = await h.call('/redact/api/config', {
      method: 'PUT',
      origin: 'http://localhost:3210',
      body: { ...BASE_CONFIG, customRules: [{ name: 'bad', pattern: '([unclosed' }] },
    })
    expect(saved.status).toBe(400)
    expect(saved.body.ok).toBe(false)
  })

  it('test 端点：一次性映射，不进会话与统计', async () => {
    const h = await boot()
    const result = await h.call('/redact/api/test', {
      method: 'POST',
      origin: 'http://localhost:3210',
      body: { text: '手机 13812345678' },
    })
    expect(result.body.masked).toBe('手机 [[TEL_1]]')
    const status = await h.call('/redact/api/status')
    expect(status.body.status.sessions).toBe(0)
    expect(status.body.status.categories.TEL).toBeUndefined()
  })

  it('clear-maps 清空会话映射', async () => {
    const h = await boot()
    const listener = h.streamListener()
    await collect(await listener(userOptions('13812345678'), () => yieldChunks([{ type: 'finish', reason: { kind: 'stop' } }])))
    expect((await h.call('/redact/api/status')).body.status.sessions).toBe(1)
    const cleared = await h.call('/redact/api/clear-maps', { method: 'POST', origin: 'http://localhost:3210' })
    expect(cleared.body.ok).toBe(true)
    expect((await h.call('/redact/api/status')).body.status.sessions).toBe(0)
  })

  it('日志打码装配：logger 输出经规则替换', async () => {
    const h = await boot()
    const target = { lines: [] as string[] }
    h.ctx.logger.exporter({ export: (m: { args: unknown[] }) => { target.lines.push(String(m.args[0])) } })
    h.ctx.logger.info.call(h.ctx.logger, '客服 13812345678 处理中')
    expect(target.lines[0]).toBe('客服 [[TEL_1]] 处理中')
    // this 陷阱：摘出引用调用必须抛错（与真实 cordis LoggerService 行为一致）
    const detached = h.ctx.logger.info
    expect(() => detached('x' as never)).toThrow(TypeError)
  })

  it('重启载入映射：占位符跨进程一致（state.json 往返）', async () => {
    const first = await boot()
    const listener = first.streamListener()
    const options = userOptions('手机 13812345678')
    await collect(await listener(options, () => yieldChunks([{ type: 'finish', reason: { kind: 'stop' } }])))
    expect((options.messages[0].content[0] as { text: string }).text).toBe('手机 [[TEL_1]]')
    // 退出兜底落盘（effect 清理器同步触发 saveState），轮询等文件出现
    for (const dispose of first.disposers) dispose()
    await vi.waitFor(async () => {
      const { loadState } = await import('../src/persist.ts')
      expect(await loadState(home)).toBeDefined()
    })

    const second = await boot()
    const status = await second.call('/redact/api/status')
    expect(status.body.status.sessions).toBe(1)
    // 第二个进程收到同占位符：还原映射已在（通过再次请求间接验证编号衔接）
    const secondListener = second.streamListener()
    const followup = userOptions('13912345678')
    await collect(await secondListener(followup, () => yieldChunks([{ type: 'finish', reason: { kind: 'stop' } }])))
    expect((followup.messages[0].content[0] as { text: string }).text).toBe('[[TEL_2]]')
  })
})

describe('normalizeConfigInput', () => {
  it('空对象 → 全默认', () => {
    const config = normalizeConfigInput({})
    expect(config.maskLlm).toBe(true)
    expect(config.categories.phone).toBe(true)
    expect(config.customRules).toEqual([])
  })
  it('非法负载拒绝', () => {
    expect(() => normalizeConfigInput(null)).toThrow()
    expect(() => normalizeConfigInput({ customRules: [{ name: '', pattern: 'x' }] })).toThrow(/名称不能为空/)
    expect(() => normalizeConfigInput({ customRules: [{ name: 'a', pattern: '' }] })).toThrow(/正则不能为空/)
    expect(() => normalizeConfigInput({ customRules: [{ name: 'a', pattern: '([bad' }] })).toThrow(/正则非法/)
  })
})
