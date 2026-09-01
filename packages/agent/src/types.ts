import type { InboundEmail } from "@lunora/mail/inbound";
import type { FlexibleSchema, LanguageModel, ModelMessage, StopCondition, TelemetryOptions, ToolCallRepairFunction, ToolChoice, ToolSet } from "ai";

/**
 * Structural mirror of the Lunora function reference (`{ __lunoraRef }`).
 * Declared locally so the loop can mint references to the agent runtime
 * functions by path without importing `@lunora/dispatch`.
 * @experimental
 */
export interface AgentFunctionReference {
    __lunoraRef: string;
}

/**
 * `ctx.run`-shaped dispatcher the loop uses to call Lunora functions.
 * @experimental
 */
export type AgentRunFunction = (reference: AgentFunctionReference, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * Structural subset of the Cloudflare Workflows durable-step API the loop needs.
 * @experimental
 */
export interface AgentStepLike {
    do: <T>(name: string, callback: () => Promise<T>) => Promise<T>;

    /**
     * Durably hibernate until an external event of `type` arrives, then return
     * its payload. Used for human-in-the-loop approvals: a run pauses on
     * `approval:<toolCallId>` until a client resolves it. Like `do`, a resolved
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
 * (`tool:<name>:<toolCallId>`, further suffixed per script step for a
 * `codeTool`). A COMPLETED tool step is never re-run on a workflow replay
 * (native step memoization) — but a step that FAILS mid-body is retried
 * at-least-once, so a side-effecting tool (charge a card, send a mail) must
 * dedupe on this key itself. `functionTool` forwards it to the dispatched
 * function as `args.idempotencyKey` (pinned after the model input, so it
 * can't be overridden) — a function that wants to dedupe declares
 * `idempotencyKey: v.optional(v.string())` in its own args and checks it; a
 * function that ignores it is unaffected (an undeclared arg field is dropped,
 * not rejected).
 * @experimental
 */
export interface AgentToolContext {
    /**
     * How many sub-agent delegations deep this run already is — 0 for a run a
     * user started, one more per `agent.asTool` hop. The loop copies it off
     * {@link AgentRunInput.depth}; `agent.asTool` reads it to refuse spawning a
     * child past the delegation-depth bound (see `as-tool.ts`). Absent is 0.
     */
    depth?: number;

    /** The Worker environment bindings. */
    env: Record<string, unknown>;

    /**
     * Read the thread's synced state — dispatches the public owner-gated
     * `agents:agentState` query through {@link AgentToolContext.run} (the same
     * admin-dispatch path the loop reads history with), so it inherits the
     * thread's identity/owner gate. Returns `undefined` before any state was
     * seeded (`defineAgent({ initialState })`) or written.
     *
     * NOT replay-stable: on an at-least-once step retry this reflects whatever a
     * prior attempt already wrote via {@link AgentToolContext.setState} (a real
     * committed write, not rolled back), so a value *derived* from it is not
     * safe to pass straight back to `setState` — see its doc for the
     * read-modify-write hazard and the `idempotencyKey` dedupe fix.
     */
    getState: () => Promise<Record<string, unknown> | undefined>;
    /** Deterministic idempotency key — the tool's durable-step name. */
    idempotencyKey: string;

    /**
     * Emit an EPHEMERAL progress event for this tool call on the agent's live
     * channel — the same live-only sink the streamed token deltas ride. NOT
     * persisted and NEVER replayed: it fires only while `execute` runs inside the
     * tool's memoized durable step, so a COMPLETED step is served from the memo on
     * replay without re-emitting. A safe no-op when the runtime wired no live sink
     * (the durable path's default), exactly as `streamingText` stays empty then.
     * Surfaced on the client by `useAgentToolEvents`, correlated to this call by
     * {@link AgentToolContext.toolCallId}. `data` must be JSON-serializable.
     */
    reportProgress: (data: unknown) => void;
    /** Dispatch a Lunora function (the workflow `ctx.run`). */
    run: AgentRunFunction;

    /**
     * Replace the thread's synced state — dispatches the internal
     * `agents:agentSetState` mutation (absolute REPLACE of the whole object) and
     * broadcasts to every `useAgentState` subscriber over the existing reactive
     * channel. Runs inside the tool's memoized durable step, so a COMPLETED step
     * is served from the memo on replay without re-dispatching.
     *
     * REPLAY-SAFETY CONTRACT — the *value* you pass must be REPLAY-STABLE: a
     * constant or derived purely from the replay-stable tool `input` (never
     * `Date.now()`/`Math.random()`). A step that FAILS mid-body is retried
     * at-least-once, and the retry re-runs the whole `execute` against state a
     * prior attempt may already have written (the dispatch is a real committed
     * mutation, not rolled back). Re-applying a replay-stable value is a no-op,
     * so the absolute set converges. A value derived from
     * {@link AgentToolContext.getState} is NOT replay-stable — a naive
     * read-modify-write (`setState({ count: (await getState()).count + 1 })`)
     * DOUBLE-ADVANCES on a retry because the retry re-reads the already-written
     * value. For a read-modify-write, make the tool idempotent on
     * {@link AgentToolContext.idempotencyKey}: record the key in the state and
     * skip the write when it is already present.
     */
    setState: (state: Record<string, unknown>) => Promise<void>;

    /**
     * The durable-step handle (`step.do`/`waitForEvent`). ALWAYS present:
     * `agent-loop.ts` threads it into every tool's context unconditionally, and
     * it is required rather than optional so a missing handle is a compile
     * error instead of a silent durability downgrade. `codeTool` uses it to give
     * each script step its OWN nested durable boundary — see `code-tool.ts` — so
     * a failure at script step 3 retries only step 3, not steps 1–2's
     * already-committed side effects. Cloudflare Workflows supports a `step.do`
     * nested inside another `step.do`'s callback (the codeTool call's own
     * enclosing step). Most tools never touch this directly; a test driving
     * `execute`/`runToolScript` by hand passes a pass-through double.
     */
    step: AgentStepLike;
    /** The thread this tool call belongs to. */
    threadKey: string;
    /** The provider-issued tool-call id. */
    toolCallId: string;
}

/**
 * The view of {@link AgentToolContext} handed to a `needsApproval` gate
 * function — every field except `setState`, `step`, and `reportProgress`.
 *
 * `setState` is dropped because a gate that mutates thread state is a side
 * effect inside a decision predicate, and `reportProgress` because emitting a
 * live event is the same thing in observable form — the decision is what the
 * loop reports, not the deciding. `step` goes because the loop already runs the
 * gate inside a durable step of its own, so a gate has no business opening
 * another.
 *
 * `getState` and `run` stay: reads are legitimate gate inputs (gate on the
 * caller's plan tier, on a spend total), and the gate resolves inside its own
 * durable step, so they are replay-safe there. Note this makes the type a
 * NARROWING, not a proof of purity — `run` takes any
 * {@link AgentFunctionReference}, so a gate can still dispatch a mutation
 * before approval. Nothing in the type system distinguishes a query reference
 * from a mutation one; keeping the gate side-effect-free is the author's.
 * @experimental
 */
export type AgentApprovalContext = Omit<AgentToolContext, "reportProgress" | "setState" | "step">;

/**
 * An agent tool. Unlike a raw AI SDK tool, `execute` is NOT handed to the
 * model call — the loop runs it itself inside a named durable step so a
 * completed call never re-runs on replay, and passes the
 * {@link AgentToolContext} alongside the input.
 * @experimental
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
     * `approval:<toolCallId>` — until a client calls `agents:agentResolveApproval`.
     * On approve the tool runs exactly as normal; on reject it is skipped and a
     * tool result explaining the rejection is persisted so the next turn recovers.
     * A boolean gates statically; a function gates per input. Default: `false`
     * (unchanged behavior).
     *
     * The boolean/`undefined` forms are compile-time constants re-derived
     * identically on every replay — no durable step. The FUNCTION form runs
     * inside its OWN durable step (`tool:approval-gate:<toolCallId>`, distinct
     * from the tool's own step), so it now runs exactly once per call, not once
     * per replay. It must still be otherwise pure: deterministic given its
     * inputs (no `Date.now()`/`Math.random()`) and free of side effects — the
     * context it receives is {@link AgentApprovalContext}, which has neither
     * `setState` nor `reportProgress`; state writes and progress events belong
     * only in `execute`, inside the tool's own memoized step. It still holds
     * `run`, which the type cannot narrow to reads — see
     * {@link AgentApprovalContext}.
     */
    needsApproval?: ((input: Input, context: AgentApprovalContext) => boolean | Promise<boolean>) | boolean;
}

/**
 * Author-supplied tool config (see {@link AgentToolDefinition}).
 * @experimental
 */
export type AgentToolConfig<Input = unknown, Output = unknown> = Omit<AgentToolDefinition<Input, Output>, "isLunoraAgentTool">;

/**
 * Generic-erased tool for tool maps. `Input` sits in both a covariant
 * (`inputSchema`) and a contravariant (`execute`) position, so no single
 * non-`any` instantiation admits every concrete tool — the same reason the AI
 * SDK's `ToolSet` erases its generics.
 * @experimental
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance escape hatch, see above
export type AnyAgentTool = AgentToolDefinition<any, any>;

/**
 * The model an agent runs on: a Workers AI model id (resolved via `env.AI`),
 * a prebuilt AI SDK {@link LanguageModel}, or a thunk building one from the
 * Worker env (for providers that need API keys off `env`).
 * @experimental
 */
export type AgentModelInput = LanguageModel | ((env: Record<string, unknown>) => LanguageModel);

/**
 * Memory wiring: the path (or reference) of an app **action** taking
 * `{ query: string }` and returning `@lunora/ai/rag`'s `RetrieveResult`
 * (`{ context, chunks, sources }`) — typically three lines over
 * `defineRag(...)(ctx).retrieve`. Dispatching to a real action (instead of
 * embedding vector plumbing here) keeps retrieval inside a fully wired ctx:
 * codegen-resolved vector bindings, RLS, observability.
 *
 * Two retrieval MODES. `"inject"` (default) runs the action as a durable step at
 * turn start and injects `.context` as one system message (one-shot top-k).
 * `"agentic"` skips auto-injection; the source instead mints a `searchMemory`
 * tool the MODEL calls mid-reasoning (Recursive-LM / "read what you need") — each
 * call a memoized durable step, so multi-hop retrieval is crash-safe for free.
 * @experimental
 */
export interface AgentMemoryOptions {
    /**
     * Episodic-tier options — read only when {@link AgentMemoryOptions.kind} is
     * `"episodic"`. `recall` bounds how many recent episodes are injected per run
     * (default 5, capped at 20); `extractionModel` overrides the (optionally
     * cheaper) model that summarizes each run into an episode (defaults to the
     * agent's own model).
     */
    episodic?: {
        /** Model for the run-end episode-summary step (defaults to the agent's model). */
        extractionModel?: AgentModelInput;
        /** Max recent episodes recalled per run (default 5, max 20). */
        recall?: number;
    };

    /**
     * Graph-tier bounds and extraction model — read only when
     * {@link AgentMemoryOptions.kind} is `"graph"`. `depth`/`maxSeeds`/`fanOut`/
     * `maxNodes` bound the run-time BFS traversal; `extractionModel` overrides the
     * (optionally cheaper) model used for the run-end entity/relation extraction
     * step (defaults to the agent's own model).
     */
    graph?: {
        /** Max BFS hops from a seed entity (default 2). */
        depth?: number;
        /** Model for the run-end extraction step (defaults to the agent's model). */
        extractionModel?: AgentModelInput;
        /** Max edges expanded per visited node (default 8). */
        fanOut?: number;
        /** Max entities visited across the whole traversal (default 32). */
        maxNodes?: number;
        /** Max seed entities matched from the query (default 4). */
        maxSeeds?: number;
    };

    /**
     * `"semantic"` (default) is vector RAG over {@link AgentMemoryOptions.source}.
     * `"graph"` traverses the owner-scoped entity/relation graph (auto-extracted
     * on write, keyed by the thread's `owner`) via the built-in traverse function
     * and ignores `source`. `"episodic"` recalls a recency-ordered timeline of the
     * owner's past runs (each summarized at run end); it also ignores `source`.
     * See {@link AgentMemoryOptions}.
     */
    kind?: "episodic" | "graph" | "semantic";

    /**
     * `"inject"` (default) auto-injects one top-k context system message per
     * run; `"agentic"` skips injection and mints a `searchMemory` tool the model
     * drives itself. Applies to `"semantic"` kind only. See
     * {@link AgentMemoryOptions}.
     */
    mode?: "agentic" | "inject";

    /**
     * Agentic-only. An optional fetch-by-id **action** `{ id: string } -> string`
     * that mints a companion `readMemory` tool so the model can pull a full
     * document after `searchMemory` surfaces its id (typically a ~3-line action
     * mapping `${sourceId}#${n}` → text). Ignored in `"inject"` mode.
     */
    read?: AgentFunctionReference | string;

    /**
     * Agentic-only. Per-result snippet truncation (chars) applied to each
     * `searchMemory` hit for token economy. Default 240. Ignored in `"inject"`
     * mode.
     */
    snippetChars?: number;

    /**
     * The memory action: a function path (`"rag:searchDocs"`) or reference.
     * Required for `"semantic"` kind (enforced at `defineAgent`); ignored — and
     * therefore optional — for `"graph"` kind, which dispatches the built-in
     * traverse function instead.
     */
    source?: AgentFunctionReference | string;
    /** Retrieval depth forwarded to the action as `topK`. */
    topK?: number;
}

/**
 * One keyed memory-retrieval source the loop dispatches per run. `defineAgent`
 * folds them onto {@link AgentDefinition.memorySources}: the default source
 * (`key: "default"`) from {@link AgentConfig.memory}, then one per skill that
 * carries `knowledge` (keyed by the skill's name). The key names the durable
 * step — the default source keeps the historic `"memory:retrieve"`, a skill
 * source uses `"memory:retrieve:<key>"` — so replay stays deterministic.
 * @experimental
 */
export interface AgentMemorySource extends AgentMemoryOptions {
    /** Stable source key: `"default"` for `memory`, else the contributing skill's name. */
    key: string;
}

/**
 * Cumulative or per-turn token usage — AI SDK `LanguageModelUsage` field names.
 * @experimental
 */
export interface AgentUsage {
    /** Prompt (input) tokens. */
    inputTokens?: number;
    /** Completion (output) tokens. */
    outputTokens?: number;
    /** Input + output tokens. */
    totalTokens?: number;
}

/**
 * Context handed to a dynamic {@link AgentConfig.instructions} function.
 * @experimental
 */
export interface AgentInstructionsContext {
    /** The Worker environment bindings. */
    env: Record<string, unknown>;
    /** The user message that started this run. */
    input: string;
    /** The thread this run belongs to. */
    threadKey: string;
}

/**
 * Author-supplied config for {@link SkillDefinition} — a reusable bundle of
 * expertise (an instruction fragment, tools, and retrieval knowledge) an agent
 * composes in via `defineAgent({ skills: [...] })`. Reuse-first: `tools` carry
 * the SAME {@link AnyAgentTool} shape agents already use
 * (`functionTool`/`mcpTools`/`agentAsTool`), and `knowledge` reuses the
 * {@link AgentMemoryOptions} retrieval verbatim.
 * @experimental
 */
export interface SkillConfig {
    /**
     * An instruction fragment merged into the agent's system prompt — a static
     * string or a thunk over the run context (same shape as
     * {@link AgentConfig.instructions}). Fragments compose in order: the agent's
     * own instructions first, then each skill's in `skills` array order.
     */
    instructions?: string | ((context: AgentInstructionsContext) => string);

    /**
     * Retrieval-augmented knowledge for this skill — see
     * {@link AgentMemoryOptions}. Retrieved as its own durable step at run start
     * (keyed by the skill `name`) and injected alongside the agent's `memory`.
     */
    knowledge?: AgentMemoryOptions;

    /**
     * The skill's identifier — namespaces this skill's `knowledge` memory source
     * (the durable step `memory:retrieve:<name>`). Must be identifier-shaped.
     */
    name: string;

    /**
     * Tools this skill contributes, merged into the agent's FLAT tool namespace.
     * A name collision with the agent's own tools (or another skill's) is an
     * error at `defineAgent` — the agent owns the model-facing namespace.
     */
    tools?: Record<string, AnyAgentTool>;
}

/**
 * The code-side parts of a markdown-authored skill — everything `SKILL.md`
 * cannot carry. `name` and `instructions` come from the file itself.
 * @experimental
 */
export type SkillMarkdownExtras = Omit<SkillConfig, "instructions" | "name">;

/**
 * A `defineSkill` result — config plus the brand the agent merge checks.
 * @experimental
 */
export interface SkillDefinition extends SkillConfig {
    /** Runtime brand check (see `isSkillDefinition`). */
    readonly isLunoraSkill: true;
}

/**
 * One prior turn, as {@link AgentConfig.prepareStep} and `stopWhen` observe it.
 * @experimental
 */
export interface AgentStepInfo {
    /** The assistant text of the turn. */
    text: string;
    /** The tool calls the turn issued (AI SDK `StepResult.toolCalls` shape). */
    toolCalls: ReadonlyArray<{ input: unknown; toolCallId: string; toolName: string }>;
    /** The turn's token usage, when the model reported it. */
    usage?: AgentUsage;
}

/**
 * The turn summary handed to {@link AgentConfig.onStepFinish}.
 * @experimental
 */
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
 * inside a named durable step (`agent:step-finish:<turn>`) so it fires exactly
 * once per turn even across a workflow replay.
 * @experimental
 */
export type AgentOnStepFinish = (info: AgentStepFinishInfo) => Promise<void> | void;

/**
 * What {@link AgentConfig.onReply} is called with when a triggered run reaches
 * its final answer.
 * @experimental
 */
export interface AgentReplyInfo {
    /** The worker `env` — where an outbound credential (a bot token, a mailer binding) lives. */
    env: Record<string, unknown>;
    /** Where to reply, captured by the mapper that started this run. */
    replyRef: AgentReplyRef;
    /** The run's final answer. */
    result: AgentRunResult;
    /** The thread this run belongs to. */
    threadKey: string;
}

/**
 * Send a triggered run's answer back where it came from — the outbound half of
 * an `onEmail` / `onInbound` trigger.
 *
 * Called once, automatically, when a run started with a `replyRef` produces a
 * final answer; a run without one (an ordinary in-app `ctx.agents.<name>.run`)
 * never calls it. It runs inside a named durable step, so a transient failure
 * is retried and a workflow replay does not send the answer twice.
 *
 * Delivery is the app's call, because only the app has the credential: email
 * has a home already (`replyToEmail(mailer, ref, body)` from
 * `@lunora/agent/reply`), while Slack/GitHub/Discord bot tokens have no
 * framework-owned store yet — read them from `info.env` and make the provider
 * call.
 * @experimental
 */
export type AgentOnReply = (info: AgentReplyInfo) => Promise<void> | void;

/**
 * The input {@link AgentConfig.prepareStep} sees before a turn runs.
 * @experimental
 */
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
 * @experimental
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
 * @experimental
 */
export type AgentPrepareStep = (input: AgentPrepareStepInput) => AgentPrepareStepResult | Promise<AgentPrepareStepResult | undefined> | undefined;

/**
 * The subset of {@link AgentRunInput} an {@link AgentEmailMapper} returns to
 * start a run from an inbound email.
 * @experimental
 */

/**
 * Where a triggered run should send its answer back to — captured by the
 * mapper, from fields the verified inbound payload already carries, and carried
 * through the run so {@link AgentConfig.onReply} can answer in the same place
 * the question was asked.
 *
 * A discriminated union rather than an opaque blob because each channel threads
 * differently: email by RFC 5322 `In-Reply-To`/`References`, Slack by
 * `thread_ts`, GitHub by issue number, Discord by channel (plus the triggering
 * message for a true reply).
 * @experimental
 */
export type AgentReplyRef =
    | { channel: "discord"; channelId: string; messageId?: string }
    | { channel: "email"; from: string; messageId: string; references?: string; to: string[] }
    | { channel: "github"; commentId?: number; issueNumber: number; owner: string; repo: string }
    | { channel: "slack"; channelId: string; threadTs: string };

export interface AgentEmailRun {
    /** The user message that starts (or continues) the thread — the model's prompt. */
    input: string;

    /**
     * Verified owner of the thread (its RLS scope). SECURITY: inbound `from` is
     * spoofable and the run dispatches RLS-bypassed — derive this from a verified
     * signal (a DKIM-checked address, a mapped account), never blindly from
     * `email.from`.
     */
    owner?: string;

    /**
     * Where to send the answer — see {@link AgentReplyRef}. Populate it from the
     * event the mapper already has (`captureEmailReplyRef(email)` does it for
     * email) and the run calls {@link AgentConfig.onReply} with it once the
     * final answer is ready. Omit it and the run simply never replies.
     */
    replyRef?: AgentReplyRef;
    /** The thread key — reuse to continue a conversation (e.g. a ticket id parsed from the subject). */
    threadKey: string;
    /** Optional thread title, set on first creation. */
    title?: string;
}

/**
 * Map an inbound email into an agent run, or `null`/`undefined` to DROP it (a
 * failed DKIM/SPF/DMARC check, or a message not addressed to this agent). Wired
 * by codegen onto the worker's top-level `email()` handler when set — see
 * `@lunora/agent/inbound`.
 *
 * SECURITY: the parsed `from`/`subject`/body are attacker-controlled and the run
 * is dispatched with RLS bypassed. Gate on `email.authentication` (DKIM/SPF/DMARC
 * verdicts) here before returning a run, and treat every returned field as
 * untrusted input.
 * @experimental
 */
export type AgentEmailMapper = (email: InboundEmail) => AgentEmailRun | null | Promise<AgentEmailRun | null | undefined> | undefined;

/** The inbound webhook channels an agent can be triggered from — see `@lunora/agent/channels`. */
export type AgentInboundChannelKind = "discord" | "github" | "slack";

/** The run-input an inbound-channel mapper returns — the same shape as {@link AgentEmailRun}. */
export type AgentChannelRun = AgentEmailRun;

/**
 * The verified, parsed webhook event handed to an {@link AgentInboundChannel.map} mapper.
 * @experimental
 */
export interface InboundChannelEvent {
    /** Which channel delivered it. */
    channel: AgentInboundChannelKind;
    /** The raw request headers. */
    headers: Headers;
    /** Parse the body as JSON (throws on malformed JSON). */
    json: () => unknown;
    /** The raw (verified) request body. */
    rawBody: string;
}

/**
 * Map a VERIFIED inbound channel event into an agent run, or `null`/`undefined`
 * to DECLINE it. Runs only AFTER the channel signature check passes.
 *
 * SECURITY: the payload is attacker-controlled and the run dispatches RLS
 * bypassed. Derive the run `owner` from the verified channel identity (the
 * workspace/installation the signing secret belongs to), never from an arbitrary
 * payload field, and treat every returned field as untrusted input.
 */
export type AgentChannelMapper = (event: InboundChannelEvent) => AgentChannelRun | null | Promise<AgentChannelRun | null | undefined> | undefined;

/**
 * Trigger an agent from a verified inbound webhook. Codegen wires the developer's
 * chosen HTTP route to `dispatchAgentChannel(...)` (from `@lunora/agent/channels`),
 * which verifies the channel signature over the raw body before calling `map`.
 */
export interface AgentInboundChannel {
    /** Which channel this agent listens on (selects the signature scheme). */
    channel: AgentInboundChannelKind;
    /** Map a verified event to a run (or `null` to decline). */
    map: AgentChannelMapper;

    /**
     * The verification credential, from `env`: an env-var NAME (string) or an
     * `(env) => value` resolver. Slack → signing secret; GitHub → webhook secret;
     * Discord → the application's Ed25519 public key (hex).
     */
    secret: string | ((env: Record<string, unknown>) => string | undefined);
}

/**
 * `AgentConfig` is part of the experimental `@lunora/agent` API and may change without a major version bump.
 * @experimental
 */
export interface AgentConfig {
    /** Restrict the tools the model may call, by name. Default: all tools. */
    activeTools?: ReadonlyArray<string>;

    /**
     * How long a human-in-the-loop tool approval may stay pending before the
     * run stops waiting — a Cloudflare Workflows duration: milliseconds, or a
     * `"<n> <unit>"` string like `"3 days"` (the unit set is the host's, so a
     * typo is a compile error). Default `"3 days"`.
     *
     * On timeout the call is treated as REJECTED (the run records why and
     * continues down the normal rejection path), so a run whose approver never
     * answers ends instead of hibernating forever.
     *
     * CLAMPED to one week. A longer wait would outlive the thread's
     * abandoned-run horizon, letting a new run reclaim the thread while the
     * approval is still pending — which is the exact failure this timeout
     * exists to prevent, so it cannot be configured back into existence.
     */
    approvalTimeout?: `${number} ${"day" | "hour" | "minute" | "month" | "second" | "week" | "year"}${"s" | ""}` | number;

    /**
     * Automatic thread-history compaction. When the persisted history exceeds
     * `maxMessages`, the loop summarizes the older messages (all but the most
     * recent `keepRecent`, default `ceil(maxMessages / 2)`) into one system-message
     * brief and prompts the model with that brief plus the recent tail — keeping
     * the context bounded as a conversation grows. The summary is produced inside
     * the turn's memoized durable step (replay-safe) by `model` (a cheaper model
     * may be set, else the agent's). Absent (the default) disables compaction —
     * the full history is sent every turn, exactly as before. A manual
     * {@link AgentConfig.prepareStep} still runs after and can override further.
     */
    compaction?: {
        /** How many most-recent messages to keep verbatim (default `ceil(maxMessages / 2)`). */
        keepRecent?: number;
        /** Compact once history exceeds this many messages. */
        maxMessages: number;
        /** Model for the summarization step (defaults to the agent's model). */
        model?: AgentModelInput;
    };

    /**
     * Seed the thread's synced state — a static, JSON-serializable object set on
     * the thread row at creation only (first writer wins, like `owner`/`title`),
     * so a `useAgentState` client sees it immediately. Keep it DETERMINISTIC (no
     * `Date.now()`/`Math.random()`); it is written once by the durable bootstrap.
     * Runtime-only config — invisible to codegen (agent-free and agent-ful
     * `_generated/*` output is unchanged by its presence).
     */
    initialState?: Record<string, unknown>;

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
     * `workflows[].name`). Defaults to `agent-<kebab-cased export name>`. Does
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
     * - `"queue"` — park the new run behind the one in flight (FIFO, up to five deep) and hibernate it until the thread is handed over.
     *
     * Each parked run is a live workflow instance waiting on an event, so the
     * queue's depth cap is a real resource bound: past it, a start is rejected
     * exactly as `"reject"` would. A `"replace"` arriving later supersedes the
     * run in FLIGHT, not the queue — parked runs still take their turn after it.
     *
     * A dispatch with no instance id (the inbound-email / inbound-channel
     * paths) cannot be parked, because nothing later can tell it apart from
     * another such dispatch to wake it; `"queue"` rejects those.
     *
     * A workflow REPLAY re-enters the bootstrap under the SAME instance id and
     * is never a concurrent run (the guard compares the stored instance id).
     */
    onConcurrentRun?: "queue" | "reject" | "replace";

    /**
     * Map an inbound email into an agent run — see {@link AgentEmailMapper}.
     * When set, codegen wires this agent onto the worker's top-level `email()`
     * handler (via `@lunora/agent/inbound`) so a received message starts a
     * durable run. Return `null`/`undefined` to drop the message.
     */
    onEmail?: AgentEmailMapper;

    /**
     * Trigger this agent from a verified inbound webhook (Slack / GitHub /
     * Discord) — see {@link AgentInboundChannel}. Mount `dispatchAgentChannel(...)`
     * (from `@lunora/agent/channels`) on an HTTP route; it verifies the channel
     * signature over the raw body before calling `map`.
     */
    onInbound?: AgentInboundChannel;

    /**
     * Called with the final answer when the run was triggered from a channel
     * that gave it a `replyRef` — see {@link AgentOnReply}. This is how an
     * inbound-triggered agent answers where it was asked.
     */
    onReply?: AgentOnReply;
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
     * Opt this agent into being STARTED over the public RPC boundary — i.e. via
     * the auto-registered `agents:agentRun` mutation an HTTP-only client (e.g.
     * the `@lunora/mcp` server) calls. Default `false`: an agent is startable
     * only from server-side app code (`ctx.agents.<name>.run(...)`), so declaring
     * an agent does NOT expose it to arbitrary RPC callers. Fail-closed — the run
     * mutation refuses an agent that has not opted in, regardless of any MCP-side
     * `allowAgents` configuration. A started thread is still owner-scoped to
     * `ctx.auth.userId`. Deploy configuration codegen reads STATICALLY (a boolean
     * literal), so it must be inline in the `defineAgent({ ... })` object literal.
     */
    publicRun?: boolean;

    /**
     * Repair a malformed tool call the model emits (AI SDK
     * `experimental_repairToolCall`): given the failing `{ toolCall, error, tools,
     * inputSchema, messages, system }`, return a corrected tool call or `null` to
     * give up. Runs inside the model turn, so keep it deterministic (it re-runs on
     * a replay). Unset (the default) leaves the loop's existing
     * unknown-tool-name recovery as the only repair path.
     */
    repairToolCall?: ToolCallRepairFunction<ToolSet>;

    /**
     * Reusable {@link SkillDefinition}s to compose in — each contributes an
     * instruction fragment, tools (merged into the flat namespace; collisions
     * throw), and retrieval `knowledge` (its own keyed memory source). Folded at
     * declaration time; the tool namespace and memory sources on the returned
     * {@link AgentDefinition} already reflect the merge.
     */
    skills?: ReadonlyArray<SkillDefinition>;

    /**
     * Extra loop-stop conditions (AI SDK `StopCondition`s). Composes with
     * {@link AgentConfig.maxTurns} — the loop ends when EITHER triggers.
     */
    stopWhen?: ReadonlyArray<StopCondition<ToolSet>> | StopCondition<ToolSet>;
    /** Passed to `generateText` as its stable `telemetry` option. */
    telemetry?: TelemetryOptions;
    /** Sampling temperature forwarded to the model. */
    temperature?: number;
    /** Tool-choice strategy (AI SDK `ToolChoice`). Default: `"auto"`. */
    toolChoice?: ToolChoice<ToolSet>;
    /** The tools the model may call, by name. */
    tools?: Record<string, AnyAgentTool>;

    /**
     * Opt into a real-time voice session — see {@link AgentVoiceConfig}. Its mere
     * presence tells codegen to emit the `VOICE_...` hibernatable-WebSocket DO
     * (`VoiceSessionDO` subclass) and the `api.agents.{name}Voice` client
     * reference; an agent without it is byte-identical to before. Runtime config
     * for the in-DO pipeline (models/voice) rides the same object.
     */
    voice?: AgentVoiceConfig;
}

