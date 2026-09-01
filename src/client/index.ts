/**
 * dsh-redact 客户端插件：在设置面板注册顶级「数据脱敏」Tab
 * （与 模型切换/插件管理 同级，注入方式同 dsh-model-failover 的 settings.section）。
 * 开关组 + 内置类别 + 自定义规则 CRUD + 脱敏测试框 + 命中统计，经插件 HTTP API 读写。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: 拉入设置页与插槽的类型合并
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { RedactSettingsTab } from './RedactSettingsTab.tsx'
import { en, zh, type RedactKey } from './locales.ts'

export const inject = ['slots', 'locale']

const NS = 'redact'

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'redact: copy dictionaries')
  const t = ctx.locale.bind(NS) as (key: RedactKey) => string

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'redact',
    order: 26,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t: (key: RedactKey) => t(key) }),
  }, RedactSettingsTab))
}
