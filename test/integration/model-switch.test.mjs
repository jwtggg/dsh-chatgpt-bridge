// End-to-end model switching through the REAL DSH seams: a real Cordis host, the
// real session event log, the real LLM registry, and the real native
// `model/selection` seam installed by `installModelSelection`. No model API call
// is made and no agent-loop is required — the point is that a switch reaches
// DSH's own durable state and conversation identity instead of a bridge-local
// cache, and that every read is re-derived from that state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Llm, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge } from '../../lib/bridge.js';
import { createMcpServer } from '../../lib/mcp.js';

const EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
];

/** Stub adapter: a two-provider catalog with one reasoning model, no network. */
class StubAdapter extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: provider === 'alpha' ? 'Alpha Provider' : 'Beta Provider' };
  }
  async listModels(provider) {
    if (provider === 'alpha') {
      return [
        { provider, id: 'alpha-fast', name: 'Alpha Fast' },
        { provider, id: 'alpha-think', name: 'Alpha Think', description: 'reasoning' },
        { provider, id: 'alpha-broken', name: 'Alpha Broken' },
      ];
    }
    if (provider === 'beta') return [{ provider, id: 'beta-pro', name: 'Beta Pro' }];
    return [];
  }
  async resolveModel(provider, model) {
    if (model === 'alpha-broken') throw new Error('adapter has no metadata for this model');
    if (provider === 'alpha' && model === 'alpha-think') {
      return {
        provider, id: model, name: 'Alpha Think',
        reasoning: { efforts: EFFORTS, defaultEffort: 'low' },
        context: { contextWindow: 128000 },
      };
    }
    return { provider, id: model, name: model };
  }
  async *stream() {
    throw new Error('this test never calls a model');
  }
}

const LOG = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * A host where the model state is genuinely DSH's: a real session log, a real
 * projection registry and the real native selection seam. Agents are constructed
 * directly (there is no agent-loop here), and the bridge's own setup callback is
 * applied to each one exactly as `agents.create`/`resume` would apply it.
 */
async function makeHost() {
  const ctx = new Context();
  for (const plugin of [Agents, Sessions, Projections, Llm]) {
    await ctx.plugin(plugin, {});
  }
  ctx.llm.registerAdapter(['alpha', 'beta'], new StubAdapter());
  const bridge = new Bridge(ctx, { sessionMaxItems: 10, sessionMaxChars: 500 }, LOG);
  const setup = await bridge.composeSetupFor(undefined);
  const live = new Map();
  // A closed session keeps only its durable log, exactly like a process restart.
  const persisted = new Map();
  const agentsApi = {
    get: (id) => live.get(id),
    list: () => [...live.values()],
    create: async ({ sessionId, meta }) => {
      const session = ctx.sessions.create(sessionId, { meta });
      const agent = { id: session.id, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session, ctx };
      live.set(session.id, agent);
      await setup.setup(ctx, agent);
      return { agent };
    },
    resume: async ({ resumeSessionId, setup: resumeSetup }) => {
      const snapshot = persisted.get(resumeSessionId);
      if (snapshot === undefined) throw new Error('missing');
      // Replay the durable log into a fresh session object with the same id —
      // the same conversation, exactly as a real cold resume does.
      const session = ctx.sessions.create(resumeSessionId, { meta: snapshot.meta });
      for (const event of snapshot.events) {
        const data = event.data;
        if (event.surfaceOp === undefined) session.append(event.type, data);
        else session.append(event.type, data, { surfaceOp: event.surfaceOp });
      }
      const agent = { id: session.id, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session, ctx };
      live.set(session.id, agent);
      if (resumeSetup !== undefined) await resumeSetup(ctx, agent);
      return { agent };
    },
  };
  const services = {
    agents: agentsApi,
    sessions: ctx.sessions,
    llm: ctx.llm,
    sessionPersistence: {
      list: async () => [...live.values()].map((agent) => agent.session.header),
      inspect: async (id) => {
        const agent = live.get(id);
        if (agent !== undefined) {
          return { meta: agent.session.header, events: agent.session.snapshotEvents() };
        }
        const snapshot = persisted.get(id);
        if (snapshot === undefined) throw new Error('missing');
        return snapshot;
      },
    },
  };
  const bridgeCtx = {
    get: (key) => services[key],
    agents: agentsApi,
    sessions: ctx.sessions,
    on: (...args) => ctx.on(...args),
    effect: (...args) => ctx.effect(...args),
  };
  Object.defineProperty(bridge, 'ctx', { value: bridgeCtx, writable: true });
  bridge.start();

  /** Drop a live session the way a process exit does: only the log survives. */
  const closeSession = (id) => {
    const agent = live.get(id);
    if (agent === undefined) return;
    persisted.set(id, { meta: agent.session.header, events: agent.session.snapshotEvents() });
    live.delete(id);
  };
  return { ctx, bridge, live, persisted, closeSession };
}

