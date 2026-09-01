/**
 * 宿主客户端模块的最小环境声明：这些包由 DSH 前端运行时在浏览器侧提供、
 * 不随插件 npm 发布，此处仅声明本插件用到的面，供 tsconfig.client.json
 * 做独立严格类型检查。真实类型以宿主包为准，运行时经 ModuleLoader externals 解析。
 */
declare module '@deepseek-ai/dsh-client-runtime/client' {
  export interface LocaleApi {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown
    bind(namespace: string): (key: string) => string
  }
  export interface SlotsApi {
    inject(slot: string, setup: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  export interface ClientContext {
    effect<T>(factory: () => T, id?: string): T
    locale: LocaleApi
    slots: SlotsApi
  }
}
declare module '@deepseek-ai/dsh-client-ui-settings/client'
declare module '@deepseek-ai/dsh-client-ui-slots'
declare module '@deepseek-ai/dsh-client-locale/client'
