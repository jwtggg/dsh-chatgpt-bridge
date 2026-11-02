import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, name, Config } from '../../lib/index.js';
import { createMcpServer, GOAL_TOOLS } from '../../lib/mcp.js';
import { startHttpServer } from '../../lib/http.js';

/** The exact host this tree was typechecked and integration-verified against. */
const VERIFIED_DSH_VERSION = '0.2.1-rc.5';
/**
 * The compatibility window this plugin declares.
 *
 * It must satisfy two INDEPENDENT semver interpretations:
 *  - DSH's install gate (`evaluatePluginCompatibility`) tests the runtime with
 *    `includePrerelease: true`;
 *  - npm/pnpm resolve peer dependencies with plain (prerelease-excluding) rules.
 * A plain open range such as `>=0.2.0-rc.2 <0.3.0` satisfies the gate but makes
 * npm reject the very host it must install, because no prerelease counts as
 * satisfying that range under default semantics. Naming the verified
 * prereleases explicitly and OR-ing the release line keeps both readers happy.
 */
const DSH_COMPAT_WINDOW = '>=0.2.0-rc.2 <=0.2.1-rc.5 || ^0.2.1-rc.5';

const EXPECTED_TOOLS = [
  'dsh_answer_question',
  'dsh_approve',
  'dsh_cancel_task',
  'dsh_create_goal',
  'dsh_create_session',
  'dsh_credential_status',
  'dsh_get_result',
  'dsh_get_session',
  'dsh_get_session_model',
  'dsh_get_task_status',
  'dsh_health',
  'dsh_list_models',
  'dsh_list_sessions',
  'dsh_list_workspaces',
  'dsh_pause_goal',
  'dsh_rerun_step',
  'dsh_resume_goal',
  'dsh_retry_step',
  'dsh_revise_goal',
  'dsh_send_message',
  'dsh_set_session_model',
  'dsh_start_goal',
  'dsh_stop_goal',
  'dsh_update_goal',
  'dsh_wait_goal',
  'dsh_wait_until_action_required',
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitListening(port, timeoutMs = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await response.text();
      return response.status;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw last ?? new Error(`port ${port} never accepted connections`);
}

async function waitClosed(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 40));
    } catch {
      return;
    }
  }
  throw new Error(`port ${port} still accepted connections after close`);
}

function pluginCtx() {
  const disposers = [];
  const services = {
    agents: { get: () => undefined, list: () => [] },
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  return {
    disposers,
    ctx: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      get: (key) => services[key],
      agents: services.agents,
      sessions: services.sessions,
      sessionPersistence: services.sessionPersistence,
      agentDefaultModel: services.agentDefaultModel,
      on: () => () => true,
      inject: () => ({}),
      effect: (execute) => {
        const disposer = execute();
        disposers.push(disposer);
        return disposer;
      },
    },
  };
}

test('shipped plugin entry exports name, apply, and Config', async () => {
  assert.equal(name, 'chatgpt-bridge');
  assert.equal(typeof apply, 'function');
  assert.ok(Config);
});

