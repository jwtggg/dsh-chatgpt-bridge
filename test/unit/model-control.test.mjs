// Model-control unit tests: the pure fold/effective helpers the live and cold
// read paths share. No DSH host is needed — these are the invariants the bridge
// relies on to tell "saved" from "actually effective".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyModelSelectionEvent,
  effectiveModel,
  foldModelSelection,
  initModelSelectionState,
  isBusyStatus,
  modelBrief,
  parseModelSelectionState,
  parseModelSelectionView,
  sameModelBrief,
} from '../../lib/model-control.js';

const ev = (type, data, seq = 0, time = 0) => ({ type, seq, time, data });
const selection = (provider, model, reasoningEffort) => ({
  provider,
  model,
  ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
});
const requestHeader = (provider, model, reasoningEffort) => ({
  header: { config: selection(provider, model, reasoningEffort) },
});

test('modelBrief maps provider/model and only a non-empty effort', () => {
  assert.deepEqual(modelBrief(selection('p', 'm')), { provider: 'p', model: 'm' });
  assert.deepEqual(modelBrief(selection('p', 'm', 'high')), { provider: 'p', model: 'm', thinking_level: 'high' });
  assert.deepEqual(modelBrief(selection('p', 'm', '')), { provider: 'p', model: 'm' });
  assert.equal(modelBrief(null), undefined);
  assert.equal(modelBrief(undefined), undefined);
});

test('sameModelBrief compares all three fields and treats empty as equal', () => {
  const a = { provider: 'p', model: 'm' };
  assert.equal(sameModelBrief(a, { provider: 'p', model: 'm' }), true);
  assert.equal(sameModelBrief(a, { provider: 'p', model: 'm', thinking_level: 'high' }), false);
  assert.equal(sameModelBrief(a, { provider: 'p', model: 'other' }), false);
  assert.equal(sameModelBrief(a, { provider: 'other', model: 'm' }), false);
  assert.equal(sameModelBrief(null, undefined), true);
  assert.equal(sameModelBrief(a, null), false);
});

test('a model/selection event queues a pending value, not a used one', () => {
  const state = applyModelSelectionEvent(initModelSelectionState(), ev('model/selection', selection('p', 'm2')));
  assert.deepEqual(state, { lastUsed: null, pending: { provider: 'p', model: 'm2' } });
});

test('a request/header records lastUsed and clears a caught-up pending', () => {
  let state = applyModelSelectionEvent(initModelSelectionState(), ev('model/selection', selection('p', 'm2')));
  state = applyModelSelectionEvent(state, ev('request/header', requestHeader('p', 'm2')));
  assert.deepEqual(state, { lastUsed: { provider: 'p', model: 'm2' }, pending: null });
});

test('a request on the OLD model leaves the new pending selection queued', () => {
  let state = applyModelSelectionEvent(initModelSelectionState(), ev('model/selection', selection('p', 'm2')));
  state = applyModelSelectionEvent(state, ev('request/header', requestHeader('p', 'm1')));
  assert.deepEqual(state.lastUsed, { provider: 'p', model: 'm1' });
  assert.deepEqual(state.pending, { provider: 'p', model: 'm2' });
});

test('a repeated identical model/selection event is idempotent', () => {
  const once = foldModelSelection([ev('model/selection', selection('p', 'm2'))]);
  const twice = foldModelSelection([
    ev('model/selection', selection('p', 'm2')),
    ev('model/selection', selection('p', 'm2')),
  ]);
  assert.deepEqual(twice, once);
});

test('foldModelSelection ignores unrelated events and keeps order', () => {
  const state = foldModelSelection([
    ev('turn/start', { turn: 1 }),
    ev('request/header', requestHeader('p', 'm1')),
    ev('user/message', { id: 'x' }),
    ev('model/selection', selection('p', 'm2', 'high')),
  ]);
  assert.deepEqual(state, { lastUsed: { provider: 'p', model: 'm1' }, pending: { provider: 'p', model: 'm2', thinking_level: 'high' } });
});

test('effectiveModel prefers pending, then lastUsed, then the host default', () => {
  const def = { provider: 'd', model: 'default' };
  assert.deepEqual(
    effectiveModel({ state: { lastUsed: { provider: 'p', model: 'used' }, pending: { provider: 'p', model: 'next' } }, default: def }),
    { brief: { provider: 'p', model: 'next' }, source: 'pending' },
  );
  assert.deepEqual(
    effectiveModel({ state: { lastUsed: { provider: 'p', model: 'used' }, pending: null }, default: def }),
    { brief: { provider: 'p', model: 'used' }, source: 'last_request' },
  );
  assert.deepEqual(
    effectiveModel({ state: { lastUsed: null, pending: null }, default: def }),
    { brief: def, source: 'default' },
  );
  assert.deepEqual(
    effectiveModel({ state: { lastUsed: null, pending: null }, default: null }),
    { brief: null, source: 'default' },
  );
});

test('parseModelSelectionState reads DSH host state and tolerates garbage', () => {
  assert.deepEqual(
    parseModelSelectionState({ lastUsed: selection('p', 'm1'), pending: selection('p', 'm2', 'low') }),
    { lastUsed: { provider: 'p', model: 'm1' }, pending: { provider: 'p', model: 'm2', thinking_level: 'low' } },
  );
  assert.deepEqual(parseModelSelectionState({ lastUsed: null, pending: null }), { lastUsed: null, pending: null });
  assert.equal(parseModelSelectionState(null), undefined);
  assert.equal(parseModelSelectionState({ lastUsed: { model: 'm' } }), undefined);
  assert.equal(parseModelSelectionState({ lastUsed: { provider: 'p' } }), undefined);
});

test('parseModelSelectionView reads the cached wire view {lastUsed,next}', () => {
  assert.deepEqual(
    parseModelSelectionView({ lastUsed: selection('p', 'm1'), next: selection('p', 'm2') }),
    { lastUsed: { provider: 'p', model: 'm1' }, next: { provider: 'p', model: 'm2' } },
  );
  // A cache row with only one side present still yields a usable state.
  assert.deepEqual(parseModelSelectionView({ next: selection('p', 'm2') }), { lastUsed: null, next: { provider: 'p', model: 'm2' } });
  assert.equal(parseModelSelectionView('nope'), undefined);
  assert.equal(parseModelSelectionView({}), undefined);
});

test('isBusyStatus covers running, queued and both waiting states only', () => {
  for (const status of ['running', 'queued', 'waiting_for_user', 'waiting_for_approval']) {
    assert.equal(isBusyStatus(status), true, status);
  }
  for (const status of ['idle', 'completed', 'failed', 'cancelled', '']) {
    assert.equal(isBusyStatus(status), false, status);
  }
});

test('cold fold and live request header agree on the last used model', () => {
  const events = [
    ev('request/header', requestHeader('provider-a', 'model-1')),
    ev('request/header', requestHeader('provider-b', 'model-2', 'high')),
  ];
  const state = foldModelSelection(events);
  assert.deepEqual(state.lastUsed, { provider: 'provider-b', model: 'model-2', thinking_level: 'high' });
  assert.equal(state.pending, null);
  // Same answer the effective helper would give with no default to fall back on.
  assert.deepEqual(effectiveModel({ state, default: null }).brief, state.lastUsed);
});