/** A session with a believable history: one completed turn on alpha/alpha-fast. */
async function makeSession(host, id) {
  const handle = await host.bridge.ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: process.cwd() } });
  const { session } = handle.agent;
  session.append('turn/start', { turn: 1 });
  // Surface-eligible events must declare how they entered the model-visible
  // surface, exactly as the agent loop does when it commits them.
  session.append('user/message', {
    id: 'm-1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
  }, { surfaceOp: 'append' });
  session.append('request/header', {
    header: { config: { provider: 'alpha', model: 'alpha-fast' } },
  });
  session.append('assistant/message', {
    turn: 1, step: 0,
    message: {
      id: 'a-1', role: 'assistant', content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'model', provider: 'alpha', model: 'alpha-fast' },
    },
  }, { surfaceOp: 'append' });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  host.bridge.adopt(handle.agent.id);
  return handle;
}

test('dsh_list_models reads the live catalog with availability and thinking levels', async () => {
  const host = await makeHost();
  try {
    const catalog = await host.bridge.listModels();
    assert.deepEqual(catalog.providers.map((group) => group.provider_id).sort(), ['alpha', 'beta']);
    const alpha = catalog.providers.find((group) => group.provider_id === 'alpha');
    assert.equal(alpha.provider_name, 'Alpha Provider');
    const think = alpha.models.find((model) => model.model_id === 'alpha-think');
    assert.equal(think.available, true);
    assert.equal(think.switch_supported, true);
    assert.deepEqual(think.thinking_levels.map((level) => level.id), ['low', 'high']);
    assert.equal(think.default_thinking_level, 'low');
    assert.equal(think.context_window, 128000);
    // A model whose metadata cannot be resolved is reported, never dropped.
    const broken = alpha.models.find((model) => model.model_id === 'alpha-broken');
    assert.equal(broken.available, false);
    assert.equal(broken.switch_supported, false);
    assert.match(broken.unavailable_reason, /no metadata/);
    assert.equal(catalog.model_count, 4);
    assert.deepEqual(catalog.failures, []);
    assert.equal(catalog.switch_support.same_session, true);
    assert.equal(catalog.switch_support.cross_provider, true);
    // Never leaks credential-shaped data.
    assert.equal(/api[-_]?key|token|secret/i.test(JSON.stringify(catalog)), false);
  } finally {
    await host.ctx.fiber.dispose();
  }
});

test('dsh_get_session_model reports the model the last request actually used', async () => {
  const host = await makeHost();
  try {
    await makeSession(host, 'model-read');
    const view = await host.bridge.getSessionModel('model-read');
    assert.equal(view.provider, 'alpha');
    assert.equal(view.model, 'alpha-fast');
    assert.equal(view.effective_from, 'last_request');
    assert.deepEqual(view.last_request, { provider: 'alpha', model: 'alpha-fast' });
    assert.equal(view.pending, null);
    assert.equal(view.live, true);
    assert.equal(view.managed, true);
    assert.equal(view.running, false);
    assert.equal(view.switch_supported, true);
  } finally {
    await host.ctx.fiber.dispose();
  }
});