/**
 * Opt an agent into a real-time VOICE session — a dedicated hibernatable-
 * WebSocket Durable Object (`VoiceSessionDO`) that runs a per-turn
 * STT→LLM→TTS pipeline IN-DO and SHARES the agent's existing thread tables
 * (`agent_threads`/`agent_messages`) via the runtime dispatch seam. Presence of
 * this block is what codegen keys on to emit the `VOICE_...` DO class + the
 * `api.agents.{name}Voice` client reference; agents without it are byte-
 * identical.
 *
 * v1 slice: conversational turns only. In-DO voice turns are NOT replay-durable
 * and get NO Workflow tool-loop — tool calls are deferred. All fields are
 * optional; the defaults target Workers AI (`@cf/openai/whisper-large-v3-turbo`
 * for STT, `@cf/deepgram/aura-1` for TTS).
 * @experimental
 */
export interface AgentVoiceConfig {
    /**
     * Server→client audio container. `"mp3"` (default) matches the TTS model's
     * native stream; carried to the client so it decodes the returned frames
     * with the right codec.
     */
    audioFormat?: "mp3" | "wav";

    /**
     * Spoken on connect before the first user turn — a fixed greeting synthesized
     * through the TTS model. Omit for a silent-until-spoken-to session.
     *
     * Synthesized once per THREAD, not once per socket: the greeting's persisted
     * row is keyed per thread, and a reconnect onto a thread that already exists
     * gets the `ready` frame without paying for the same line again.
     */
    greeting?: string;

