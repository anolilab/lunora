import type { FlexibleSchema, LanguageModel, ModelMessage, StopCondition, TelemetryOptions, ToolChoice, ToolSet } from "ai";

/**
 * Structural mirror of the Lunora function reference (`{ __lunoraRef }`).
 * Declared locally so the loop can mint references to the agent runtime
 * functions by path without importing `@lunora/dispatch`.
 */
export interface AgentFunctionReference {
    __lunoraRef: string;
}

/** `ctx.run`-shaped dispatcher the loop uses to call Lunora functions. */
export type AgentRunFunction = (reference: AgentFunctionReference, args?: Record<string, unknown>) => Promise<unknown>;

/** Structural subset of the Cloudflare Workflows durable-step API the loop needs. */
export interface AgentStepLike {
    do: <T>(name: string, callback: () => Promise<T>) => Promise<T>;

    /**
     * Durably hibernate until an external event of `type` arrives, then return
     * its payload. Used for human-in-the-loop approvals: a run pauses on
     * `approval:&lt;toolCallId>` until a client resolves it. Like `do`, a resolved
     * wait is memoized — a replay returns the recorded decision without pausing
     * again. Signature mirrors `@lunora/workflow`'s `WorkflowStepLike`.
     */
    waitForEvent: <T = unknown>(name: string, options: { timeout?: number | string; type: string }) => Promise<{ payload: Readonly<T>; type: string }>;
}

/**
 * The context handed to an agent tool's `execute`. Beyond the model-provided
 * input, a tool sees who it runs for (`threadKey`), how to call back into the
 * app (`run` — dispatches Lunora queries/mutations/actions), and its
 * `idempotencyKey`.
 *
 * The `idempotencyKey` is the deterministic durable-step name
 * (`tool:&lt;name>:&lt;toolCallId>`). A COMPLETED tool step is never re-run on a
 * workflow replay (native step memoization) — but a step that FAILS mid-body
 * is retried at-least-once, so a side-effecting tool (charge a card, send a
 * mail) must dedupe on this key itself.
 */
export interface AgentToolContext {
    /** The Worker environment bindings. */
    env: Record<string, unknown>;
    /** Deterministic idempotency key — the tool's durable-step name. */
    idempotencyKey: string;
    /** Dispatch a Lunora function (the workflow `ctx.run`). */
    run: AgentRunFunction;
    /** The thread this tool call belongs to. */
    threadKey: string;
    /** The provider-issued tool-call id. */
    toolCallId: string;
}

/**
 * An agent tool. Unlike a raw AI SDK tool, `execute` is NOT handed to the
 * model call — the loop runs it itself inside a named durable step so a
 * completed call never re-runs on replay, and passes the
 * {@link AgentToolContext} alongside the input.
 */
export interface AgentToolDefinition<Input = unknown, Output = unknown> {
    /** What the tool does — shown to the model. */
    description: string;
    /** Run the tool. The returned value is persisted as the tool message content. */
    execute: (input: Input, context: AgentToolContext) => Promise<Output> | Output;
    /** The input schema shown to the model (a zod schema or `jsonSchema(...)`). */
    inputSchema: FlexibleSchema<Input>;
    /** Runtime brand. */
    isLunoraAgentTool: true;

    /**
     * Gate the tool behind a human approval (mirrors the AI SDK's
     * `needsApproval`). When it resolves truthy the durable run PAUSES — the
     * thread moves to `"awaiting_input"` and the workflow hibernates on
     * `approval:&lt;toolCallId>` — until a client calls `agents:agentResolveApproval`.
     * On approve the tool runs exactly as normal; on reject it is skipped and a
     * tool result explaining the rejection is persisted so the next turn recovers.
     * A boolean gates statically; a function gates per input. Default: `false`
     * (unchanged behavior). Evaluated from replay-stable input, so keep it
     * deterministic (no `Date.now()`/`Math.random()`).
     */
    needsApproval?: ((input: Input, context: AgentToolContext) => boolean | Promise<boolean>) | boolean;
}

/** Author-supplied tool config (see {@link AgentToolDefinition}). */
export type AgentToolConfig<Input = unknown, Output = unknown> = Omit<AgentToolDefinition<Input, Output>, "isLunoraAgentTool">;

