/**
 * 0.1.7 宿主类型接缝：loader 的 volatile 配置原位提交事件。纯类型，无运行时。
 * 顶层 import 使本文件成为模块——declare module 由此是「扩充」而非环境声明。
 */
import type {} from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly (string | number)[])[]): void
  }
}