test('dsh_set_session_model switches an idle session in place and stays pending until used', async () => {
  const host = await makeHost();
  try {
    const handle = await makeSession(host, 'model-switch');
    const before = handle.agent.session.snapshotEvents().length;
    const result = await host.bridge.setSessionModel({
      session_id: 'model-switch', provider_id: 'beta', model_id: 'beta-pro',
    });
    assert.equal(result.accepted, true);
    assert.equal(result.saved, true);
    assert.equal(result.effective, 'next_request');
    assert.deepEqual(result.selected, { provider: 'beta', model: 'beta-pro' });
    assert.equal(result.before.model, 'alpha-fast');
    assert.equal(result.after.model, 'beta-pro');
    // Saved but not yet used — the honest "not on the wire yet" signal.
    assert.equal(result.verified.pending_matches, true);
    assert.equal(result.verified.last_request_unchanged, true);
    assert.equal(typeof result.saved_seq, 'number');
    // Same session object, same id, history intact — no new conversation.
    assert.equal(handle.agent.session.id, 'model-switch');
    const events = handle.agent.session.snapshotEvents();
    assert.ok(events.length > before);
    const selection = events.filter((event) => event.type === 'model/selection');
    assert.equal(selection.length, 1);
    assert.equal(selection[0].data.provider, 'beta');
    assert.equal(selection[0].data.model, 'beta-pro');
    assert.equal(events.filter((event) => event.type === 'user/message').length, 1);
    assert.equal(events.filter((event) => event.type === 'assistant/message').length, 1);

    const after = await host.bridge.getSessionModel('model-switch');
    assert.equal(after.provider, 'beta');
    assert.equal(after.model, 'beta-pro');
    assert.equal(after.effective_from, 'pending');
    assert.deepEqual(after.pending, { provider: 'beta', model: 'beta-pro' });
    // The previous request stays visible as what actually ran.
    assert.deepEqual(after.last_request, { provider: 'alpha', model: 'alpha-fast' });
  } finally {
    await host.ctx.fiber.dispose();
  }
});

test('the recorded selection reaches the native seam DSH assembles the next request from', async () => {
  const host = await makeHost();
  try {
    const handle = await makeSession(host, 'model-seam');
    await host.bridge.setSessionModel({ session_id: 'model-seam', provider_id: 'beta', model_id: 'beta-pro' });
    // Drive the real native order: the selection is snapshotted during prompt
    // assembly, and the `agent/request` waterfall then applies that snapshot.
    await host.ctx.waterfall('system-prompt/assemble', {}, {}, () => ({ variables: {} }));
    const routed = await host.ctx.waterfall(
      'agent/request',
      { provider: 'alpha', model: 'alpha-fast' },
      () => ({ provider: 'alpha', model: 'alpha-fast' }),
    );
    assert.equal(routed.provider, 'beta');
    assert.equal(routed.model, 'beta-pro');
    assert.ok(handle.agent.session.snapshotEvents().some((event) => event.type === 'model/selection'));
  } finally {
    await host.ctx.fiber.dispose();
  }
});

test('the switch survives a cold read of the same session log', async () => {
  const host = await makeHost();
  try {
    const handle = await makeSession(host, 'model-cold');
    await host.bridge.setSessionModel({ session_id: 'model-cold', provider_id: 'beta', model_id: 'beta-pro' });
    // Simulate the live session going away: only the durable log remains.
    host.closeSession('model-cold');
    assert.equal(host.ctx.agents.get(SessionId('model-cold')), undefined);
    const view = await host.bridge.getSessionModel('model-cold');
    assert.equal(view.live, false);
    assert.equal(view.model, 'beta-pro');
    assert.equal(view.effective_from, 'pending');
    assert.deepEqual(view.last_request, { provider: 'alpha', model: 'alpha-fast' });
    void handle;
  } finally {
    await host.ctx.fiber.dispose();
  }
});