/**
 * Generic-erased tool for tool maps. `Input` sits in both a covariant
 * (`inputSchema`) and a contravariant (`execute`) position, so no single
 * non-`any` instantiation admits every concrete tool — the same reason the AI
 * SDK's `ToolSet` erases its generics.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance escape hatch, see above
export type AnyAgentTool = AgentToolDefinition<any, any>;

/**
 * The model an agent runs on: a Workers AI model id (resolved via `env.AI`),
 * a prebuilt AI SDK {@link LanguageModel}, or a thunk building one from the
 * Worker env (for providers that need API keys off `env`).
 */
export type AgentModelInput = LanguageModel | ((env: Record<string, unknown>) => LanguageModel);

/**
 * Memory wiring: the path (or reference) of an app **action** taking
 * `{ query: string }` and returning `@lunora/ai/rag`'s `RetrieveResult`
 * (`{ context, chunks, sources }`) — typically three lines over
 * `defineRag(...)(ctx).retrieve`. The loop runs it as a durable step at turn
 * start and injects `.context` as a system message. Dispatching to a real
 * action (instead of embedding vector plumbing here) keeps retrieval inside a
 * fully wired ctx: codegen-resolved vector bindings, RLS, observability.
 */
export interface AgentMemoryOptions {
    /** The memory action: a function path (`"rag:searchDocs"`) or reference. */
    source: AgentFunctionReference | string;
    /** Retrieval depth forwarded to the action as `topK`. */
    topK?: number;
}

/** Cumulative or per-turn token usage — AI SDK `LanguageModelUsage` field names. */
export interface AgentUsage {
    /** Prompt (input) tokens. */
    inputTokens?: number;
    /** Completion (output) tokens. */
    outputTokens?: number;
    /** Input + output tokens. */
    totalTokens?: number;
}

/** Context handed to a dynamic {@link AgentConfig.instructions} function. */
export interface AgentInstructionsContext {
    /** The Worker environment bindings. */
    env: Record<string, unknown>;
    /** The user message that started this run. */
    input: string;
    /** The thread this run belongs to. */
    threadKey: string;
}

/** One prior turn, as {@link AgentConfig.prepareStep} and `stopWhen` observe it. */
export interface AgentStepInfo {
    /** The assistant text of the turn. */
    text: string;
    /** The tool calls the turn issued (AI SDK `StepResult.toolCalls` shape). */
    toolCalls: ReadonlyArray<{ input: unknown; toolCallId: string; toolName: string }>;
    /** The turn's token usage, when the model reported it. */
    usage?: AgentUsage;
}

/** The turn summary handed to {@link AgentConfig.onStepFinish}. */
export interface AgentStepFinishInfo {
    /** The assistant text produced this turn. */
    text: string;
    /** The tool calls issued this turn (empty on the final answer). */
    toolCalls: ReadonlyArray<AgentToolCall>;
    /** The zero-based turn index. */
    turn: number;
    /** The turn's token usage, when the model reported it. */
    usage?: AgentUsage;
}

/**
 * Called after each LLM turn with that turn's text, tool calls, and usage. Runs
 * inside a named durable step (`agent:step-finish:&lt;turn>`) so it fires exactly
 * once per turn even across a workflow replay.
 */
export type AgentOnStepFinish = (info: AgentStepFinishInfo) => Promise<void> | void;

/** The input {@link AgentConfig.prepareStep} sees before a turn runs. */
export interface AgentPrepareStepInput {
    /** The messages assembled for this turn (instructions + memory + history). */
    messages: ReadonlyArray<ModelMessage>;
    /** The zero-based index of the turn about to run. */
    stepNumber: number;
    /** The turns already completed this run. */
    steps: ReadonlyArray<AgentStepInfo>;
}

/**
 * Per-turn overrides {@link AgentConfig.prepareStep} may return. A returned
 * `messages` array **replaces** the assembled history for that turn — the seam
 * where history compaction lives.
 */
export interface AgentPrepareStepResult {
    /** Restrict the tools exposed to the model this turn (by name). */
    activeTools?: ReadonlyArray<string>;
    /** Replace the assembled messages for this turn (history compaction). */
    messages?: ReadonlyArray<ModelMessage>;
    /** Swap the model for this turn. */
    model?: AgentModelInput;
    /** Prepend a system message for this turn. */
    system?: string;
    /** Override the tool-choice strategy for this turn. */
    toolChoice?: ToolChoice<ToolSet>;
}

/**
 * Adjust the next turn before it runs — mirrors AI SDK's `prepareStep`. Invoked
 * inside the turn's durable step so its effect is memoized on replay.
 */
