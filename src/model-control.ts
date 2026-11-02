/**
 * Model control: read and change the model one DSH session runs on.
 *
 * DSH owns this state. The bridge only drives the native seams:
 *   - `session.append('model/selection', …)` records the choice in the session
 *     log — the same event the DSH web and ACP clients write — and
 *   - the agent-scoped selection ref installed by `installModelSelection`
 *     makes the next request use it.
 *
 * Nothing here recreates a session, migrates history, or touches the global
 * default model. The fold helpers are pure so the live-agent path and the
 * cold (persisted-only) path derive the same answer.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
// Side-effect type import: the projection key tables live in this subpath, so
// the augmentation below needs it in scope before TypeScript resolves the name.
import type {} from '@deepseek-ai/dsh-session-projection/types';

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete validated model selection requested for subsequent prompt
     * assembly. Log-only: it never enters derived model history.
     */
    'model/selection': ModelSelection;
  }
}

/** Host state of DSH's own `modelSelection` projection. */
export interface ModelSelectionProjectionState {
  lastUsed: ModelSelection | null;
  pending: ModelSelection | null;
}

/** Client-visible view of the same projection, as DSH serves it. */
export interface ModelSelectionProjection {
  lastUsed: ModelSelection | null;
  next: ModelSelection | null;
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    modelSelection: ModelSelectionProjectionState;
  }
  interface SessionProjectionMap {
    modelSelection: ModelSelectionProjection;
  }
}

/** The agent-scoped selection ref the bridge installs at create/resume. */
export interface BridgeSelectionRef {
  current: ModelSelection;
  assembled: ModelSelection | undefined;
}

/** Model identity as the bridge reports it to MCP clients. */
export interface ModelBrief {
  provider: string;
  model: string;
  thinking_level?: string;
}

/** One selectable model, resolved from the profile's live provider catalog. */
export interface ModelEntry {
  provider_id: string;
  model_id: string;
  model_name: string;
  description?: string;
  /** `resolveModelInfo` succeeded, so DSH can actually call this model. */
  available: boolean;
  /** DSH applies a new selection at the next request, in the same session. */
  switch_supported: boolean;
  /** Absent when the model declares no reasoning-effort options. */
  thinking_levels?: { id: string; name: string; description?: string }[];
  default_thinking_level?: string;
  context_window?: number;
  unavailable_reason?: string;
}

export interface ModelProviderGroup {
  provider_id: string;
  provider_name: string;
  models: ModelEntry[];
}

export interface ModelCatalogView {
  /** Global default used by sessions that never selected a model. */
  default: ModelBrief;
  providers: ModelProviderGroup[];
  failures: { provider_id: string; provider_name: string; message: string }[];
  model_count: number;
  switch_support: {
    same_session: boolean;
    cross_provider: boolean;
    effective: 'next_request';
    note: string;
  };
}

/** How the effective model of a session was derived. */
export type ModelSource = 'pending' | 'last_request' | 'default';

/**
 * Effective view of one session's model state. `state` comes from DSH's own
 * projection when mounted (or from a fold of the session log otherwise);
 * `default` is the host-wide default selection used only when the session has
 * selected nothing.
 */
export interface EffectiveModelInput {
  state: ModelSelectionState;
  default: ModelBrief | null;
}

/**
 * Derive the effective model — what the next request of this session will use.
 * A queued pending selection wins; otherwise the model the most recent request
 * actually used; otherwise the host default. Pure, so every read path (live
 * projection, folded log, cold cache) answers the same way.
 */
export function effectiveModel(
  input: EffectiveModelInput,
): { brief: ModelBrief | null; source: ModelSource } {
  if (input.state.pending !== null) return { brief: input.state.pending, source: 'pending' };
  if (input.state.lastUsed !== null) return { brief: input.state.lastUsed, source: 'last_request' };
  return { brief: input.default, source: 'default' };
}

export interface SessionModelView {
  session_id: string;
  /** Effective model: what the next request of this session will use. */
  provider: string;
  model: string;
  thinking_level?: string;
  effective_from: ModelSource;
  /** Model the most recent request actually used. */
  last_request: ModelBrief | null;
  /** Selection queued for the next request, not used yet. */
  pending: ModelBrief | null;
  live: boolean;
  running: boolean;
  status: string;
  /** Whether the bridge installed and owns this live agent's selection ref. */
  managed: boolean;
  switch_supported: boolean;
  switch_blocked_reason?: string;
  /**
   * When a saved selection actually reaches the wire: next_request for a
   * bridge-managed agent (or after any resume), next_resume when a
   * non-bridge-managed live agent holds its own selection instance — the log
   * event is durable either way, this never fakes an immediate effect.
   */
  switch_effective: 'next_request' | 'next_resume';
  note?: string;
}

