import { normalizeConfigInput } from "./index.js";
const MAX_BODY_BYTES = 1024 * 1024;
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            if (chunk === undefined)
                return;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('请求体超过 1MB 上限'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
function sendJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
}
/** 跨站写防护：带 Origin 的请求必须同源（GET 无 Origin 直接放行）。 */
function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin === undefined)
        return true;
    const host = req.headers.host;
    if (typeof host !== 'string' || host === '')
        return false;
    try {
        return new URL(String(origin)).host === host;
    }
    catch {
        return false;
    }
}
export function registerRedactApi(ctx, provider, log) {
    ;
    ctx.inject(['webServer'], (scoped) => {
        const web = scoped;
        const disposers = [];
        const safe = (handler) => {
            return async (req, res) => {
                try {
                    await handler(req, res);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    log(`HTTP 处理器异常：${message}`);
                    try {
                        sendJson(res, 500, { ok: false, error: message });
                    }
                    catch { /* 响应头已发出 */ }
                }
            };
        };
        disposers.push(web.webServer.register({ kind: 'exact', path: '/redact/api/config', handler: safe(async (req, res) => {
                if (req.method === 'GET') {
                    sendJson(res, 200, { ok: true, config: provider.config() });
                    return;
                }
                if (req.method !== 'PUT') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' });
                    return;
                }
                if (!sameOrigin(req)) {
                    sendJson(res, 403, { ok: false, error: 'cross-origin denied' });
                    return;
                }
                try {
                    const body = await readBody(req);
                    const parsed = normalizeConfigInput(JSON.parse(body));
                    await provider.replaceConfig(parsed);
                    sendJson(res, 200, { ok: true, config: parsed });
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    log(`配置保存失败：${message}`);
                    sendJson(res, 400, { ok: false, error: message });
                }
            }) }));
        disposers.push(web.webServer.register({ kind: 'exact', path: '/redact/api/status', handler: safe((_req, res) => {
                sendJson(res, 200, { ok: true, status: provider.stats() });
            }) }));
        disposers.push(web.webServer.register({ kind: 'exact', path: '/redact/api/test', handler: safe(async (req, res) => {
                if (req.method !== 'POST') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' });
                    return;
                }
                if (!sameOrigin(req)) {
                    sendJson(res, 403, { ok: false, error: 'cross-origin denied' });
                    return;
                }
                try {
                    const body = await readBody(req);
                    const parsed = JSON.parse(body);
                    const text = typeof parsed.text === 'string' ? parsed.text : '';
                    if (text.length > 100_000)
                        throw new Error('测试文本超过 100KB 上限');
                    sendJson(res, 200, { ok: true, masked: provider.test(text) });
                }
                catch (error) {
                    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
                }
            }) }));
        disposers.push(web.webServer.register({ kind: 'exact', path: '/redact/api/clear-maps', handler: safe(async (req, res) => {
                if (req.method !== 'POST') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' });
                    return;
                }
                if (!sameOrigin(req)) {
                    sendJson(res, 403, { ok: false, error: 'cross-origin denied' });
                    return;
                }
                provider.clearMaps();
                log('会话映射表已清空（进行中会话的占位符将无法继续还原，直至新值重新编号）');
                sendJson(res, 200, { ok: true });
            }) }));
        web.effect(() => () => {
            for (const dispose of disposers)
                dispose();
        });
    });
}