export type AgentPrepareStep = (input: AgentPrepareStepInput) => AgentPrepareStepResult | Promise<AgentPrepareStepResult | undefined> | undefined;

export interface AgentConfig {
    /** Restrict the tools the model may call, by name. Default: all tools. */
    activeTools?: ReadonlyArray<string>;

    /**
     * System prompt prepended to every model call — a static string or a thunk
     * derived from the run context (dynamic instructions).
     */
    instructions?: string | ((context: AgentInstructionsContext) => string);
    /** Cap the tokens generated per turn (AI SDK `maxOutputTokens`). */
    maxOutputTokens?: number;

    /**
     * Cost/step cap: maximum LLM turns per run. Default 8. Composes with
     * {@link AgentConfig.stopWhen} — the loop ends when EITHER triggers.
     */
    maxTurns?: number;
    /** Retrieval-augmented memory — see {@link AgentMemoryOptions}. */
    memory?: AgentMemoryOptions;
    /** The model — see {@link AgentModelInput}. */
    model: AgentModelInput;

    /**
     * Optional override for the deployed workflow name (`wrangler.jsonc`
     * `workflows[].name`). Defaults to `agent-&lt;kebab-cased export name>`. Does
     * NOT change the binding name, which is always derived from the export
     * name (`support` → `AGENT_SUPPORT`).
     */
    name?: string;

    /**
     * Policy when a run starts on a thread that already has a DIFFERENT run in
     * flight (the thread's `status` is `"running"` under another workflow
     * instance) — the guard that stops two runs from interleaving messages on
     * the shared per-thread seq counter:
     *
     * - `"reject"` (default) — fail the new run fast with a `CONFLICT` error.
     * - `"replace"` — terminate the in-flight instance and take the thread over.
     * - `"queue"` — reserved for a future durable queue; currently degrades to `"reject"` (no queue exists yet), tracked as a follow-up.
     *
     * A workflow REPLAY re-enters the bootstrap under the SAME instance id and
     * is never a concurrent run (the guard compares the stored instance id).
     */
    onConcurrentRun?: "queue" | "reject" | "replace";
    /** Called after each LLM turn — see {@link AgentOnStepFinish}. */
    onStepFinish?: AgentOnStepFinish;

    /**
     * Structured final answer: a zod schema or `jsonSchema(...)`. When set the
     * loop runs the model with AI SDK `Output.object({ schema })` and returns
     * the parsed object in {@link AgentRunResult.output}.
     */
    output?: FlexibleSchema<unknown>;
    /** Adjust the next turn before it runs — see {@link AgentPrepareStep}. */
    prepareStep?: AgentPrepareStep;

    /**
     * Extra loop-stop conditions (AI SDK `StopCondition`s). Composes with
     * {@link AgentConfig.maxTurns} — the loop ends when EITHER triggers.
     */
    stopWhen?: ReadonlyArray<StopCondition<ToolSet>> | StopCondition<ToolSet>;
    /** Passed to `generateText` as `experimental_telemetry`. */
    telemetry?: TelemetryOptions;
    /** Sampling temperature forwarded to the model. */
    temperature?: number;
    /** Tool-choice strategy (AI SDK `ToolChoice`). Default: `"auto"`. */
    toolChoice?: ToolChoice<ToolSet>;
    /** The tools the model may call, by name. */
    tools?: Record<string, AnyAgentTool>;
}

/** The input the parent model provides when delegating to a sub-agent tool. */
export interface AgentSubToolInput {
    /** The task or question to hand to the sub-agent. */
    prompt: string;
}

/** Options for {@link AgentDefinition.asTool} (`agent.asTool(...)`). */
export interface AgentAsToolOptions {
    /** What the sub-agent does — shown to the parent's model (it decides from it). */
    description: string;

    /** Cap on child-run status polls before giving up. Default 120. */
    maxPolls?: number;

    /**
     * The child agent's export name — selects its `AGENT_&lt;NAME>` Workflow
     * binding (e.g. `"researcher"` → `AGENT_RESEARCHER`). The model-facing tool
     * name is the KEY assigned in the parent's `tools` map, not this.
     */
    name: string;

    /** Delay (ms) between child-run status polls. Default 500. */
    pollIntervalMs?: number;

    /**
     * Test seam replacing the between-poll wait. Production uses a real timer;
     * tests inject an immediate resolve so polling runs without wall-clock delay.
     */
    wait?: (ms: number) => Promise<void>;
}

