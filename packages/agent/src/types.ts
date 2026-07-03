import type { FlexibleSchema, LanguageModel } from "ai";

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

export interface AgentConfig {
    /** System prompt prepended to every model call. */
    instructions?: string;
    /** Cost/step cap: maximum LLM turns per run. Default 8. */
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
    /** The tools the model may call, by name. */
    tools?: Record<string, AnyAgentTool>;
}

/** A `defineAgent` result — config plus the brand codegen discovers. */
export interface AgentDefinition extends AgentConfig {
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
    /** Why the run ended: a final answer or the `maxTurns` cap. */
    stopped: "final" | "maxTurns";
    /** The final assistant text (absent when stopped by `maxTurns`). */
    text?: string;
    /** LLM turns consumed. */
    turns: number;
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

/** One persisted thread message, as the loop reads it back. */
export interface AgentMessageRow {
    content: string;
    role: "assistant" | "system" | "tool" | "user";
    seq: number;
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
    text: string;
    toolCalls: ReadonlyArray<AgentToolCall>;
}

/**
 * The LLM-turn seam: given the assembled conversation, return the model's
 * decision. Production wires AI SDK `generateText`; tests inject a script.
 */
export type AgentGenerate = (options: { messages: ReadonlyArray<unknown> }) => Promise<AgentGenerateResult>;

/** Spec entry codegen emits per agent: `{ binding: "AGENT_SUPPORT", exportName: "support" }`. */
export interface AgentBindingSpec {
    binding: string;
    exportName: string;
}

/** Structural subset of a Cloudflare Workflow binding the producer surface needs. */
export interface AgentWorkflowBindingLike {
    create: (options?: { id?: string; params?: unknown }) => Promise<{ id: string }>;
    get: (id: string) => Promise<{ status: () => Promise<unknown> }>;
}

/** A started agent run (a workflow instance). */
export interface AgentRunHandle {
    /** The workflow instance id. */
    id: string;
}

/** The `ctx.agents.&lt;name>` producer handle. */
export interface AgentHandle {
    /** Start a durable agent run for a thread. */
    run: (input: AgentRunInput, options?: { id?: string }) => Promise<AgentRunHandle>;
    /** Read a run's workflow status by instance id. */
    status: (id: string) => Promise<unknown>;
}