test('createMcpServer registers all public dsh_* tools (v0.5.0)', () => {
  const server = createMcpServer(
    {},
    { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  const names = Object.keys(server._registeredTools).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
  assert.equal(names.length, 26);
});

test('disableGoalTools removes exactly the supervised-Goal tools', () => {
  const server = createMcpServer(
    {},
    {
      resultMaxChars: 100,
      resultMaxItems: 10,
      sessionMaxItems: 5,
      sessionMaxChars: 100,
      disableGoalTools: true,
    },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  const names = Object.keys(server._registeredTools).sort();
  const expected = EXPECTED_TOOLS.filter((tool) => !GOAL_TOOLS.includes(tool)).sort();
  assert.deepEqual(names, expected);
  assert.equal(names.length, EXPECTED_TOOLS.length - GOAL_TOOLS.length);
  for (const goalTool of GOAL_TOOLS) {
    assert.ok(!names.includes(goalTool), `${goalTool} must be hidden when disableGoalTools is set`);
  }
  // The plain session surface must survive so ChatGPT can still drive DSH.
  for (const kept of ['dsh_health', 'dsh_create_session', 'dsh_send_message', 'dsh_get_result']) {
    assert.ok(names.includes(kept), `${kept} must stay available`);
  }
});

test('GOAL_TOOLS names only real registered tools', () => {
  assert.ok(GOAL_TOOLS.length > 0);
  for (const name of GOAL_TOOLS) {
    assert.ok(EXPECTED_TOOLS.includes(name), `${name} is not a registered tool`);
  }
});

test('goal-loop guard config resolves with safe defaults', async () => {
  const { resolveConfig } = await import('../../lib/config.js');
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-config-'));
  const env = { DSH_HOME: home, USERPROFILE: home };
  try {
    const defaults = resolveConfig({}, env);
    assert.equal(defaults.disableGoalTools, false, 'goal tools stay on by default');
    assert.equal(defaults.maxGoalWaits, 0, 'no wait cap by default');

    const configured = resolveConfig({ disableGoalTools: true, maxGoalWaits: 3 }, env);
    assert.equal(configured.disableGoalTools, true);
    assert.equal(configured.maxGoalWaits, 3);

    assert.equal(resolveConfig({ maxGoalWaits: -5 }, env).maxGoalWaits, 0, 'negative means unlimited');
    assert.equal(resolveConfig({ maxGoalWaits: 2.9 }, env).maxGoalWaits, 2, 'truncated to an integer');

    const schemaDefaults = Config({});
    assert.equal(schemaDefaults.disableGoalTools, false);
    assert.equal(schemaDefaults.maxGoalWaits, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('package clean script is ESM-safe under type:module', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.type, 'module');
  assert.match(manifest.scripts.clean, /import\s*\{[^}]*rmSync/);
  assert.doesNotMatch(manifest.scripts.clean, /\brequire\s*\(/);
});

test('shared DSH host contracts are peers instead of ordinary dependencies', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const sharedHostPackages = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm'];

  for (const packageName of sharedHostPackages) {
    assert.equal(manifest.dependencies?.[packageName], undefined);
    assert.equal(typeof manifest.peerDependencies?.[packageName], 'string');
    assert.equal(typeof manifest.devDependencies?.[packageName], 'string');
  }
});

test('package manifest pins the verified npm latest baseline without claiming other prereleases', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  // The host advances through prereleases faster than this plugin publishes.
  // The manifest therefore declares the verified 0.2.x compatibility WINDOW
  // (engines.dsh decides alone at install time) instead of one exact rc that
  // goes stale on the next host release, which is what made DSH refuse to load
  // the plugin at all. Dev dependencies stay pinned to one concrete host so the
  // typecheck and integration runs remain reproducible.
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [packageName, version] of Object.entries(manifest[section] ?? {})) {
      if (packageName.startsWith('@deepseek-ai/dsh-')) assert.equal(version, VERIFIED_DSH_VERSION, `${section}.${packageName}`);
    }
  }
  assert.equal(manifest.engines?.dsh, DSH_COMPAT_WINDOW);
  for (const name of ['agent', 'agent-preset-registry', 'session', 'session-title', 'llm']) {
    assert.equal(manifest.peerDependencies[`@deepseek-ai/dsh-${name}`], DSH_COMPAT_WINDOW);
    assert.equal(manifest.dependencies[`@deepseek-ai/dsh-${name}`], undefined);
  }
  assert.equal(manifest.devDependencies['@deepseek-ai/cordis'], '4.0.5');
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '~4.0.5');
});

test('the declared DSH compatibility window accepts the verified hosts and excludes other majors', async () => {
  const semver = (await import('semver')).default;
  // The previous baseline and the host this plugin was re-verified on must both
  // install without a risk exemption, or the fix has not actually landed.
  // Assert BOTH interpretations: DSH's gate includes prereleases, npm's peer
  // resolution does not, and a window that only satisfies one of them breaks
  // real installations for one of the two installers.
  for (const version of ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.5', '0.2.1-rc.6']) {
    assert.equal(semver.satisfies(version, DSH_COMPAT_WINDOW, { includePrerelease: true }), true, `${version} (dsh gate)`);
    assert.equal(semver.satisfies(version, DSH_COMPAT_WINDOW), true, `${version} (npm peer resolution)`);
  }
  for (const version of ['0.1.7-rc.2', '0.3.0', '1.0.0']) {
    assert.equal(semver.satisfies(version, DSH_COMPAT_WINDOW, { includePrerelease: true }), false, `${version} (dsh gate)`);
    assert.equal(semver.satisfies(version, DSH_COMPAT_WINDOW), false, `${version} (npm peer resolution)`);
  }
});

test('package.json and package-lock.json carry the same release version', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));

  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages?.['']?.version, manifest.version);
});

test('test runner selects the Node 22 isolation spelling before running the suite', () => {
  const runner = readFileSync(new URL('../../scripts/test.mjs', import.meta.url), 'utf8');
  assert.match(runner, /nodeMajor === 22\s*\?\s*['"]--experimental-test-isolation=none['"]/);
  assert.doesNotMatch(runner, /result\.status\s*===\s*9/);
});

test('release gate covers installed tarball and all CI matrix entries', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const gate = readFileSync(new URL('../../scripts/release-package-test.mjs', import.meta.url), 'utf8');
  assert.equal(manifest.scripts['test:release'], 'node scripts/release-package-test.mjs');
  assert.match(workflow, /run: npm run test:release/);
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest\]/);
  assert.match(workflow, /node: \[22, 24\]/);
  assert.match(gate, /pack\.filename/);
  assert.match(gate, /dsh-host\.test\.mjs/);
  assert.match(gate, /dsh-cli\.test\.mjs/);
});

test('current README and Goal dogfood stay aligned with the shipped control-plane surface', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const dogfood = readFileSync(new URL('../../scripts/goal-control-dogfood.mjs', import.meta.url), 'utf8');

  assert.match(readme, new RegExp(`v${manifest.version.replaceAll('.', '\\.')}`));
  assert.match(readme, /tool count = 26/);
  assert.match(dogfood, new RegExp(`version:\\s*['"]${manifest.version.replaceAll('.', '\\.')}['"]`));
  assert.match(dogfood, /dsh_create_goal/);
  assert.match(dogfood, /dsh_wait_until_action_required/);
});

test('startHttpServer.close stops accepting connections', async () => {
  const port = await freePort();
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const handle = await startHttpServer(
    () => createMcpServer({}, { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 }, log),
    { host: '127.0.0.1', port, authMode: 'none', authToken: '' },
    log,
  );
  try {
    const status = await waitListening(handle.port);
    assert.equal(typeof status, 'number');
    await handle.close();
    await waitClosed(handle.port);
  } catch (error) {
    try { await handle.close(); } catch { /* already closed or failed to start */ }
    throw error;
  }
});

test('apply effect disposer waits for HTTP close', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-apply-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const port = await freePort();
  const { ctx, disposers } = pluginCtx();
  try {
    apply(ctx, {
      transport: 'http',
      host: '127.0.0.1',
      port,
      authMode: 'none',
      logLevel: 'error',
    });
    assert.ok(disposers.length >= 1);
    await waitListening(port);
    for (const disposer of [...disposers].reverse()) {
      await disposer();
    }
    await waitClosed(port);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