    /**
     * Cap on how many turns one voice socket may run before it is closed with
     * code `4002`. Every turn is a full LLM generation plus sentence-by-sentence
     * TTS — billed and persisted — on a hibernatable socket that can live for
     * days, and the one-turn-in-flight guard throttles nothing. Defaults to 100;
     * a client that hits the cap reconnects for a fresh budget.
     */
    maxTurns?: number;

    /**
     * TTS voice/speaker id forwarded to the TTS model (e.g. a Deepgram Aura voice
     * like `"aura-asteria-en"`). Model-specific; omitted when unset so the model
     * uses its own default voice.
     */
    speaker?: string;

    /**
     * Speech-to-text model id (a Workers AI id, resolved via `env.AI`). Defaults
     * to `@cf/openai/whisper-large-v3-turbo` — batch per-utterance transcription
     * (the client marks utterance boundaries; continuous STT is deferred).
     */
    stt?: string;

    /**
     * Text-to-speech model id (a Workers AI id, resolved via `env.AI`). Defaults
     * to `@cf/deepgram/aura-1` — streamed MP3 synthesized sentence-by-sentence
     * from the LLM's token stream.
     */
    tts?: string;
}

/**
 * The input the parent model provides when delegating to a sub-agent tool.
 * @experimental
 */
