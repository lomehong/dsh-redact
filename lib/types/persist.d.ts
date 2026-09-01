import type { PersistedMaps, RedactStats } from './mapping.ts';
export interface PersistedState {
    version: 1;
    maps: PersistedMaps;
    stats: RedactStats;
}
export declare function stateFilePath(homeDir: string): string;
/** 测试可覆盖的 DSH home：优先专用环境变量，其次跟随宿主 DSH_HOME，兜底 ~/.dsh。 */
export declare function dshHome(): string;
export declare function loadState(homeDir: string): Promise<PersistedState | undefined>;
export declare function saveState(homeDir: string, state: PersistedState): Promise<void>;
