# Model control tools — 2026-10-15 working tree

Adds per-session model inspection and switching to the bridge:

- `dsh_list_models` — the profile's live provider/model catalog with availability,
  thinking levels and switch support. Read from `ctx.llm`; nothing is hardcoded
  and no credential, key or endpoint secret is returned.
- `dsh_get_session_model` — for one named session: the model its next request will
  use, where that choice came from (queued selection / last request / host
  default), the model its most recent request actually used, whether the session
  is live or running, and whether a switch is supported.
- `dsh_set_session_model` — switch one named session in place. The conversation,
  its id, its history, its workspace and its Goal state are preserved; no message
  is sent and no running turn is cancelled or restarted. `dsh_get_session` and
  `dsh_list_sessions` carry a brief `model`/`model_from` too.

The working tree still targets exactly DSH **0.2.0-rc.2** and the package version
is still 0.6.0; nothing was published.

## Why a switch cannot fake itself

The bridge only drives DSH's own model-selection seam. On one live agent that is
`installModelSelection` (`@deepseek-ai/dsh-agent`), which the bridge installs from
its own composition setup; the durable record is one native `model/selection`
event appended to that session's own log. Nothing is re-created: no second
session, no migrated history, no rewritten id, and `agentDefaultModel` (the
profile-wide default) is never written — DSH's own `selectModel` command does
write it, which is exactly why the bridge does not reuse that command.

Consequences that the tools report instead of hiding:

- A saved selection reaches the wire at the **next** prompt assembly of that
  session. Until then the read shows the new model under `pending` and the old
  one under `last_request`; `dsh_set_session_model` returns `accepted`, `saved`
  and the effective state separately, plus `verified.pending_matches` and
  `verified.last_request_unchanged`.
- A live session whose selection the bridge does not own (for example one started
  in the DSH Web UI) is refused with `MODEL_SWITCH_UNSUPPORTED`. The bridge does
  not replace another entry point's in-memory selection, and it does not create a
  new session to pretend otherwise.
- A cold session is resumed under the **same** id to record the choice durably;
  the result says `resumed: true`.
- Failures never fall back to another model: an unavailable provider/model fails
  with `INVALID_PROVIDER` / `INVALID_MODEL`, and an unsupported level fails with
  `UNSUPPORTED_REASONING_EFFORT` naming the levels that would work.

## Verification

- `npm run typecheck`, `npm run build` — pass.
- `npm test` (unit, single process) — **413 tests, 410 passed, 0 failed,
  3 skipped**: one POSIX-permission case and two cross-process spawn cases the
  sandbox blocks.
- `test/unit/model-control.test.mjs` — 12 pure-logic cases over the event fold,
  effective-model precedence, parsing and busy-status classification.
- `test/integration/model-switch.test.mjs` — 15 cases on a real Cordis host with
  the real session log, the real projection registry, the real LLM registry and
  the real native `model/selection` seam: catalog, read, in-place switch,
  the `agent/request` waterfall actually routing to the new model, cold read,
  id/workspace/history preservation event by event, thinking-level apply and
  reject, `INVALID_PROVIDER` / `INVALID_MODEL` / `SESSION_NOT_FOUND`, session
  isolation, untouched global default, refusal of a non-owned live session,
  running-session honesty, restart durability across a fresh host and bridge,
  and the three tools exercised over a real MCP client/server wire.
- `test/integration/dsh-cli.test.mjs` — starts the actual official Web CLI in a
  disposable `DSH_HOME` with a real no-network LLM adapter registration, then
  walks MCP → bridge → DSH → durable log → read-back for the new tools next to
  the existing ones.
- `npm run test:release` — packs the tarball, installs it with
  `@deepseek-ai/dsh@0.2.0-rc.2` into a disposable root and runs the integration
  files against the installed package: pass.

These tests use synthetic sessions and stub adapters. They prove the bridge's
own contract and DSH's native seam, not a real model call, a real credential or
ChatGPT connectivity. Switching a session that a different DSH entry point owns
still has to happen in that entry point.

## Installing this working tree

`lib/` was rebuilt and, on 2026-10-15, the `desktop` profile's copy at
`$DSH_HOME/profiles/desktop/node_modules/dsh-chatgpt-bridge` was replaced with it
(all 79 files byte-identical to this build; the previous copy is in
`$DSH_HOME/backups/`). The running bridge was **not** restarted, so it still
serves the old 23-tool list — plugin `lib/` has no hot reload. A DSH restart plus
an MCP tool-list refresh on the ChatGPT side is what makes the 26 tools visible.

Two things to know before installing again:

- The profile pins this plugin by GitHub commit, so a normal plugin
  install/refresh of that profile restores the upstream commit and silently
  reverts these files. Point the dependency at this checkout or at the packed
  tarball for a durable install.
- The build is safe to boot: it adds no new bare import specifier over the
  previous build (23 before, 23 after), and `lib/model-control.js` has no bare
  imports at all. `npm run test:release` installs the packed tarball beside
  `@deepseek-ai/dsh@0.2.0-rc.2` in a disposable root and passes 17/17.