export interface AgentSubToolInput {
    /** The task or question to hand to the sub-agent. */
    prompt: string;
}

/**
 * Options for {@link AgentDefinition.asTool} (`agent.asTool(...)`).
 * @experimental
 */
export interface AgentAsToolOptions {
    /** What the sub-agent does — shown to the parent's model (it decides from it). */
    description: string;

    /** Cap on child-run status polls before giving up — a positive integer. Default 120. */
    maxPolls?: number;

    /**
     * The child agent's export name — selects its `AGENT_<NAME>` Workflow
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

/**
 * A `defineAgent` result — config plus the brand codegen discovers.
 * @experimental
 */
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

    /**
     * The keyed memory sources the loop dispatches per run — the merge of
     * {@link AgentConfig.memory} (as `key: "default"`) and each skill's
     * `knowledge`. Populated by `defineAgent`; `memory` stays on the config for
     * back-compat and direct authoring. When absent the loop falls back to
     * `memory` alone (preserving the historic `"memory:retrieve"` step).
     */
    memorySources?: ReadonlyArray<AgentMemorySource>;
}

/**
 * What `agentEnsureThread` reports back to the loop.
 *
 * A discriminated union rather than a bag of optional booleans: the four
 * outcomes are mutually exclusive, and the data each carries only exists for its
 * own case. `queued` has a position, `replaced` has the instance it took the
 * thread from, and the other two have nothing — encoding that as five
 * independent optional fields made every reader re-derive which combination was
 * legal.
 * @experimental
 */
