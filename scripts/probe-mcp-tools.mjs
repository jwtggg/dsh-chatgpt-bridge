// Verification probe for a running dsh-chatgpt-bridge MCP endpoint.
// Usage: node scripts/probe-mcp-tools.mjs [url] [tokenFile]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:3456/mcp';
const tokenFile = process.argv[3] ?? join(homedir(), '.dsh', 'chatgpt-bridge.token');
const token = process.env.DSH_CHATGPT_BRIDGE_TOKEN ?? readFileSync(tokenFile, 'utf8').trim();
const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const rpc = async (body, sessionId) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: sessionId === undefined ? headers : { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('');
  return { status: response.status, sessionId: response.headers.get('mcp-session-id'), json: payload === '' ? undefined : JSON.parse(payload) };
};

const init = await rpc({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1.0' } },
});
if (init.status !== 200 || init.sessionId === null) throw new Error(`initialize failed: ${init.status}`);
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId);
const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.sessionId);
if (tools.json?.result === undefined) throw new Error(`tools/list failed: ${JSON.stringify(tools)}`);
const names = tools.json.result.tools.map((tool) => tool.name).sort();
console.log(`server = ${tools.json.result.serverInfo?.name ?? init.json?.result?.serverInfo?.name} ${init.json?.result?.serverInfo?.version ?? ''}`.trim());
console.log(`tool count = ${names.length}`);
for (const name of names) console.log(`  ${name}`);
