import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSocketHostname } from '../config.js';
import { redactText } from '../redact.js';
export const ROUTE_BASE = '/_dsh/chatgpt-bridge';
export const MUTATION_HEADER = 'x-dsh-chatgpt-bridge';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_LIMIT = 1000;
function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
}
/**
 * Attach the CORS headers the browser needs on the ACTUAL mutation response.
 *
 * The preflight only authorises the request; a cross-origin (even same-port,
 * differing host spelling such as localhost vs 127.0.0.1) fetch still hides
 * the response body unless the real reply repeats Allow-Origin. Echoing the
 * validated loopback origin keeps the API unreachable from third-party pages:
 * an origin that fails originAllowed() never reaches this function.
 */
function setCorsHeaders(req, res) {
    const origin = req.headers.origin;
    if (origin !== undefined && originAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
}
function isLoopbackRemote(req) {
    const address = req.socket.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
function hostAllowed(host) {
    if (host === undefined || host === '')
        return false;
    const normalized = host.toLowerCase().replace(/\[([^\]]+)\]/g, '$1').replace(/:\d+$/, '');
    return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}
/**
 * Origin gate for mutations.
 *
 * The DSH Desktop shell serves the UI from the privileged `dsh-app://app`
 * scheme and proxies every non-static request to the owned Host over HTTP via
 * `forwardWebRequest`. That proxy is the reason this function cannot be a
 * plain "Origin must be loopback" check:
 *
 *   const origin = request.headers.get("origin");
 *   if (origin !== null && origin !== "dsh-app://app") return 403;
 *   for (const name of ["host", "origin", "cookie", "sec-fetch-site"])
 *     headers.delete(name);              // ← Origin is STRIPPED
 *   headers.set("cookie", cookie);       // ← Host-issued auth cookie added
 *
 * So a real Desktop save reaches this API with NO Origin header at all. The
 * previous code treated a missing Origin as hostile (`return false`), which
 * rejected every Desktop mutation with 403 bad-origin while GET — which never
 * checks Origin — kept working. That is precisely the reported "the settings
 * page reads fine but every save fails".
 *
 * A missing Origin is not automatically safe (a non-browser client can omit
 * it), but for a browser there is no way to strip Origin from a cross-origin
 * fetch while keeping the request. The remaining checks still carry the CSRF
 * weight:
 *   - the socket must be loopback,
 *   - Host must be an allowed loopback name,
 *   - the custom `x-dsh-chatgpt-bridge` header must be exactly '1', which a
 *     third-party page cannot send without a successful CORS preflight that
 *     only admits loopback / dsh-app origins,
 *   - Content-Type must be application/json.
 *
 * `allowMissing` is therefore only honoured on the mutation path, where those
 * header checks still run.
 */
function originAllowed(origin, allowMissing = false) {
    if (origin === undefined || origin === '')
        return allowMissing;
    // Desktop shell origin (see the scheme registration above). Accept the whole
    // scheme rather than one literal spelling, since the host part is not fixed
    // across Desktop builds.
    if (/^dsh-app:/i.test(origin))
        return true;
    // Opaque serialized origins from sandboxed/navigated Desktop frames.
    if (origin === 'null')
        return true;
    try {
        const host = normalizeSocketHostname(new URL(origin).hostname).toLowerCase();
        return host === '127.0.0.1' || host === 'localhost' || host === '::1';
    }
    catch {
        return false;
    }
}
function isMutation(method) {
    return method === 'POST' || method === 'PUT' || method === 'DELETE';
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('body-too-large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
function sanitizeConfig(raw) {
    const out = {};
    if (typeof raw !== 'object' || raw === null)
        throw new Error('invalid-config');
    const body = raw;
    const tunnel = body.tunnel;
    if (tunnel !== undefined && typeof tunnel === 'object') {
        const t = {};
        if (typeof tunnel.executable === 'string') {
            const sanitized = sanitizePath(tunnel.executable).trim();
            t.executable = sanitized === '' ? undefined : sanitized;
        }
        else if (tunnel.executable === null) {
            t.executable = undefined;
        }
        // The settings form sends an empty ID before setup and when clearing it.
        // Preserve that explicit unconfigured state; validate every nonempty ID.
        if (typeof tunnel.tunnelId === 'string')
            t.tunnelId = tunnel.tunnelId === '' ? '' : sanitizeIdentifier(tunnel.tunnelId, 256);
        if (typeof tunnel.profileName === 'string')
            t.profileName = sanitizeIdentifier(tunnel.profileName, 128);
        if (typeof tunnel.autoStart === 'boolean')
            t.autoStart = tunnel.autoStart;
        const proxy = tunnel.proxy;
        if (proxy !== undefined && typeof proxy === 'object') {
            const p = { enabled: false };
            if (typeof proxy.enabled === 'boolean')
                p.enabled = proxy.enabled;
            if (typeof proxy.host === 'string')
                p.host = sanitizeNoWhitespace(proxy.host, 255);
            if (typeof proxy.port === 'number') {
                if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535)
                    throw new Error('invalid-proxy-port');
                p.port = proxy.port;
            }
            t.proxy = p;
        }
        out.tunnel = t;
    }
    const openai = body.openai;
    if (openai !== undefined && typeof openai === 'object') {
        const o = {};
        if (typeof openai.controlPlaneBaseUrl === 'string') {
            const trimmed = openai.controlPlaneBaseUrl.trim();
            o.controlPlaneBaseUrl = trimmed === '' ? undefined : sanitizeUrl(trimmed);
        }
        else if (openai.controlPlaneBaseUrl === null) {
            o.controlPlaneBaseUrl = undefined;
        }
        // runtimeApiKeyRef is never accepted through PUT /config (secrets only via
        // the dedicated secret endpoint).
        out.openai = o;
    }
    const bridge = body.bridge;
    if (bridge !== undefined && typeof bridge === 'object') {
        const b = {};
        if (typeof bridge.endpoint === 'string')
            b.endpoint = sanitizeLoopbackUrl(bridge.endpoint);
        out.bridge = b;
    }
    return out;
}
function sanitizePath(value) {
    if (/[\x00-\x1f]/.test(value))
        throw new Error('invalid-executable');
    return value.slice(0, 1024);
}
function sanitizeIdentifier(value, max) {
    if (!/^[A-Za-z0-9._-]+$/.test(value))
        throw new Error('invalid-identifier');
    return value.slice(0, max);
}
function sanitizeNoWhitespace(value, max) {
    if (/[\s\x00-\x1f]/.test(value))
        throw new Error('invalid-value');
    return value.slice(0, max);
}
function sanitizeUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('invalid-url');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new Error('invalid-url');
    return url.toString();
}
function sanitizeLoopbackUrl(value) {
    const url = sanitizeUrl(value);
    const parsed = new URL(url);
    const host = normalizeSocketHostname(parsed.hostname).toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1')
        throw new Error('endpoint-must-be-loopback');
    return url;
}
function tailFile(path, limit) {
    try {
        if (!existsSync(path))
            return [];
        const stat = statSync(path);
        if (stat.size === 0)
            return [];
        const CHUNK_SIZE = 128 * 1024;
        let raw;
        if (stat.size <= CHUNK_SIZE) {
            raw = readFileSync(path, 'utf8');
        }
        else {
            const fd = openSync(path, 'r');
            try {
                const buffer = Buffer.alloc(CHUNK_SIZE);
                const position = stat.size - CHUNK_SIZE;
                readSync(fd, buffer, 0, CHUNK_SIZE, position);
                raw = buffer.toString('utf8');
            }
            finally {
                closeSync(fd);
            }
        }
        const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
        return lines.slice(-limit).map((line) => redactText(line));
    }
    catch {
        return [];
    }
}
export function createManagementApi(manager, options) {
    const disposers = [];
    const guard = (req, res, requireOrigin) => {
        if (!isLoopbackRemote(req)) {
            sendJson(res, 403, { ok: false, error: 'forbidden' });
            return false;
        }
        if (!hostAllowed(req.headers.host)) {
            sendJson(res, 403, { ok: false, error: 'bad-host' });
            return false;
        }
        // On the mutation path a missing Origin is expected: the DSH Desktop shell
        // strips it while forwarding dsh-app://app requests to the Host. The CSRF
        // header and Content-Type checks below still gate that path.
        if (requireOrigin && !originAllowed(req.headers.origin, true)) {
            sendJson(res, 403, { ok: false, error: 'bad-origin' });
            return false;
        }
        return true;
    };
    const guardMutation = (req, res) => {
        if (!guard(req, res, true))
            return false;
        if (req.headers[MUTATION_HEADER] !== '1') {
            sendJson(res, 403, { ok: false, error: 'bad-header' });
            return false;
        }
        const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/json') {
            sendJson(res, 415, { ok: false, error: 'content-type-must-be-json' });
            return false;
        }
        return true;
    };
    const handle = async (req, res) => {
        // Every management response carries the CORS header when the caller is an
        // allowed loopback origin, so a browser can read both success and error
        // bodies instead of failing with an opaque CORS error.
        setCorsHeaders(req, res);
        // Unconditional diagnostic trace. A user-level environment variable is NOT
        // inherited by an already-running DSH Desktop process (it needs a new
        // Opt-in request trace. Off unless DSH_BRIDGE_ROUTE_DEBUG is set to a
        // truthy value; never throws, never affects the response. Kept because the
        // Desktop proxy strips Origin, which makes "which headers actually arrived"
        // otherwise impossible to observe from outside the Host process.
        const traceEnabled = process.env.DSH_BRIDGE_ROUTE_DEBUG !== undefined
            && process.env.DSH_BRIDGE_ROUTE_DEBUG !== ''
            && process.env.DSH_BRIDGE_ROUTE_DEBUG !== '0';
        const traceSink = traceEnabled
            ? join(options.dshHome, 'chatgpt-bridge', 'logs', 'route-debug.ndjson')
            : undefined;
        if (traceSink !== undefined) {
            try {
                appendFileSync(traceSink, JSON.stringify({
                    at: new Date().toISOString(),
                    method: req.method,
                    url: req.url,
                    origin: req.headers.origin ?? null,
                    host: req.headers.host ?? null,
                    mutationHeader: req.headers[MUTATION_HEADER] ?? null,
                    contentType: req.headers['content-type'] ?? null,
                    remote: req.socket.remoteAddress ?? null,
                }) + '\n', 'utf8');
            }
            catch {
                // trace is best-effort
            }
        }
        try {
            await handleInner(req, res);
        }
        catch (error) {
            if (res.headersSent)
                return;
            sendJson(res, 500, {
                ok: false,
                error: 'internal-error',
                message: redactText(error instanceof Error ? error.message : String(error)),
            });
        }
        if (traceSink !== undefined) {
            try {
                appendFileSync(traceSink, JSON.stringify({ at: new Date().toISOString(), status: res.statusCode, url: req.url }) + '\n', 'utf8');
            }
            catch {
                // best-effort
            }
        }
    };
    const handleInner = async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const method = req.method ?? 'GET';
        const base = ROUTE_BASE;
        // CORS preflight for the management API.
        //
        // Browsers send an OPTIONS preflight before a mutation because PUT/POST
        // with `Content-Type: application/json` plus the custom
        // `x-dsh-chatgpt-bridge` header is not a simple request. Without this
        // branch the preflight fell through to 404 with no CORS headers, so the
        // real request was never sent and every save/start/stop from the settings
        // page failed while GET (a simple request) kept working.
        //
        // This is not a relaxation of the CSRF boundary: the preflight response
        // carries no credentials, mutates nothing, and still requires a loopback
        // socket, an allowed Host and an allowed Origin — the same checks the
        // real request must pass afterwards. Non-loopback origins are refused
        // here exactly as they are refused on the mutation itself.
        if (method === 'OPTIONS') {
            if (path !== base + '/status' && path !== base + '/config' &&
                path !== base + '/logs' &&
                path !== base + '/secret/runtime-api-key' &&
                path !== base + '/start' && path !== base + '/stop' &&
                path !== base + '/restart' && path !== base + '/diagnostics') {
                sendJson(res, 404, { ok: false, error: 'not-found' });
                return;
            }
            if (!isLoopbackRemote(req)) {
                sendJson(res, 403, { ok: false, error: 'forbidden' });
                return;
            }
            if (!hostAllowed(req.headers.host)) {
                sendJson(res, 403, { ok: false, error: 'bad-host' });
                return;
            }
            const origin = req.headers.origin;
            if (!originAllowed(origin)) {
                sendJson(res, 403, { ok: false, error: 'bad-origin' });
                return;
            }
            res.statusCode = 204;
            // Echo the already-validated loopback origin instead of a wildcard.
            // The API stays unreachable from third-party pages: any origin that
            // fails originAllowed() above never reaches this header.
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ' + MUTATION_HEADER);
            res.setHeader('Access-Control-Max-Age', '600');
            res.setHeader('Cache-Control', 'no-store');
            res.end();
            return;
        }
        // GET endpoints (read-only, no mutation).
        if (path === base + '/status' && method === 'GET') {
            if (!guard(req, res, false))
                return;
            await manager.refresh();
            sendJson(res, 200, { ok: true, status: manager.getSnapshot() });
            return;
        }
        if (path === base + '/config' && method === 'GET') {
            if (!guard(req, res, false))
                return;
            const config = manager.getConfig();
            const detection = await manager.getDetection();
            sendJson(res, 200, {
                ok: true,
                config,
                secrets: { runtimeApiKeyConfigured: manager.secretStore.runtimeApiKeyConfigured() },
                detection,
                discovered: manager.getDiscovery(),
            });
            return;
        }
        if (path === base + '/logs' && method === 'GET') {
            if (!guard(req, res, false))
                return;
            const component = url.searchParams.get('component') ?? 'manager';
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 200) || 200, 1), MAX_LOG_LIMIT);
            const file = component === 'tunnel' ? 'tunnel-client.ndjson' : 'manager.ndjson';
            const lines = tailFile(join(options.dshHome, 'chatgpt-bridge', 'logs', file), limit);
            sendJson(res, 200, { ok: true, component, lines });
            return;
        }
        // Mutations.
        if (path === base + '/config' && method === 'PUT') {
            if (!guardMutation(req, res))
                return;
            let parsed;
            try {
                parsed = JSON.parse(await readBody(req));
            }
            catch {
                sendJson(res, 400, { ok: false, error: 'invalid-json' });
                return;
            }
            try {
                const patch = sanitizeConfig(parsed);
                const saved = await manager.saveConfig(patch);
                sendJson(res, 200, { ok: true, config: saved });
            }
            catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid-config' });
            }
            return;
        }
        if (path === base + '/secret/runtime-api-key' && method === 'PUT') {
            if (!guardMutation(req, res))
                return;
            let parsed;
            try {
                parsed = JSON.parse(await readBody(req));
            }
            catch {
                sendJson(res, 400, { ok: false, error: 'invalid-json' });
                return;
            }
            const value = parsed?.value;
            if (typeof value !== 'string' || value.trim() === '') {
                sendJson(res, 400, { ok: false, error: 'runtime-api-key-empty' });
                return;
            }
            const ref = manager.secretStore.writeRuntimeApiKey(value);
            await manager.saveConfig({ openai: { runtimeApiKeyRef: ref } });
            sendJson(res, 200, { ok: true, configured: true });
            return;
        }
        if (path === base + '/secret/runtime-api-key' && method === 'DELETE') {
            if (!guardMutation(req, res))
                return;
            manager.secretStore.clearRuntimeApiKey();
            await manager.saveConfig({ openai: { runtimeApiKeyRef: undefined } });
            sendJson(res, 200, { ok: true, configured: false });
            return;
        }
        if (path === base + '/start' && method === 'POST') {
            if (!guardMutation(req, res))
                return;
            await readBody(req).catch(() => '');
            const status = await manager.start();
            sendJson(res, 200, { ok: true, status });
            return;
        }
        if (path === base + '/stop' && method === 'POST') {
            if (!guardMutation(req, res))
                return;
            await readBody(req).catch(() => '');
            const status = await manager.stop();
            sendJson(res, 200, { ok: true, status });
            return;
        }
        if (path === base + '/restart' && method === 'POST') {
            if (!guardMutation(req, res))
                return;
            await readBody(req).catch(() => '');
            const status = await manager.restart();
            sendJson(res, 200, { ok: true, status });
            return;
        }
        if (path === base + '/diagnostics' && method === 'POST') {
            if (!guardMutation(req, res))
                return;
            await readBody(req).catch(() => '');
            const result = await manager.diagnostics();
            sendJson(res, 200, result);
            return;
        }
        sendJson(res, 404, { ok: false, error: 'not-found' });
    };
    return {
        register(webServer) {
            disposers.push(webServer.register({ kind: 'prefix', path: ROUTE_BASE, handler: handle }));
            return () => {
                for (const dispose of disposers.splice(0))
                    dispose();
            };
        },
    };
}