export type EnsureThreadOutcome =
    { outcome: "continued" | "created" } | { outcome: "queued"; position: number } | { outcome: "replaced"; priorInstanceId: string };

/**
 * Params of one agent run (the compiled workflow's payload).
 * @experimental
 */
export interface AgentRunInput {
    /**
     * Sub-agent delegation depth. A run a user starts omits it (0); each
     * `agent.asTool` hop stamps its child one deeper, and the tool refuses to
     * delegate past the bound — `maxTurns` bounds one level's turns, this bounds
     * the TREE (every hop mints a distinct child `threadKey`, so the per-thread
     * run-queue cap never applies across them).
     */
    depth?: number;

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
    /** Where a triggered run sends its answer — see {@link AgentReplyRef}. */
    replyRef?: AgentReplyRef;
    /** The thread key — reuse to continue a conversation. */
    threadKey: string;
    /** Optional thread title, set on first creation. */
    title?: string;
}

/**
 * Output of one agent run (the compiled workflow's return value).
 * @experimental
 */
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
 * @experimental
 */
export interface AgentFunctionPaths {
    appendMessage: string;

    /**
     * The internal `agents:agentCompleteRun` mutation the loop dispatches at the
     * end of a run: it writes the terminal status AND hands the thread to the
     * next queued run in the same mutation.
     */
    completeRun: string;

