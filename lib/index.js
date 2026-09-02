import z from '@deepseek-ai/schemastery';
import { builtinRules, compileCustomRules, compileTermRules, createMaskMap, maskText, } from "./rules.js";
import { MappingStore } from "./mapping.js";
import { loadState, saveState, stateFilePath, dshHome } from "./persist.js";
import { makeStreamListener } from "./stream.js";
import { installLogMask } from "./logmask.js";
import { registerRedactApi } from "./api.js";
export const Config = z.object({
    /** 发往 LLM 的消息脱敏（总开关）。 */
    maskLlm: z.boolean().default(true),
    /** 模型输出中的占位符还原为真实值。 */
    restoreOutput: z.boolean().default(true),
    /** 日志输出打码（只打码不还原）。 */
    maskLogs: z.boolean().default(true),
    categories: z.object({
        secret: z.boolean().default(true),
        id: z.boolean().default(true),
        bank: z.boolean().default(true),
        phone: z.boolean().default(true),
        email: z.boolean().default(true),
    }).default({
        secret: true, id: true, bank: true, phone: true, email: true,
    }),
    customRules: z.array(z.object({
        name: z.string(),
        pattern: z.string(),
    })).default([]),
    aliases: z.array(z.object({
        term: z.string(),
        replacement: z.string(),
    })).default([]),
});
export const name = 'redact';
const NS = 'redact';
/** UI 提交的配置规范化与合法性检查（自定义正则当场编译，非法拒绝保存）。 */
export function normalizeConfigInput(payload) {
    if (payload === null || typeof payload !== 'object')
        throw new Error('配置必须是对象');
    const raw = payload;
    const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
    const categoriesRaw = (raw.categories ?? {});
    const rulesRaw = Array.isArray(raw.customRules) ? raw.customRules : [];
    if (rulesRaw.length > 50)
        throw new Error('自定义规则超过 50 条上限');
    const customRules = rulesRaw.map((item, index) => {
        if (item === null || typeof item !== 'object')
            throw new Error(`customRules[${index}] 必须是对象`);
        const ruleName = String(item.name ?? '').trim();
        const pattern = String(item.pattern ?? '');
        if (ruleName === '')
            throw new Error(`customRules[${index}] 的名称不能为空`);
        if (pattern === '')
            throw new Error(`自定义规则「${ruleName}」的正则不能为空`);
        if (pattern.length > 200)
            throw new Error(`自定义规则「${ruleName}」的正则超过 200 字符上限`);
        try {
            void new RegExp(pattern);
        }
        catch (error) {
            throw new Error(`自定义规则「${ruleName}」的正则非法：${error instanceof Error ? error.message : String(error)}`);
        }
        return { name: ruleName, pattern };
    });
    // 实体别名：原词字面量匹配 → 固定替换词（单向，不还原）。校验与引擎编译同规。
    const aliasRaw = Array.isArray(raw.aliases) ? raw.aliases : [];
    if (aliasRaw.length > 100)
        throw new Error('别名规则超过 100 条上限');
    const seenAliasTerms = new Set();
    const aliases = aliasRaw.map((item, index) => {
        if (item === null || typeof item !== 'object')
            throw new Error(`aliases[${index}] 必须是对象`);
        const term = String(item.term ?? '').trim();
        const replacement = String(item.replacement ?? '').trim();
        if (term === '')
            throw new Error(`aliases[${index}] 的原词不能为空`);
        if (replacement === '')
            throw new Error(`别名「${term}」的替换词不能为空`);
        if (term.length > 64)
            throw new Error(`别名「${term.slice(0, 20)}…」的原词超过 64 字符上限`);
        if (replacement.length > 64)
            throw new Error(`别名「${term}」的替换词超过 64 字符上限`);
        if (term === replacement)
            throw new Error(`别名「${term}」的原词与替换词相同（无意义）`);
        if (term.startsWith('[[') || replacement.startsWith('[['))
            throw new Error(`别名「${term}」的原词/替换词不能是占位符形态 [[CODE_N]]`);
        if (seenAliasTerms.has(term))
            throw new Error(`别名「${term}」重复定义`);
        seenAliasTerms.add(term);
        return { term, replacement };
    });
    return {
        maskLlm: bool(raw.maskLlm, true),
        restoreOutput: bool(raw.restoreOutput, true),
        maskLogs: bool(raw.maskLogs, true),
        categories: {
            secret: bool(categoriesRaw.secret, true),
            id: bool(categoriesRaw.id, true),
            bank: bool(categoriesRaw.bank, true),
            phone: bool(categoriesRaw.phone, true),
            email: bool(categoriesRaw.email, true),
        },
        customRules,
        aliases,
    };
}
export async function apply(ctx, config) {
    // 优先宿主 logger；必须以成员调用保持 this 绑定（cordis LoggerService this 陷阱）
    const log = (() => {
        try {
            const logger = ctx.logger;
            if (logger !== undefined && typeof logger.info === 'function') {
                const info = logger.info.bind(logger);
                return (line) => {
                    try {
                        info(line);
                    }
                    catch { /* ignore */ }
                };
            }
        }
        catch { /* ignore */ }
        return (line) => { process.stdout.write(`[redact] ${line}\n`); };
    })();
    // ── 配置来源：settings.register（0.1.1-rc.2 与 0.1.2+ 同款 API）。
    // 组合层 config 为 base 基线；scope.get 为解析值；watch 热重载；replace 供 UI 整节保存 ──
    let readConfig = () => config;
    let replaceConfigBySettings;
    const rebuildFromSettings = () => {
        try {
            rebuild(readConfig());
        }
        catch (error) {
            log(`配置变更应用失败：${error instanceof Error ? error.message : String(error)}`);
        }
    };
    ctx.inject(['settings'], (sctx) => {
        const settings = sctx.settings;
        if (settings === undefined || typeof settings.register !== 'function')
            return;
        try {
            const scope = settings.register(NS, Config, { base: config });
            readConfig = () => scope.get();
            scope.watch(() => rebuildFromSettings());
            replaceConfigBySettings = (next) => scope.replace(next);
        }
        catch (error) {
            log(`设置节注册失败（配置退回组合层基线）：${error instanceof Error ? error.message : String(error)}`);
        }
    });
    // ── 运行时 ──
    const rt = {
        config,
        rules: [],
        ruleErrors: [],
    };
    function compileRules(next) {
        const builtins = builtinRules(next.categories);
        const { rules, errors } = compileCustomRules(next.customRules);
        const term = compileTermRules(next.aliases);
        rt.ruleErrors = [...errors, ...term.errors];
        for (const message of rt.ruleErrors)
            log(`规则编译警告：${message}`);
        // 别名规则排最末：敏感数据命中优先（重叠时别名让位，绝不在密钥命中区掏洞）
        return [...builtins, ...rules, ...term.rules];
    }
    function rebuild(next) {
        rt.config = next;
        rt.rules = compileRules(next);
        const on = Object.entries(next.categories).filter(([, v]) => v).map(([k]) => k);
        log(`配置已应用：LLM 脱敏=${next.maskLlm ? '开' : '关'} 输出还原=${next.restoreOutput ? '开' : '关'} 日志打码=${next.maskLogs ? '开' : '关'}；内置类别=${on.join(',') || '无'} 自定义规则=${next.customRules.length} 别名=${next.aliases?.length ?? 0}`);
    }
    rt.rules = compileRules(config);
    // ── 映射表与持久化（启动载入 → 去抖落盘 → 退出兜底） ──
    const store = new MappingStore();
    const home = dshHome();
    const persisted = await loadState(home);
    if (persisted !== undefined) {
        store.loadPersistable(persisted.maps, Date.now());
        for (const [code, stat] of Object.entries(persisted.stats?.categories ?? {})) {
            if (stat !== null && typeof stat === 'object' && typeof stat.count === 'number') {
                store.mergePersistedStat(code, stat.count, typeof stat.lastAt === 'number' ? stat.lastAt : undefined);
            }
        }
        log(`已载入 ${store.sessionCount()} 个会话映射`);
    }
    const stateSnapshot = () => ({ version: 1, maps: store.toPersistable(), stats: store.snapshotStats() });
    let persistTimer;
    let pendingSave = false;
    const persist = () => {
        pendingSave = true;
        if (persistTimer !== undefined)
            return;
        persistTimer = setTimeout(() => {
            persistTimer = undefined;
            if (!pendingSave)
                return;
            pendingSave = false;
            void saveState(home, stateSnapshot()).catch((error) => {
                log(`状态写入失败：${error instanceof Error ? error.message : String(error)}`);
            });
        }, 500);
    };
    ctx.effect(() => () => {
        if (persistTimer !== undefined)
            clearTimeout(persistTimer);
        if (pendingSave) {
            void saveState(home, stateSnapshot()).catch(() => { });
        }
    });
    // ── llm/stream：出站脱敏 + 入站还原 ──
    const mapFor = (options) => {
        const sid = typeof options?.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : 'global';
        return store.sessionMap(sid, Date.now());
    };
    let warnedNoLlm = false;
    const events = ctx;
    events.on('llm/stream', makeStreamListener({
        mapFor,
        onHits: (hits) => {
            if (hits.length > 0) {
                store.recordHits(hits, Date.now());
                persist();
            }
        },
        rules: () => (rt.config.maskLlm ? rt.rules : []),
        restore: () => rt.config.restoreOutput,
        streamDirect: (options) => {
            // 0.1.2 起 agent-loop 对请求 deepFreeze：克隆脱敏后经 llm 服务二次下发
            const llm = ctx.get('llm');
            if (llm === undefined || typeof llm.stream !== 'function') {
                if (!warnedNoLlm) {
                    warnedNoLlm = true;
                    log('冻结请求环境下 llm 服务不可用，出站脱敏降级为不生效（还原仍工作）');
                }
                throw new Error('llm service unavailable');
            }
            return llm.stream(options);
        },
    }));
    // ── 日志打码（logger 为 cordis 内建服务，缺席时跳过） ──
    try {
        const logger = ctx.logger;
        if (logger !== undefined && logger.exporters instanceof Map && typeof logger.exporter === 'function') {
            const handle = installLogMask(logger, () => (rt.config.maskLogs ? rt.rules : []), store.logMap, () => rt.config.maskLogs, log);
            ctx.effect(() => () => handle.dispose());
        }
    }
    catch (error) {
        log(`日志打码安装失败：${error instanceof Error ? error.message : String(error)}`);
    }
    // ── 会话清理巡检（TTL + 总量上限） ──
    const timer = setInterval(() => {
        if (store.prune(Date.now()) > 0)
            persist();
    }, 30 * 60_000);
    ctx.effect(() => () => clearInterval(timer));
    // ── HTTP API ──
    const statusProvider = {
        config: () => readConfig(),
        stats: () => ({
            ...store.snapshotStats(),
            sessions: store.sessionCount(),
            ruleErrors: [...rt.ruleErrors],
        }),
        test: (text) => maskText(text, rt.rules, createMaskMap()).text, // 一次性映射：不污染会话编号与统计
        clearMaps: () => {
            store.clearSessions();
            persist();
        },
        replaceConfig: async (next) => {
            if (replaceConfigBySettings !== undefined) {
                await replaceConfigBySettings(next);
                return;
            }
            throw new Error('settings 服务不可用（组合层为只读基线）');
        },
    };
    registerRedactApi(ctx, statusProvider, log);
    log(`已加载：LLM 脱敏=${config.maskLlm ? '开' : '关'} 日志打码=${config.maskLogs ? '开' : '关'}；状态文件 ${stateFilePath(home)}`);
}
