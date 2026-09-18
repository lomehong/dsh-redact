/**
 * dsh-redact 客户端插件：在「插件」管理页注册本插件的配置区
 * （plugins.bundle.config 槽位，key=包名；插件卡片渲染一行摘要，详情页渲染完整配置表单）。
 * 开关组 + 内置类别 + 自定义规则 CRUD + 脱敏测试框 + 命中统计，经插件 HTTP API 读写。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: 拉入插槽与 locale 的类型合并
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { RedactPluginConfig } from './RedactSettingsTab.tsx'
import { en, zh, type RedactKey } from './locales.ts'

export const inject = ['slots', 'locale']

const NS = 'redact'

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'redact: copy dictionaries')
  const t = ctx.locale.bind(NS) as (key: RedactKey) => string

  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: '@dsh-extra/dsh-redact',
  }, (props: { view: 'summary' | 'page' }) => RedactPluginConfig({ view: props.view, t })))
}