    /**
     * The internal `agents:agentDeleteMessage` mutation the loop dispatches to
     * retire the HITL approval marker once the decision has landed.
     */
    deleteMessage: string;
    ensureThread: string;
    /** The internal `agents:agentEpisodeRecall` query the loop dispatches for an episodic-kind read. */
    episodeRecall: string;
    /** The internal `agents:agentEpisodeUpsert` mutation the loop dispatches on run-end episode extraction. */
    episodeUpsert: string;
    /** The internal `agents:agentGraphTraverse` query the loop dispatches for a graph-kind read. */
    graphTraverse: string;
    /** The internal `agents:agentGraphUpsert` mutation the loop dispatches on run-end graph extraction. */
    graphUpsert: string;
    listMessages: string;
    patchThread: string;

    /**
     * The public `agents:agentRun` mutation an HTTP-only client (e.g. the
     * `@lunora/mcp` server) calls to START a durable run — owner-scoped to
     * `ctx.auth.userId`, deterministic (the caller supplies `threadKey`).
     */
    run: string;
    /** The internal `agents:agentSetState` mutation the loop dispatches for `setState`. */
    setState: string;
    /** The public owner-gated `agents:agentState` query (`getState` + `useAgentState`). */
    state: string;
}

/**
 * Approval lifecycle marker on a message: `"awaiting_approval"` on the
 * placeholder written while a run pauses on a gated tool, then `"approved"` /
 * `"rejected"` on the tool result once a client resolves it. Absent on ordinary
 * messages. `"awaiting_approval"` rows are filtered out of the model prompt.
 * @experimental
 */