test('switching preserves session id, workspace and full history', async () => {
  const host = await makeHost();
  try {
    const handle = await makeSession(host, 'model-history');
    const idBefore = handle.agent.session.header.id;
    const cwdBefore = handle.agent.session.header.cwd;
    const typesBefore = handle.agent.session.snapshotEvents().map((event) => event.type);
    await host.bridge.setSessionModel({ session_id: 'model-history', provider_id: 'beta', model_id: 'beta-pro' });
    assert.equal(handle.agent.session.header.id, idBefore);
    assert.equal(handle.agent.session.header.cwd, cwdBefore);
    const typesAfter = handle.agent.session.snapshotEvents().map((event) => event.type);
    // Every earlier event is still there, in order, with only the selection added.
    assert.deepEqual(typesAfter.slice(0, typesBefore.length), typesBefore);
    assert.deepEqual(typesAfter.slice(typesBefore.length), ['model/selection']);
  } finally {
    await host.ctx.fiber.dispose();
  }
});

test('a thinking level is validated against the target model and applied when supported', async () => {
  const host = await makeHost();
  try {
    await makeSession(host, 'model-think');
    const ok = await host.bridge.setSessionModel({
      session_id: 'model-think', provider_id: 'alpha', model_id: 'alpha-think', thinking_level: 'high',
    });
    assert.deepEqual(ok.selected, { provider: 'alpha', model: 'alpha-think', thinking_level: 'high' });
    const view = await host.bridge.getSessionModel('model-think');
    assert.equal(view.thinking_level, 'high');
    // A level the target does not declare is refused, naming the supported set.
    await assert.rejects(
      () => host.bridge.setSessionModel({
        session_id: 'model-think', provider_id: 'alpha', model_id: 'alpha-fast', thinking_level: 'high',
      }),
      (error) => {
        assert.equal(error.code, 'UNSUPPORTED_REASONING_EFFORT');
        assert.deepEqual(error.details.supported, []);
        return true;
      },
    );
    // A level from another model's list is refused too.
    await assert.rejects(
      () => host.bridge.setSessionModel({
        session_id: 'model-think', provider_id: 'beta', model_id: 'beta-pro', thinking_level: 'high',
      }),
      (error) => error.code === 'UNSUPPORTED_REASONING_EFFORT',
    );
    // A refused level must not have replaced the working selection.
    assert.equal((await host.bridge.getSessionModel('model-think')).thinking_level, 'high');
  } finally {
    await host.ctx.fiber.dispose();
  }
});

test('invalid provider, model and session ids fail with distinct codes', async () => {
  const host = await makeHost();
  try {
    await makeSession(host, 'model-invalid');
    await assert.rejects(
      () => host.bridge.setSessionModel({ session_id: 'model-invalid', provider_id: 'nope', model_id: 'x' }),
      (error) => error.code === 'INVALID_PROVIDER',
    );
    await assert.rejects(
      () => host.bridge.setSessionModel({ session_id: 'model-invalid', provider_id: 'alpha', model_id: 'nope' }),
      (error) => error.code === 'INVALID_MODEL',
    );
    // Advertised by the catalog but unusable in this profile.
    await assert.rejects(
      () => host.bridge.setSessionModel({ session_id: 'model-invalid', provider_id: 'alpha', model_id: 'alpha-broken' }),
      (error) => error.code === 'INVALID_MODEL',
    );
    await assert.rejects(
      () => host.bridge.setSessionModel({ session_id: 'no-such-session', provider_id: 'alpha', model_id: 'alpha-fast' }),
      (error) => error.code === 'SESSION_NOT_FOUND',
    );
    await assert.rejects(
      () => host.bridge.getSessionModel('no-such-session'),
      (error) => error.code === 'SESSION_NOT_FOUND',
    );
    // A failed switch must leave the session untouched.
    const view = await host.bridge.getSessionModel('model-invalid');
    assert.equal(view.model, 'alpha-fast');
    assert.equal(view.pending, null);
  } finally {
    await host.ctx.fiber.dispose();
  }
});