/** A `defineAgent` result — config plus the brand codegen discovers. */
export interface AgentDefinition extends AgentConfig {
    /**
     * Adapt this agent into a tool a PARENT agent can call: the returned tool's
     * `execute` starts a durable child run on the named agent's Workflow binding
     * and returns its final answer. Mirrors `@lunora/ai/rag`'s `asTool()`. The
     * child run is correlated by a replay-stable `threadKey` derived from the
     * parent's `toolCallId`, so a retried step reuses the same sub-run.
     */
    asTool: (options: AgentAsToolOptions) => AgentToolDefinition<AgentSubToolInput, string>;

    /** Runtime brand check (see `isAgentDefinition`). */
    readonly isLunoraAgent: true;
}

/** Params of one agent run (the compiled workflow's payload). */
export interface AgentRunInput {
    /** The user message that starts (or continues) the thread. */
    input: string;

    /**
     * Verified identity of the thread owner — pass `ctx.auth.userId` from the
     * mutation/action starting the run. An owned thread's public queries
     * (`agents:agentThread` / `agents:agentMessages`) only answer for this
     * identity; omitting it leaves the thread readable by anyone who knows the
     * key (only appropriate for single-tenant/anonymous apps). Immutable after
     * the first run.
     */
    owner?: string;
    /** The thread key — reuse to continue a conversation. */
    threadKey: string;
    /** Optional thread title, set on first creation. */
    title?: string;
}

/** Output of one agent run (the compiled workflow's return value). */
export interface AgentRunResult {
    /** The parsed structured answer, when {@link AgentConfig.output} is set. */
    output?: unknown;

    /**
     * Why the run ended: a final answer, a `stopWhen` condition, or the
     * `maxTurns` cap.
     */
    stopped: "final" | "maxTurns" | "stopCondition";
    /** The final assistant text (absent when stopped by `maxTurns`). */
    text?: string;
    /** LLM turns consumed. */
    turns: number;
    /** Cumulative token usage across the run's turns, when the model reported it. */
    usage?: AgentUsage;
}

/**
 * Function paths of the agent runtime functions (the `agentComponent()`
 * functions the app re-exports from `lunora/agents.ts`, so codegen registers
 * them under the `agents:` namespace).
 */
export interface AgentFunctionPaths {
    appendMessage: string;
    ensureThread: string;
    listMessages: string;
    patchThread: string;
}

/**
 * Approval lifecycle marker on a message: `"awaiting_approval"` on the
 * placeholder written while a run pauses on a gated tool, then `"approved"` /
 * `"rejected"` on the tool result once a client resolves it. Absent on ordinary
 * messages. `"awaiting_approval"` rows are filtered out of the model prompt.
 */
export type AgentMessageStatus = "approved" | "awaiting_approval" | "rejected";

/** One persisted thread message, as the loop reads it back. */
export interface AgentMessageRow {
    content: string;
    role: "assistant" | "system" | "tool" | "user";
    seq: number;
    /** Approval lifecycle marker — see {@link AgentMessageStatus}. */
    status?: AgentMessageStatus;
    toolCallId?: string;
    toolCalls?: ReadonlyArray<AgentToolCall>;
    toolName?: string;
}

/** One model-issued tool call. */
export interface AgentToolCall {
    id: string;
    input: unknown;
    name: string;
}

/** Normalized result of one LLM turn (the `generate` seam's return value). */
export interface AgentGenerateResult {
    /** The parsed structured answer, when {@link AgentConfig.output} is set. */
    output?: unknown;
    text: string;
    toolCalls: ReadonlyArray<AgentToolCall>;
    /** Token usage the model reported for this turn. */
    usage?: AgentUsage;
}

/** Options passed to the {@link AgentGenerate} seam for one LLM turn. */
export interface AgentGenerateOptions {
    /** Restrict the tools exposed to the model this turn (by name). */
    activeTools?: ReadonlyArray<string>;
    /** The assembled conversation for this turn. */
    messages: ReadonlyArray<unknown>;
    /** A per-turn model override (from {@link AgentConfig.prepareStep}). */
    model?: LanguageModel;
    /** A per-turn tool-choice override. */
    toolChoice?: ToolChoice<ToolSet>;
}

/**
 * The LLM-turn seam: given the assembled conversation, return the model's
 * decision. Production wires AI SDK `generateText`; tests inject a script.
 */