export type AgentMessageStatus = "approved" | "awaiting_approval" | "rejected";

/**
 * One persisted thread message, as the loop reads it back.
 * @experimental
 */
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

/**
 * One model-issued tool call.
 * @experimental
 */
export interface AgentToolCall {
    id: string;
    input: unknown;
    name: string;
}

/**
 * Normalized result of one LLM turn (the `generate` seam's return value).
 * @experimental
 */
export interface AgentGenerateResult {
    /** The parsed structured answer, when {@link AgentConfig.output} is set. */
    output?: unknown;
    text: string;
    toolCalls: ReadonlyArray<AgentToolCall>;
    /** Token usage the model reported for this turn. */
    usage?: AgentUsage;
}

/**
 * Options passed to the {@link AgentGenerate} seam for one LLM turn.
 * @experimental
 */
export interface AgentGenerateOptions {
    /** Restrict the tools exposed to the model this turn (by name). */
    activeTools?: ReadonlyArray<string>;
    /** The assembled conversation for this turn. */
    messages: ReadonlyArray<unknown>;
    /** A per-turn model override (from {@link AgentConfig.prepareStep}). */
    model?: LanguageModel;

    /**
     * Abort the in-flight turn (the streaming seam forwards it to `streamText`'s
     * `abortSignal`). On abort the streaming seam returns the text streamed so
     * far rather than rejecting, so a barge-in can persist the spoken prefix.
     * The durable (non-streaming) loop never sets it.
     */
    signal?: AbortSignal;
    /** A per-turn tool-choice override. */
    toolChoice?: ToolChoice<ToolSet>;
}

/**
 * The LLM-turn seam: given the assembled conversation, return the model's
 * decision. Production wires AI SDK `generateText`; tests inject a script.
 * @experimental
 */
export type AgentGenerate = (options: AgentGenerateOptions) => Promise<AgentGenerateResult>;

/**
 * The entities and relations extracted from one run's exchange, upserted into
 * the owner-scoped graph. Endpoint names in `relations` reference entities by
 * name (normalized on write); `confidence` (0..1) seeds an edge's weight.
 */
export interface AgentGraphExtraction {
    entities: ReadonlyArray<{ name: string; type?: string }>;
    relations: ReadonlyArray<{ confidence?: number; dst: string; label: string; src: string }>;
}

/**
 * The run-end graph-extraction seam: given the run's exchange (user input +
 * final answer) and the model to run it on, return the extracted entities and
 * relations. Production wires AI SDK `generateObject` over a fixed schema
 * (`createGraphExtract`); the durable loop calls it inside a memoized
 * `memory:extract` step so the model never re-runs on replay. Absent (the
 * default) disables extraction, so an agent with no graph memory — and every
 * unit test that doesn't opt in — is byte-identical.
 */
export type AgentGraphExtract = (input: {
    /** The run's final assistant answer. */
    assistantText: string;
    /** The Worker env, for resolving a Workers AI model id. */
    env: Record<string, unknown>;
    /** The extraction model (the source's `extractionModel`, else the agent's). */
    model: AgentModelInput;
    /** The user message that started the run. */
    userInput: string;
}) => Promise<AgentGraphExtraction>;

/**
 * The history-compaction seam: given the OLDER model messages to condense (and
 * the model to run it on), return a summary brief. Production wires AI SDK
 * `generateText` (`createCompact`); the loop calls it INSIDE the turn's memoized
 * `llm:turn:N` step so the summarization is replay-safe. Absent (the default)
 * disables compaction, so an agent with no `compaction` config — and every unit
 * test that doesn't opt in — is byte-identical.
 */
export type AgentCompact = (input: {
    /** The Worker env, for resolving a Workers AI model id. */
    env: Record<string, unknown>;
    /** The older conversation messages to summarize (already assembled). */
    messages: ModelMessage[];
    /** The compaction model (the config's `model`, else the agent's). */
    model: AgentModelInput;
}) => Promise<string>;

/** The one-line summary an episodic-memory run records for later recency recall. */
export interface AgentEpisodeExtraction {
    summary: string;
}

/**
 * The run-end episode-extraction seam: given the run's exchange and the model to
 * run it on, return a one/two-sentence summary. Production wires AI SDK
 * `generateText` (`createEpisodeExtract`); the durable loop calls it inside a
 * memoized `memory:episode` step so the model never re-runs on replay. Absent
 * (the default) disables extraction, so an agent with no episodic memory — and
 * every unit test that doesn't opt in — is byte-identical.
 */
export type AgentEpisodeExtract = (input: {
    /** The run's final assistant answer. */
    assistantText: string;
    /** The Worker env, for resolving a Workers AI model id. */
    env: Record<string, unknown>;
    /** The extraction model (the source's `extractionModel`, else the agent's). */
    model: AgentModelInput;
    /** The user message that started the run. */
    userInput: string;
}) => Promise<AgentEpisodeExtraction>;

/**
 * A live token delta produced while a turn streams. Ephemeral — deltas are
 * pushed to the sink as the model generates and are NEVER replayed (the
 * persisted assistant message is the single source of truth). Keyed by
 * `threadKey` + the zero-based `turn` so a client can correlate a delta to the
 * in-flight turn.
 * @experimental
 */