export interface SetSessionModelResult {
  session_id: string;
  accepted: true;
  /** The selection event is in the session log. */
  saved: boolean;
  saved_seq?: number;
  persistence: 'flushed' | 'not-mounted' | 'flush-failed';
  /** When the saved selection reaches the wire; see SessionModelView.switch_effective. */
  effective: 'next_request' | 'next_resume';
  selected: ModelBrief;
  before: { provider: string; model: string; thinking_level?: string; pending: ModelBrief | null };
  after: { provider: string; model: string; thinking_level?: string; pending: ModelBrief | null };
  verified: { pending_matches: boolean; last_request_unchanged: boolean };
  resumed: boolean;
  message: string;
}

/** Bridge-vocabulary model-selection state. */
export interface ModelSelectionState {
  lastUsed: ModelBrief | null;
  pending: ModelBrief | null;
}

export function initModelSelectionState(): ModelSelectionState {
  return { lastUsed: null, pending: null };
}

/** Convert any DSH selection shape into the bridge's wire shape. */
export function modelBrief(
  selection: { provider: string; model: string; reasoningEffort?: unknown } | null | undefined,
): ModelBrief | undefined {
  if (selection === null || selection === undefined) return undefined;
  const effort = selection.reasoningEffort;
  return {
    provider: selection.provider,
    model: selection.model,
    ...(typeof effort === 'string' && effort !== '' ? { thinking_level: effort } : {}),
  };
}

export function sameModelBrief(
  left: ModelBrief | null | undefined,
  right: ModelBrief | null | undefined,
): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.thinking_level === right.thinking_level
  );
}

/**
 * Fold one session event into the model-selection state. Mirrors DSH's own
 * `applyModelSelectionProjection`: `model/selection` queues a pending value and
 * `request/header` records what was actually used, clearing a pending value
 * that has caught up.
 */
export function applyModelSelectionEvent(
  state: ModelSelectionState,
  event: SessionEvent,
): ModelSelectionState {
  if (event.type === 'model/selection') {
    const next = modelBrief(event.data);
    if (next === undefined) return state;
    if (sameModelBrief(state.pending, next)) return state;
    return { lastUsed: state.lastUsed, pending: next };
  }
  if (event.type === 'request/header') {
    const lastUsed = modelBrief(event.data.header.config);
    if (lastUsed === undefined) return state;
    return { lastUsed, pending: sameModelBrief(state.pending, lastUsed) ? null : state.pending };
  }
  return state;
}

/** Fold a whole (possibly persisted) event log into the model-selection state. */
export function foldModelSelection(events: readonly SessionEvent[]): ModelSelectionState {
  let state = initModelSelectionState();
  for (const event of events) state = applyModelSelectionEvent(state, event);
  return state;
}

function parseBrief(value: unknown): ModelBrief | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  const model = record.model;
  if (typeof provider !== 'string' || provider === '') return undefined;
  if (typeof model !== 'string' || model === '') return undefined;
  const effort = record.reasoningEffort;
  return {
    provider,
    model,
    ...(typeof effort === 'string' && effort !== '' ? { thinking_level: effort } : {}),
  };
}

/**
 * Parse DSH's `modelSelection` projection state (`{lastUsed, pending}`) as it
 * arrives from the projection registry, tolerating an unregistered projection.
 */
export function parseModelSelectionState(value: unknown): ModelSelectionState | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  // An explicit null is a real "nothing selected yet", not a malformed row: only
  // a present non-null value that fails to parse makes the whole state unusable.
  const hasLast = 'lastUsed' in record;
  const hasPending = 'pending' in record;
  if (!hasLast && !hasPending) return undefined;
  const lastUsed = parseBrief(record.lastUsed);
  const pending = parseBrief(record.pending);
  if (hasLast && record.lastUsed !== null && lastUsed === undefined) return undefined;
  if (hasPending && record.pending !== null && pending === undefined) return undefined;
  return { lastUsed: lastUsed ?? null, pending: pending ?? null };
}

/**
 * Parse the client-visible `modelSelection` projection view (`{lastUsed, next}`)
 * as the zero-I/O projection cache serves it.
 */
export function parseModelSelectionView(
  value: unknown,
): { lastUsed: ModelBrief | null; next: ModelBrief | null } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const hasLast = 'lastUsed' in record;
  const hasNext = 'next' in record;
  if (!hasLast && !hasNext) return undefined;
  const lastUsed = parseBrief(record.lastUsed);
  const next = parseBrief(record.next);
  if (hasLast && record.lastUsed !== null && lastUsed === undefined) return undefined;
  if (hasNext && record.next !== null && next === undefined) return undefined;
  return { lastUsed: lastUsed ?? null, next: next ?? null };
}

/** Statuses where a turn is in flight or parked. */
export function isBusyStatus(status: string): boolean {
  return (
    status === 'running' ||
    status === 'queued' ||
    status === 'waiting_for_user' ||
    status === 'waiting_for_approval'
  );
}