test('a switch never mutates a different session', async () => {
  const host = await makeHost();
  try {
    await makeSession(host, 'model-iso-a');
    const b = await makeSession(host, 'model-iso-b');
    await host.bridge.setSessionModel({ session_id: 'model-iso-a', provider_id: 'beta', model_id: 'beta-pro' });
    assert.equal((await host.bridge.getSessionModel('model-iso-a')).model, 'beta-pro');
    const viewB = await host.bridge.getSessionModel('model-iso-b');
    assert.equal(viewB.model, 'alpha-fast');
    assert.equal(viewB.pending, null);
    assert.equal(b.agent.session.snapshotEvents().filter((event) => event.type === 'model/selection').length, 0);
  } finally {
    await host.ctx.fiber.dispose();
  }
});

test('the global default model is never written by a session switch', async () => {
  const host = await makeHost();
  try {
    await makeSession(host, 'model-default');
    const defaults = host.ctx.get('agentDefaultModel');
    const before = defaults === undefined ? undefined : { ...defaults.currentSelection() };
    await host.bridge.setSessionModel({ session_id: 'model-default', provider_id: 'beta', model_id: 'beta-pro' });
    if (defaults !== undefined) assert.deepEqual({ ...defaults.currentSelection() }, before);
  } finally {
    await host.ctx.fiber.dispose();
  }
});

test('a live session the bridge does not own is refused instead of faked', async () => {
  const host = await makeHost();
  try {
    // Built without the bridge's setup callback: no bridge-owned selection ref.
    // This is how a session started by another DSH entry point looks from here.
    const session = host.ctx.sessions.create(SessionId('model-foreign'), { meta: { cwd: process.cwd() } });
    const agent = { id: session.id, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session, ctx: host.ctx };
    host.live.set(session.id, agent);
    const view = await host.bridge.getSessionModel('model-foreign');
    assert.equal(view.live, true);
    assert.equal(view.managed, false);
    assert.equal(view.switch_supported, false);
    assert.match(view.switch_blocked_reason, /another DSH entry point/);
    await assert.rejects(
      () => host.bridge.setSessionModel({ session_id: 'model-foreign', provider_id: 'alpha', model_id: 'alpha-fast' }),
      (error) => error.code === 'MODEL_SWITCH_UNSUPPORTED',
    );
    // Nothing was written and no new conversation was created.
    assert.equal(session.snapshotEvents().filter((event) => event.type === 'model/selection').length, 0);
    assert.equal(host.live.get('model-foreign'), agent);
  } finally {
    await host.ctx.fiber.dispose();
  }
});

test('a running session can still switch, and it is never reported as already effective', async () => {
  const host = await makeHost();
  try {
    const handle = await makeSession(host, 'model-running');
    handle.agent.status = 'running';
    const result = await host.bridge.setSessionModel({
      session_id: 'model-running', provider_id: 'beta', model_id: 'beta-pro',
    });
    // DSH applies the selection at the next prompt assembly, so this is honest:
    // accepted and saved, still pending, existing work untouched.
    assert.equal(result.accepted, true);
    assert.equal(result.effective, 'next_request');
    assert.equal(result.verified.last_request_unchanged, true);
    const view = await host.bridge.getSessionModel('model-running');
    assert.equal(view.running, true);
    assert.equal(view.effective_from, 'pending');
    assert.equal(handle.agent.status, 'running');
  } finally {
    await host.ctx.fiber.dispose();
  }
});

test('getSession and listSessions carry the model without duplicating switch logic', async () => {
  const host = await makeHost();
  try {
    await makeSession(host, 'model-summary');
    const view = await host.bridge.getSession('model-summary');
    assert.deepEqual(view.model, { provider: 'alpha', model: 'alpha-fast' });
    assert.equal(view.model_from, 'last_request');
    await host.bridge.setSessionModel({ session_id: 'model-summary', provider_id: 'beta', model_id: 'beta-pro' });
    const after = await host.bridge.getSession('model-summary');
    assert.deepEqual(after.model, { provider: 'beta', model: 'beta-pro' });
    assert.equal(after.model_from, 'pending');
    const listed = (await host.bridge.listSessions({})).find((row) => row.session_id === 'model-summary');
    assert.deepEqual(listed.model, { provider: 'beta', model: 'beta-pro' });
    assert.equal(listed.model_from, 'pending');
  } finally {
    await host.ctx.fiber.dispose();
  }
});