export interface AgentTokenDelta {
    /**
     * Discriminates the token arm of {@link AgentLiveEvent}. Optional and left
     * unset on the wire (a token is the default) so the existing emit site and
     * its structural test assertions stay byte-identical; narrow the union with
     * `event.kind === "progress"` to isolate the {@link AgentProgressEvent} arm.
     */
    kind?: "token";
    /** The incremental text chunk the model just produced. */
    text: string;
    /** The thread this delta belongs to. */
    threadKey: string;
    /** The zero-based index of the turn producing the delta. */
    turn: number;
}

/**
 * A live, ephemeral progress event a tool emits via
 * {@link AgentToolContext.reportProgress} while its durable step runs. Rides the
 * SAME live-only sink as {@link AgentTokenDelta} — NEVER persisted, NEVER
 * replayed. Correlated to the in-flight tool call (and its persisted tool row)
 * by `toolCallId` rather than a turn index, since a single turn can fan out many
 * tool calls.
 * @experimental
 */
export interface AgentProgressEvent {
    /** The arbitrary, JSON-serializable payload the tool reported. */
    data: unknown;
    /** Discriminates the progress arm of {@link AgentLiveEvent}. */
    kind: "progress";
    /** The thread this event belongs to. */
    threadKey: string;
    /** The tool call this progress belongs to (correlates with the persisted tool row). */
    toolCallId: string;
}

/**
 * A single event on the agent's live-only channel: either a streamed token
 * {@link AgentTokenDelta} (turn-keyed) or a tool {@link AgentProgressEvent}
 * (`toolCallId`-keyed). Both are ephemeral and never replayed — the persisted
 * thread messages remain the single source of truth. Discriminate on `kind`
 * (`"progress"` for the progress arm; token deltas leave it unset).
 * @experimental
 */
export type AgentLiveEvent = AgentProgressEvent | AgentTokenDelta;

/**
 * A live-only sink for the agent's ephemeral channel — streamed token deltas
 * ({@link AgentTokenDelta}) and tool progress events
 * ({@link AgentProgressEvent}). The runtime provides it (teeing to the existing
 * stream transport); tests capture it. Invoked ONLY on the first execution of a
 * turn's / tool's durable step — a workflow replay serves the memoized result
 * without re-running the body, so no event is re-emitted.
 *
 * At-least-once caveat: if a turn's step *fails mid-stream* (before it commits)
 * the workflow retries the not-yet-memoized step and re-tees that turn's deltas
 * from scratch. This is the standard durable-step retry contract, not a replay
 * of a completed turn. Consumers should therefore reset/dedupe accumulated text
 * per `threadKey`+`turn` boundary so a step retry cannot visually double-append;
 * the persisted assistant message remains the single source of truth.
 * @experimental
 */
export type AgentTokenSink = (event: AgentLiveEvent) => void;

/**
 * The streaming LLM-turn seam: like {@link AgentGenerate} but tees each text
 * delta to `onDelta` as the model produces it, then resolves the SAME
 * {@link AgentGenerateResult} the non-streaming seam returns — so the value the
 * durable `llm:turn:N` step memoizes (and persists) is identical whether the
 * turn streamed or not. Production wires AI SDK `streamText`; tests inject a
 * script. Deltas are live-only — a workflow replay never re-invokes the seam.
 * @experimental
 */
export type AgentStreamGenerate = (options: AgentGenerateOptions, onDelta: (text: string) => void) => Promise<AgentGenerateResult>;

/**
 * Spec entry codegen emits per agent: `{ binding: "AGENT_SUPPORT", exportName: "support" }`.
 * @experimental
 */
export interface AgentBindingSpec {
    binding: string;
    exportName: string;

    /**
     * Whether the app author opted this agent into public run-starts (via
     * `defineAgent({ publicRun: true })`) — codegen emits it only when `true`.
     * Carried onto the {@link AgentHandle} so the public `agents:agentRun`
     * mutation gates on it fail-closed: an agent without it can be started only
     * from server-side app code, never by an external RPC client.
     */
    publicRun?: boolean;
}

/**
 * The lifecycle status stored on an agent thread: `"running"` while a run is in
 * flight, `"idle"` after it finishes (or stops on a condition), `"error"` on a
 * terminal failure, `"cancelled"` when a run was terminated via
 * {@link AgentHandle.cancel}, and `"awaiting_input"` while the run is paused on
 * a human-in-the-loop tool approval. Mirrored by the `status` `v.union` in
 * `component.ts`.
 * @experimental
 */
export type AgentThreadStatus = "awaiting_input" | "cancelled" | "error" | "idle" | "running";

/**
 * Structural subset of a Cloudflare Workflow instance the producer surface needs.
 * @experimental
 */
export interface AgentWorkflowInstanceLike {
    /** Deliver an external event to the running instance (resumes a `waitForEvent`). */
    sendEvent: (event: { payload: unknown; type: string }) => Promise<void>;
    status: () => Promise<unknown>;
    terminate: () => Promise<void>;
}

/**
 * Structural subset of a Cloudflare Workflow binding the producer surface needs.
 * @experimental
 */
export interface AgentWorkflowBindingLike {
    create: (options?: { id?: string; params?: unknown }) => Promise<{ id: string }>;
    get: (id: string) => Promise<AgentWorkflowInstanceLike>;
}

/**
 * A started agent run (a workflow instance).
 * @experimental
 */
export interface AgentRunHandle {
    /** The workflow instance id. */
    id: string;
}

/**
 * The `ctx.agents.<name>` producer handle.
 * @experimental
 */
export interface AgentHandle {
    /**
     * Cancel a run by its workflow instance id: terminate the instance and mark
     * its thread `"cancelled"`. Safe to call on an already-finished run.
     */
    cancel: (id: string) => Promise<void>;

    /**
     * Whether this agent may be started over the PUBLIC `agents:agentRun`
     * mutation (the `defineAgent({ publicRun: true })` opt-in, carried from the
     * codegen wiring spec). `false` by default — the run mutation refuses it
     * fail-closed, so declaring an agent never exposes it to arbitrary RPC
     * callers. Does not affect the server-side `run(...)` path below.
     */
    publicRun: boolean;
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
