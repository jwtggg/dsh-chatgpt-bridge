import type { Context } from '@deepseek-ai/cordis';
import { type ModelBrief, type ModelCatalogView, type ModelSource, type SessionModelView, type SetSessionModelResult } from './model-control.js';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import type { Workspace } from '@deepseek-ai/dsh-workspace';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
import { type BridgeStatus } from './status.js';
import { type MessageRow, type ToolCallInfo } from './session-view.js';
import { type ExecutionSupervisionView, type GoalStartResult, type GoalWaitResult } from './goal.js';
import { type BlockedInfo } from './goal-graph.js';
import { type GoalHistoryEvent, type GoalSupervisionView } from './goal-control.js';
import { type ExecutionMode, type GoalConstraints } from './goal-constraints.js';
import { type UserApprovalPolicy } from './approval-policy.js';
import { WorkspaceConcurrencyGuard } from './workspace-guard.js';
import { ExecutionIdempotencyManager } from './execution-idempotency.js';
import { type ResultSchema, type CredentialStatus } from './result-schema.js';
export { normalizePath } from './paths.js';
/** Typed bridge error with a stable machine-readable code. */
export declare class BridgeError extends Error {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    constructor(code: string, message: string, details?: Record<string, unknown>);
}
/** One parked approval waiting on a ChatGPT decision. */
export interface PendingApproval {
    id: string;
    sessionId: string;
    toolName: string;
    callId?: string;
    reason?: string;
    command?: string;
    capability?: string;
    level?: string;
    resolve: (outcome: ApprovalOutcome) => void;
    /** Set when the Web api-proxy parked this ask; settle via respond(). */
    muxRpcId?: string;
}
/** Who blocked or decided an approval, for deadlock diagnostics. */
export type ApprovalLayer = 'user' | 'bridge_policy' | 'dsh_policy' | 'platform';
interface ApprovalSession {
    events?: readonly {
        type: string;
        data?: unknown;
    }[];
    snapshotEvents?: () => readonly {
        type: string;
        data?: unknown;
    }[];
    header?: {
        cwd?: string;
    };
}
export interface ApprovalRequestLike {
    agent: {
        id: string;
        session?: ApprovalSession;
    };
    toolName: string;
    callId?: string;
    reason?: string;
    signal?: AbortSignal;
}
/** One parked user question waiting on a ChatGPT answer. */
export interface PendingQuestion {
    id: string;
    sessionId?: string;
    questions: AskUserQuestionItem[];
    resolve: (answer: AskUserQuestionAnswer) => void;
    muxRpcId?: string;
}
/** Wire-safe approval summary shown in dsh_get_session / dsh_get_task_status. */
export interface ApprovalSummary {
    approval_id: string;
    session_id: string;
    tool_name: string;
    call_id?: string;
    reason?: string;
}
/** Wire-safe question summary shown in dsh_get_session / dsh_get_task_status. */
export interface QuestionSummary {
    question_id: string;
    session_id?: string;
    questions: AskUserQuestionItem[];
}
export interface WaitingState {
    approvals: ApprovalSummary[];
    questions: QuestionSummary[];
}
export interface HealthReport {
    status: string;
    bridge: {
        name: string;
        version: string;
    };
    dsh: {
        version: string;
    };
    runtime: {
        pid: number;
        uptimeMs: number;
    };
    sessions: {
        live: number;
        persisted: number;
        active: number;
    };
    capabilities: {
        transports: string[];
        authMode: 'token' | 'none';
        workspaceRegistry: boolean;
        sessionPersistence: boolean;
        agentPresets: boolean;
        userQuestions: boolean;
        approvals: boolean;
        workspaces: number;
        webSurface: boolean;
        goalSupervision: boolean;
    };
}
export interface WorkspaceView {
    id: string;
    title: string;
    path: string;
    createdAt: string;
    updatedAt: string;
    sessionCount: number;
}
export interface SessionView {
    session_id: string;
    title?: string;
    workspace?: string;
    status: BridgeStatus;
    /** Effective model of this session; `null` when neither the log nor the default names one. */
    model?: ModelBrief | null;
    /** How `model` was derived: a queued selection, the last request, or the host default. */
    model_from?: ModelSource;
    created_at: string;
    updated_at?: string;
    agent?: {
        status: 'idle' | 'running';
        inbox: {
            nextTurn: number;
            nextStep: number;
        };
    };
    pending: {
        nextTurn: number;
        nextStep: number;
    };
    waiting: WaitingState;
    messages: MessageRow[];
    last_turn?: {
        turn: number;
        reason?: string;
    };
    todos?: {
        content: string;
        status: string;
    }[];
    blocked?: BlockedInfo;
    deferred_steps?: string[];
    blocked_steps?: string[];
    remaining_runnable_steps?: string[];
    goal?: GoalSupervisionView;
    execution?: ExecutionSupervisionView;
    history?: GoalHistoryEvent[];
}
export interface SessionSummary {
    session_id: string;
    title?: string;
    workspace?: string;
    status?: BridgeStatus;
    /** Effective model of this session, when the log or the host default names one. */
    model?: ModelBrief | null;
    /** How `model` was derived: a queued selection, the last request, or the host default. */
    model_from?: ModelSource;
    created_at: string;
    updated_at?: string;
}
export interface ResultView {
    session_id: string;
    status: BridgeStatus;
    turn: number;
    summary: string;
    assistant_text: string;
    changed_files: string[];
    tool_calls: ToolCallInfo[];
    error?: {
        code: string;
        message: string;
    };
    result_schema?: ResultSchema;
}
/** DSH version string, resolved lazily from the installed package. */
export declare function dshVersion(): string;
/** The bridge service. One instance per plugin activation. */
export declare class Bridge {
    private readonly ctx;
    private readonly cfg;
    private readonly log;
    /** Sessions created through this bridge (approval answering scope). */
    private readonly managed;
    private readonly approvals;
    private readonly questions;
    private questionSeq;
    private approvalsEnabled;
    private questionsEnabled;
    private started;
    private readonly goalRequests;
    private readonly goalStore;
    private readonly pollCursors;
    private apiProxy;
    private muxAbort;
    private webOwnsApprovals;
    /**
     * Consecutive dsh_wait_goal continuations per session, used by the optional
     * maxGoalWaits cap. Reset by any non-continuation result and by every new
     * goal/message, so the cap bounds ONE uninterrupted supervision chain (one
     * assistant turn) without limiting later turns.
     */
    private readonly goalWaitBudget;
    /** Agent-scoped selection refs keyed by session id, cleaned up on agent disposal. */
    private readonly managedSelections;
    readonly workspaceGuard: WorkspaceConcurrencyGuard;
    readonly idempotencyManager: ExecutionIdempotencyManager;
    private readonly workspaceBaselines;
    private readonly recordedMutationCalls;
    private readonly recordedExecutionEvidenceCalls;
    private readonly observedSuccessfulMutationCalls;
    private readonly pendingBaselineRefresh;
    private readonly pendingExecutionFingerprints;
    approvalPolicy: UserApprovalPolicy;
    /** Test hooks for bounded wait loops. */
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    constructor(ctx: Context, cfg: ResolvedBridgeConfig, log: BridgeLogger);
    /** Register the approval answerer and the user-questions provider. */
    start(): void;
    private adopt;
    /** Count of bridge-created sessions still live. */
    managedCount(): number;
    private agentOptions;
    /**
     * Agent-scoped model selection with log-derived fallback for resumes.
     *
     * `current` is read lazily on purpose: a resume replays the persisted log
     * *after* setup runs, and the first prompt assembly happens later still, so
     * reading the header eagerly would freeze a resumed session onto the profile
     * default instead of the model it actually ran on. A value the bridge set via
     * `setSessionModel` is remembered and always wins.
     */
    private installSelection;
    /**
     * Resolve the profile's live LLM registry into the catalog ChatGPT selects
     * from. Read-only: it never requests credentials and never returns an API key,
     * token or endpoint secret — only ids, display names and declared capabilities.
     */
    listModels(): Promise<ModelCatalogView>;
    /** The selection ref the bridge owns for one live agent, when it installed one. */
    private selectionFor;
    /**
     * Model-selection state of one session. The log fold is the durable truth for
     * both live and cold sessions; a bridge-owned ref that has moved ahead of the
     * log is what DSH will actually assemble the next request from, so it wins.
     */
    private modelStateOf;
    private defaultModelBrief;
    /**
     * Read the model one specified session runs on. Read-only: it reports the
     * effective model, where it came from, and what the most recent request
     * actually used, so a caller can tell "will use" from "already used".
     */
    getSessionModel(sessionId: string): Promise<SessionModelView>;
    /**
     * Change the model of ONE specified session. Never creates a new conversation,
     * never migrates history, never touches the global default, never sends a
     * message and never cancels or restarts a running turn: the selection is
     * recorded in the session log through DSH's own `model/selection` event and
     * applied by DSH at the next prompt assembly of that same session.
     */
    setSessionModel(input: {
        session_id: string;
        model_id: string;
        provider_id?: string;
        thinking_level?: string;
    }): Promise<SetSessionModelResult>;
    /** Compose the preset+selection setup used at agent creation/resume. */
    private composeSetupFor;
    private loadView;
    /** Resolve a live agent, resuming the persisted session when needed. */
    private ensureAgent;
    listWorkspaces(): Promise<WorkspaceView[]>;
    /**
     * Resolve a workspace reference (id, canonical path, or title) against the
     * REGISTERED workspace set only. Never auto-registers and never opens an
     * arbitrary path: an unregistered path is rejected.
     */
    resolveWorkspace(input: string): Promise<Workspace>;
    health(): Promise<HealthReport>;
    createSession(workspaceInput: string, title?: string, initialMessage?: string): Promise<SessionView>;
    sendMessage(sessionId: string, message: string): Promise<{
        session_id: string;
        accepted: boolean;
    }>;
    cancelTask(sessionId: string): Promise<{
        session_id: string;
        cancelled: boolean;
    }>;
    private waitingFor;
    private statusOf;
    private titleOf;
    private viewOf;
    getSession(sessionId: string, maxItems?: number, maxChars?: number): Promise<SessionView>;
    listSessions(options: {
        limit?: number;
        offset?: number;
        workspace?: string;
    }): Promise<SessionSummary[]>;
    /**
     * Zero-I/O effective model for a cold session, read from the persisted
     * projection cache when it is mounted. Never reads the log: this is a listing
     * hint that a later `dsh_get_session_model` read supersedes.
     */
    private cachedModel;
    /** Zero-I/O cached title for a cold session, when a projection cache is mounted. */
    private cachedTitle;
    getResult(sessionId: string, maxChars?: number): Promise<ResultView>;
    getTaskStatus(sessionId: string): Promise<{
        session_id: string;
        status: BridgeStatus;
        live: boolean;
        agent_status?: 'idle' | 'running';
        pending: {
            nextTurn: number;
            nextStep: number;
        };
        waiting: WaitingState;
        last_turn?: {
            turn: number;
            reason?: string;
        };
        updated_at?: string;
        todos?: {
            content: string;
            status: string;
        }[];
        blocked?: BlockedInfo;
        deferred_steps?: string[];
        blocked_steps?: string[];
        remaining_runnable_steps?: string[];
        goal?: GoalSupervisionView;
        execution?: ExecutionSupervisionView;
        history?: GoalHistoryEvent[];
    }>;
    createGoal(input: {
        workspace: string;
        goal: string;
        plan?: string;
        execution_mode?: ExecutionMode;
        constraints?: GoalConstraints;
        request_id?: string;
        workspace_lock_override?: boolean;
    }): Promise<GoalStartResult>;
    reviseGoal(input: {
        session_id: string;
        goal?: string;
        plan?: string;
        execution_mode?: ExecutionMode;
        constraints?: GoalConstraints;
        expected_revision?: number;
        revision_reason?: string;
        request_id?: string;
        workspace_lock_override?: boolean;
    }): Promise<GoalStartResult>;
    pauseGoal(sessionId: string): Promise<{
        session_id: string;
        status: BridgeStatus;
        paused: boolean;
        checkpoint_revision: number;
    }>;
    resumeGoal(sessionId: string, resumeSteps?: string[], requestId?: string, workspaceLockOverride?: boolean): Promise<GoalStartResult>;
    retryStep(sessionId: string, stepId: string, requestId?: string, workspaceLockOverride?: boolean): Promise<GoalStartResult>;
    rerunStep(sessionId: string, stepId: string, requestId?: string, workspaceLockOverride?: boolean): Promise<GoalStartResult>;
    waitUntilActionRequired(sessionId: string, waitSeconds?: number): Promise<GoalWaitResult>;
    getStructuredResult(sessionId: string): Promise<ResultSchema>;
    getCredentialStatus(): CredentialStatus[];
    startGoal(input: {
        workspace: string;
        goal: string;
        plan?: string;
        session_id?: string;
        request_id?: string;
        execution_mode?: ExecutionMode;
        constraints?: GoalConstraints;
        expected_revision?: number;
        workspace_lock_override?: boolean;
    }): Promise<GoalStartResult>;
    updateGoal(input: {
        session_id: string;
        action?: 'revise' | 'defer' | 'resume';
        goal?: string;
        plan?: string;
        execution_mode?: ExecutionMode;
        constraints?: GoalConstraints;
        expected_revision?: number;
        defer_steps?: string[];
        resume_steps?: string[];
        revision_reason?: string;
        request_id?: string;
        workspace?: string;
        workspace_lock_override?: boolean;
    }): Promise<GoalStartResult>;
    waitGoal(sessionId: string, waitSeconds?: number): Promise<GoalWaitResult>;
    /**
     * Enforce the optional maxGoalWaits cap. A supervised goal keeps returning
     * continuation_required=true, which makes ChatGPT call dsh_wait_goal again in
     * the SAME assistant turn; on a connector with a hard per-turn time limit
     * that loop is what eventually drops the conversation. When the cap is
     * reached this returns continuation_required=false plus an explicit
     * next_action telling the model to end the turn and report progress, so the
     * user can say "continue" for the next bounded batch.
     */
    private applyGoalWaitBudget;
    stopGoal(sessionId: string): Promise<{
        session_id: string;
        stopped: true;
        already_stopped: boolean;
        status: BridgeStatus;
        cleanup_warning?: string;
    }>;
    private failClosedWaiting;
    private applyStartOrRevise;
    private controlMessage;
    private mapGoalStart;
    private noteGoalEvent;
    /**
     * Decide a DSH approval/request for a managed session.
     * Idempotent high-cost steps are skipped; L0/L1 may auto-approve;
     * deny/reject always remain reachable even if approve is blocked.
     */
    decideApproval(request: ApprovalRequestLike, next?: () => Promise<ApprovalOutcome> | ApprovalOutcome): Promise<ApprovalOutcome>;
    private rejectConstraint;
    private observeGoal;
    private goalFields;
    private cleanupGoalTemps;
    private goalSnapshot;
    answerQuestion(questionId: string, sessionId: string | undefined, answer: {
        selected: string[];
        custom?: string;
    }): Promise<{
        answered: true;
    }>;
    approve(sessionId: string, approvalId: string, decision: 'approve' | 'reject'): Promise<{
        approval_id: string;
        session_id: string;
        decision: 'approve' | 'reject';
        outcome: ApprovalOutcome;
        layer: ApprovalLayer;
        fail_closed?: boolean;
    }>;
    private isLockHolderActive;
    private workspaceLockedError;
    private assertMutableWorkspaceAvailable;
    private takeWorkspaceLock;
    private releaseWorkspaceIfTerminal;
    private skipIdempotentStep;
    private recordObservedExecutions;
    private recordObservedExecutionFacts;
    private executionFingerprintExtra;
    private refreshWorkspaceBaselineIfNeeded;
    private noteMutation;
    private rememberMutationCall;
    private rememberExecutionEvidenceCall;
    private rememberObservedSuccessfulMutationCall;
    private rememberPendingExecutionFingerprint;
    listManaged(): string[];
}