/**
 * The whole path ChatGPT actually takes: a real MCP client over a real MCP
 * transport calling the three registered tools, which resolve to the bridge,
 * which writes DSH's own durable session state — then read back through the
 * same wire. This proves the MCP schema, the bridge logic and the DSH seam
 * agree, rather than each layer being tested against a hand-written stub.
 */
test('the saved switch is still the session model after a full DSH + bridge restart', async () => {
  const first = await makeHost();
  let persistDir;
  let snapshot;
  try {
    const handle = await makeSession(first, 'model-restart');
    const originalTypes = handle.agent.session.snapshotEvents().map((event) => event.type);
    await first.bridge.setSessionModel({ session_id: 'model-restart', provider_id: 'beta', model_id: 'beta-pro' });
    snapshot = first.live.get('model-restart').session.snapshotEvents();
    persistDir = { meta: handle.agent.session.header, events: snapshot };
    assert.deepEqual(originalTypes, ['turn/start', 'user/message', 'request/header', 'assistant/message', 'turn/end']);
  } finally {
    // Tear the whole host down: new Cordis context, new projections, new bridge.
    await first.ctx.fiber.dispose();
  }
  const ctx = new Context();
  for (const plugin of [Agents, Sessions, Projections, Llm]) {
    await ctx.plugin(plugin, {});
  }
  ctx.llm.registerAdapter(['alpha', 'beta'], new StubAdapter());
  const bridge = new Bridge(ctx, { sessionMaxItems: 10, sessionMaxChars: 500 }, LOG);
  const agentsApi = { get: () => undefined, list: () => [], create: async () => { throw new Error('not used'); } };
  const bridgeCtx = {
    get: (key) => (key === 'llm' ? ctx.llm : key === 'sessions' ? ctx.sessions : key === 'agents' ? agentsApi
      : key === 'sessionPersistence' ? { list: async () => [persistDir.meta], inspect: async () => persistDir } : undefined),
    agents: agentsApi,
    sessions: ctx.sessions,
    on: (...args) => ctx.on(...args),
    effect: (...args) => ctx.effect(...args),
  };
  Object.defineProperty(bridge, 'ctx', { value: bridgeCtx, writable: true });
  bridge.start();
  try {
    // A brand new bridge, reading only the durable log, agrees with what the
    // first bridge wrote — the switch is DSH state, not bridge memory.
    const view = await bridge.getSessionModel('model-restart');
    assert.equal(view.live, false);
    assert.equal(view.model, 'beta-pro');
    assert.equal(view.effective_from, 'pending');
    assert.deepEqual(view.last_request, { provider: 'alpha', model: 'alpha-fast' });
    const session = await bridge.getSession('model-restart');
    assert.deepEqual(session.model, { provider: 'beta', model: 'beta-pro' });
    assert.equal(session.model_from, 'pending');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('disableGoalTools hides the Goal surface over the real MCP wire', async () => {
  const host = await makeHost();
  // In production the bridge and the MCP server share one resolved config; this
  // host builds the bridge before the MCP server, so mirror the flag onto it.
  host.bridge.cfg = { ...host.bridge.cfg, disableGoalTools: true };
  const server = createMcpServer(
    host.bridge,
    {
      resultMaxChars: 8000,
      resultMaxItems: 50,
      sessionMaxItems: 20,
      sessionMaxChars: 4000,
      disableGoalTools: true,
    },
    LOG,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'goal-tools-off', version: '1.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const goalTool of [
      'dsh_start_goal', 'dsh_wait_goal', 'dsh_wait_until_action_required', 'dsh_create_goal',
      'dsh_revise_goal', 'dsh_update_goal', 'dsh_pause_goal', 'dsh_resume_goal',
      'dsh_retry_step', 'dsh_rerun_step', 'dsh_stop_goal',
    ]) {
      assert.ok(!names.includes(goalTool), `${goalTool} must not be advertised`);
    }
    assert.equal(names.length, 15);
    // The plain session surface is still reachable over the wire.
    const result = await client.callTool({ name: 'dsh_health', arguments: {} });
    const health = JSON.parse(result.content.find((item) => item.type === 'text').text);
    assert.equal(health.capabilities.goalSupervision, false);
    // A hidden tool is genuinely unknown to the client, not merely unlisted.
    const hidden = await client.callTool({ name: 'dsh_wait_goal', arguments: { session_id: 'x' } });
    assert.equal(hidden.isError, true);
    assert.match(hidden.content[0].text, /not found|unknown tool/i);
  } finally {
    await client.close().catch(() => {});
    await host.ctx.fiber.dispose();
  }
});

test('MCP tools walk MCP -> bridge -> DSH -> read-back and keep one conversation', async () => {
  const host = await makeHost();
  const server = createMcpServer(host.bridge, { resultMaxChars: 8000, resultMaxItems: 50, sessionMaxItems: 20, sessionMaxChars: 4000 }, LOG);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'model-switch-contract', version: '1.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const name of ['dsh_list_models', 'dsh_get_session_model', 'dsh_set_session_model']) {
      assert.ok(names.includes(name), `missing tool ${name}`);
    }
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name} failed: ${result.content[0]?.text}`);
      return JSON.parse(result.content.find((item) => item.type === 'text').text);
    };

    const catalog = await call('dsh_list_models', {});
    assert.equal(catalog.providers.length, 2);
    const beta = catalog.providers.find((group) => group.provider_id === 'beta');
    assert.deepEqual(beta.models.map((model) => model.model_id), ['beta-pro']);

    await makeSession(host, 'model-mcp');
    const before = await call('dsh_get_session_model', { session_id: 'model-mcp' });
    assert.equal(before.model, 'alpha-fast');
    assert.equal(before.effective_from, 'last_request');

    const switched = await call('dsh_set_session_model', {
      session_id: 'model-mcp', provider_id: 'beta', model_id: 'beta-pro',
    });
    assert.equal(switched.accepted, true);
    assert.equal(switched.saved, true);
    assert.deepEqual(switched.selected, { provider: 'beta', model: 'beta-pro' });
    assert.equal(switched.verified.pending_matches, true);
    assert.equal(switched.verified.last_request_unchanged, true);

    const after = await call('dsh_get_session_model', { session_id: 'model-mcp' });
    assert.equal(after.provider, 'beta');
    assert.equal(after.effective_from, 'pending');
    assert.deepEqual(after.last_request, { provider: 'alpha', model: 'alpha-fast' });
    // The session ChatGPT named is the session that changed — nothing else did.
    const session = host.live.get('model-mcp').session;
    assert.equal(session.id, 'model-mcp');
    assert.equal(session.snapshotEvents().filter((event) => event.type === 'user/message').length, 1);

    // Errors cross the wire as structured, actionable results, not exceptions.
    const missing = await client.callTool({
      name: 'dsh_set_session_model',
      arguments: { session_id: 'model-mcp', provider_id: 'nope', model_id: 'x' },
    });
    assert.equal(missing.isError, true);
    assert.equal(JSON.parse(missing.content[0].text).error.code, 'INVALID_PROVIDER');
    const badSession = await client.callTool({ name: 'dsh_get_session_model', arguments: { session_id: 'absent' } });
    assert.equal(badSession.isError, true);
    assert.equal(JSON.parse(badSession.content[0].text).error.code, 'SESSION_NOT_FOUND');

    // Regression: the existing tools still work next to the new ones.
    const health = await call('dsh_health', {});
    assert.equal(health.status, 'ok');
    assert.equal(health.capabilities.goalSupervision, true);
    assert.equal(typeof health.sessions.live, 'number');
  } finally {
    await client.close().catch(() => {});
    await host.ctx.fiber.dispose();
  }
});
