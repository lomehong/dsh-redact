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
import { type CompiledRule } from './rules.ts';
import type { MaskMap } from './rules.ts';
export interface LogMessageLike {
    sn: number;
    ts: number;
    name: string;
    type: string;
    level: number;
    args: unknown[];
}
export interface ExporterLike {
    export(message: LogMessageLike): void;
    [key: string]: unknown;
}
export interface LoggerServiceLike {
    exporters: Map<number, ExporterLike>;
    exporter(exporter: ExporterLike): unknown;
    [key: string]: unknown;
}
/** 深遍历字符串打码；只处理 string/数组/普通对象，其余原样（避免触发 getter）。 */
export declare function maskValue(value: unknown, rules: readonly CompiledRule[], map: MaskMap, depth?: number): unknown;
export interface LogMaskHandle {
    dispose(): void;
}
/** 安装日志打码。返回卸载句柄：还原方法补丁与已替换的 Map 条目。 */
export declare function installLogMask(service: LoggerServiceLike, rules: () => readonly CompiledRule[], map: MaskMap, enabled: () => boolean, log: (line: string) => void): LogMaskHandle;