export type AgentGenerate = (options: AgentGenerateOptions) => Promise<AgentGenerateResult>;

/**
 * A live token delta produced while a turn streams. Ephemeral — deltas are
 * pushed to the sink as the model generates and are NEVER replayed (the
 * persisted assistant message is the single source of truth). Keyed by
 * `threadKey` + the zero-based `turn` so a client can correlate a delta to the
 * in-flight turn.
 */
export interface AgentTokenDelta {
    /** The incremental text chunk the model just produced. */
    text: string;
    /** The thread this delta belongs to. */
    threadKey: string;
    /** The zero-based index of the turn producing the delta. */
    turn: number;
}

/**
 * A live-only sink for streamed token deltas. The runtime provides it (teeing
 * to the existing stream transport); tests capture it. Invoked ONLY on the
 * first execution of a turn's durable step — a workflow replay serves the
 * memoized turn without re-running the body, so no delta is re-emitted.
 *
 * At-least-once caveat: if a turn's step *fails mid-stream* (before it commits)
 * the workflow retries the not-yet-memoized step and re-tees that turn's deltas
 * from scratch. This is the standard durable-step retry contract, not a replay
 * of a completed turn. Consumers should therefore reset/dedupe accumulated text
 * per `threadKey`+`turn` boundary so a step retry cannot visually double-append;
 * the persisted assistant message remains the single source of truth.
 */
export type AgentTokenSink = (delta: AgentTokenDelta) => void;

/**
 * The streaming LLM-turn seam: like {@link AgentGenerate} but tees each text
 * delta to `onDelta` as the model produces it, then resolves the SAME
 * {@link AgentGenerateResult} the non-streaming seam returns — so the value the
 * durable `llm:turn:N` step memoizes (and persists) is identical whether the
 * turn streamed or not. Production wires AI SDK `streamText`; tests inject a
 * script. Deltas are live-only — a workflow replay never re-invokes the seam.
 */
export type AgentStreamGenerate = (options: AgentGenerateOptions, onDelta: (text: string) => void) => Promise<AgentGenerateResult>;

/** Spec entry codegen emits per agent: `{ binding: "AGENT_SUPPORT", exportName: "support" }`. */
export interface AgentBindingSpec {
    binding: string;
    exportName: string;
}

/**
 * The lifecycle status stored on an agent thread: `"running"` while a run is in
 * flight, `"idle"` after it finishes (or stops on a condition), `"error"` on a
 * terminal failure, `"cancelled"` when a run was terminated via
 * {@link AgentHandle.cancel}, and `"awaiting_input"` while the run is paused on
 * a human-in-the-loop tool approval. Mirrored by the `status` `v.union` in
 * `component.ts`.
 */
export type AgentThreadStatus = "awaiting_input" | "cancelled" | "error" | "idle" | "running";

/** Structural subset of a Cloudflare Workflow instance the producer surface needs. */
export interface AgentWorkflowInstanceLike {
    /** Deliver an external event to the running instance (resumes a `waitForEvent`). */
    sendEvent: (event: { payload: unknown; type: string }) => Promise<void>;
    status: () => Promise<unknown>;
    terminate: () => Promise<void>;
}

/** Structural subset of a Cloudflare Workflow binding the producer surface needs. */
export interface AgentWorkflowBindingLike {
    create: (options?: { id?: string; params?: unknown }) => Promise<{ id: string }>;
    get: (id: string) => Promise<AgentWorkflowInstanceLike>;
}

/** A started agent run (a workflow instance). */
export interface AgentRunHandle {
    /** The workflow instance id. */
    id: string;
}

/** The `ctx.agents.&lt;name>` producer handle. */
export interface AgentHandle {
    /**
     * Cancel a run by its workflow instance id: terminate the instance and mark
     * its thread `"cancelled"`. Safe to call on an already-finished run.
     */
    cancel: (id: string) => Promise<void>;
    /** Start a durable agent run for a thread. */
    run: (input: AgentRunInput, options?: { id?: string }) => Promise<AgentRunHandle>;

    /**
     * Deliver an external event to a run by its workflow instance id — the path
     * `agents:agentResolveApproval` uses to resume a run paused on a
     * human-in-the-loop tool approval.
     */
    sendEvent: (id: string, event: { payload: unknown; type: string }) => Promise<void>;
    /** Read a run's workflow status by instance id. */
    status: (id: string) => Promise<unknown>;
}
