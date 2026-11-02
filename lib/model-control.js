/**
 * Derive the effective model — what the next request of this session will use.
 * A queued pending selection wins; otherwise the model the most recent request
 * actually used; otherwise the host default. Pure, so every read path (live
 * projection, folded log, cold cache) answers the same way.
 */
export function effectiveModel(input) {
    if (input.state.pending !== null)
        return { brief: input.state.pending, source: 'pending' };
    if (input.state.lastUsed !== null)
        return { brief: input.state.lastUsed, source: 'last_request' };
    return { brief: input.default, source: 'default' };
}
export function initModelSelectionState() {
    return { lastUsed: null, pending: null };
}
/** Convert any DSH selection shape into the bridge's wire shape. */
export function modelBrief(selection) {
    if (selection === null || selection === undefined)
        return undefined;
    const effort = selection.reasoningEffort;
    return {
        provider: selection.provider,
        model: selection.model,
        ...(typeof effort === 'string' && effort !== '' ? { thinking_level: effort } : {}),
    };
}
export function sameModelBrief(left, right) {
    if (left === null || left === undefined)
        return right === null || right === undefined;
    if (right === null || right === undefined)
        return false;
    return (left.provider === right.provider &&
        left.model === right.model &&
        left.thinking_level === right.thinking_level);
}
/**
 * Fold one session event into the model-selection state. Mirrors DSH's own
 * `applyModelSelectionProjection`: `model/selection` queues a pending value and
 * `request/header` records what was actually used, clearing a pending value
 * that has caught up.
 */
export function applyModelSelectionEvent(state, event) {
    if (event.type === 'model/selection') {
        const next = modelBrief(event.data);
        if (next === undefined)
            return state;
        if (sameModelBrief(state.pending, next))
            return state;
        return { lastUsed: state.lastUsed, pending: next };
    }
    if (event.type === 'request/header') {
        const lastUsed = modelBrief(event.data.header.config);
        if (lastUsed === undefined)
            return state;
        return { lastUsed, pending: sameModelBrief(state.pending, lastUsed) ? null : state.pending };
    }
    return state;
}
/** Fold a whole (possibly persisted) event log into the model-selection state. */
export function foldModelSelection(events) {
    let state = initModelSelectionState();
    for (const event of events)
        state = applyModelSelectionEvent(state, event);
    return state;
}
function parseBrief(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const record = value;
    const provider = record.provider;
    const model = record.model;
    if (typeof provider !== 'string' || provider === '')
        return undefined;
    if (typeof model !== 'string' || model === '')
        return undefined;
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
export function parseModelSelectionState(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const record = value;
    // An explicit null is a real "nothing selected yet", not a malformed row: only
    // a present non-null value that fails to parse makes the whole state unusable.
    const hasLast = 'lastUsed' in record;
    const hasPending = 'pending' in record;
    if (!hasLast && !hasPending)
        return undefined;
    const lastUsed = parseBrief(record.lastUsed);
    const pending = parseBrief(record.pending);
    if (hasLast && record.lastUsed !== null && lastUsed === undefined)
        return undefined;
    if (hasPending && record.pending !== null && pending === undefined)
        return undefined;
    return { lastUsed: lastUsed ?? null, pending: pending ?? null };
}
/**
 * Parse the client-visible `modelSelection` projection view (`{lastUsed, next}`)
 * as the zero-I/O projection cache serves it.
 */
export function parseModelSelectionView(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const record = value;
    const hasLast = 'lastUsed' in record;
    const hasNext = 'next' in record;
    if (!hasLast && !hasNext)
        return undefined;
    const lastUsed = parseBrief(record.lastUsed);
    const next = parseBrief(record.next);
    if (hasLast && record.lastUsed !== null && lastUsed === undefined)
        return undefined;
    if (hasNext && record.next !== null && next === undefined)
        return undefined;
    return { lastUsed: lastUsed ?? null, next: next ?? null };
}
/** Statuses where a turn is in flight or parked. */
export function isBusyStatus(status) {
    return (status === 'running' ||
        status === 'queued' ||
        status === 'waiting_for_user' ||
        status === 'waiting_for_approval');
}
