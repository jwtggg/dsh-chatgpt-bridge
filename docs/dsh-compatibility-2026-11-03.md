# DSH compatibility — 2026-11-03 (DSH 0.2.1-rc.5)

## The reported failure

After the desktop app updated, DSH refused to load the published plugin:

```
dsh-chatgpt-bridge@0.6.0 is incompatible with DSH 0.2.1-rc.5
(requires @deepseek-ai/dsh-llm 0.2.0-rc.2, @deepseek-ai/dsh-agent 0.2.0-rc.2,
@deepseek-ai/dsh-agent-preset-registry 0.2.0-rc.2, @deepseek-ai/dsh-session 0.2.0-rc.2,
@deepseek-ai/dsh-session-title 0.2.0-rc.2). Running it may cause crashes or data loss.
```

## How the gate actually decides

`evaluatePluginCompatibility` lives in `@deepseek-ai/dsh-app-boot` and runs
against the plugin's `package.json` before any plugin code loads. Its rules:

1. If the manifest declares its own `engines.dsh`, that single range decides and
   **peerDependencies are ignored entirely**.
2. Otherwise every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer must satisfy
   the running runtime version, tested with `semver.satisfies(version, range,
   { includePrerelease: true })`.
3. A rejection names each unmet requirement; it is resolved either by fixing the
   manifest or by an explicit exact-version exemption in the profile's
   `compatibility.json`.

The 0.6.0 manifest pinned five peers to exactly `0.2.0-rc.2`, so the gate
rejected it on 0.2.1-rc.5. This is a stale-pin failure, not evidence that the
plugin's API usage had broken.

## Was the API actually broken?

No. Comparing the two hosts' published type surfaces for every package the
plugin imports:

- Every `.d.ts` file the plugin imports from is still present, with no renamed
  or removed export among the 18 symbols the source actually uses
  (`installModelSelection`, `agentPresetProjectionDefinition`,
  `createUserMessage`, `foldSessionTitle`, `SessionEvent`, `TurnEndReason`,
  `ApprovalOutcome`, `AskUserQuestionAnswer`, `Workspace`, ...).
- The 0.2.1 changes are additive: `LlmCallControls`, `PluginRecordMap`,
  `AgentPresetInspection`, `LlmNativeAuth`, and typert resource maps.
- One removed module, `lib/types/invariant.d.ts`, is internal to the host and
  never imported here.
- Removed host APIs (`livePresetMounts`, `standingMountFor`, `serviceForAgent`,
  `sessionPath`) are not used anywhere in `src/`.

Typechecking the whole tree against the 0.2.1-rc.5 type packages produces zero
errors.

## The range has to satisfy two different semver readers

DSH's gate includes prereleases; npm and pnpm resolve peers with default rules
that exclude them. This asymmetry has a practical consequence:

| range | DSH gate on 0.2.1-rc.5 | npm peer resolution |
| --- | --- | --- |
| `>=0.2.0-rc.2 <0.3.0` | allowed | **rejected** |
| `0.2.1-rc.5` | allowed | allowed (but breaks on the next rc) |
| `>=0.2.0-rc.2 <=0.2.1-rc.5 \|\| ^0.2.1-rc.5` | allowed | allowed |

The first row is the trap: it satisfies the gate, so the plugin loads inside the
desktop app, but `npm install` of the same tarball fails with a peer conflict
against the very host it supports. The declared window is therefore the third
row, and a unit test asserts BOTH interpretations for the accepted and rejected
versions.

## What changed

- `engines.dsh` and the five DSH peers:
  `>=0.2.0-rc.2 <=0.2.1-rc.5 || ^0.2.1-rc.5`.
- `@deepseek-ai/cordis` → `~4.0.5`, `@deepseek-ai/schemastery` → `3.18.5`.
- Dev dependencies pinned to the single verified host, `0.2.1-rc.5`.

No host file, profile, or exemption was touched: DSH's own gate accepts the
manifest, and the plugin declares exactly what it supports.

## Verification

| Check | Result |
| --- | --- |
| Typecheck + build on the 0.2.1-rc.5 graph | clean |
| Source suite | 420 tests, 417 passed, 0 failed, 3 skipped |
| Packed-tarball release gate on real `dsh@0.2.1-rc.5` | 18/18 pass |
| `dsh plugin --profile probe add <tarball>` | exit 0, no compatibility rejection |
| Control: previous exact-pin manifest, same host | rejected with the original message |

Real CLI end to end on 0.2.1-rc.5 (isolated `DSH_HOME`, no user profile or
credentials):

- the host boots with the plugin and `dsh web:` announces its URL;
- the bridge listener accepts connections and returns **401** without a token;
- `initialize` returns 200 with `serverInfo.name = dsh-chatgpt-bridge`;
- `tools/list` advertises **26** tools;
- `dsh_health` reports `bridge.version = 0.6.0`, `dsh.version = 0.2.1-rc.5`,
  `agentPresets/userQuestions/approvals/sessionPersistence/workspaceRegistry = true`.

## Two stale expectations corrected while verifying

1. `@deepseek-ai/dsh-session-persistence-jsonl` exported `JsonlSessionPersistence`
   as `default` through 0.2.0 and became a plain Cordis row
   (`apply`/`name`/`Config`) in 0.2.1. The host contract fixture accepts either
   shape. The bridge itself never imported this package.

2. The CLI test asserted `capabilities.webSurface === true`. That flag reports
   whether the OLD `apiProxy` mux mirror is attached. `@deepseek-ai/dsh-host-apiproxy`
   stopped at `0.1.1-rc.2` and has no 0.2.x release, and `dsh-api-gateway`
   exposes `typertGateway` instead — in BOTH 0.2.0-rc.2 and 0.2.1-rc.5. The
   assertion was written for 0.1.7-rc.2 and had gone stale unnoticed. It now
   asserts `false` for `webSurface` and separately asserts the capabilities that
   actually carry approvals and questions.

## Separate crash fixed

A corrupt `<dshHome>/chatgpt-bridge/runtime-config.json` used to terminate DSH
itself. `RuntimeManager.activate()` armed its poll timer and initial refresh
without a rejection handler; `ConfigStore.load()` throws on malformed JSON, the
throw became an unhandled rejection, and the host exited with
`dsh: fatal load failure`, taking every unrelated session with it. The refresh
now records and logs the failure, and auto-start stays disabled. A regression
test asserts zero `unhandledRejection` events and was confirmed to fail against
the previous behaviour.

## Boundaries of this evidence

Verified locally on Windows with Node 22.23.2 and the real
`@deepseek-ai/dsh@0.2.1-rc.5` host, in disposable directories. Not covered:

- real model execution (no credentials were used);
- ChatGPT-side connector behaviour over a public tunnel;
- the desktop Electron shell itself (the CLI host is the same DSH version but a
  different process host);
- hosts newer than 0.2.1-rc.5; the window is declared up to the verified version.
