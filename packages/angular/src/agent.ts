import type { DestroyRef, Signal } from "@angular/core";
import { computed, signal } from "@angular/core";
import type { FunctionReference, LunoraClient, SubscriptionError, SubscriptionErrorCallback } from "@lunora/client";

import { resolveLunoraClient } from "./client";
import { subscription } from "./subscription";

/**
 * The lifecycle status stored on an agent thread. Client-safe mirror of
 * `@lunora/agent`'s `AgentThreadStatus` — re-declared here (rather than imported)
 * so this Angular entry never pulls in the server-only `@lunora/agent` module graph
 * (the adapter stays Angular + `@lunora/client` only). Keep in sync with
 * `packages/agent/src/types.ts`.
 * @experimental
 */
type AgentThreadStatus = "awaiting_input" | "cancelled" | "error" | "idle" | "running";

/**
 * The live thread record surfaced by the `agents:agentThread` query. A structural
 * subset of the persisted thread row — every field beyond `status` is optional so
 * the shape stays forgiving as the server schema grows. Keep in sync with the
 * `agent_threads` table in `packages/agent/src/component.ts`.
 * @experimental
 */
interface AgentThreadRecord {
    createdAt?: number;
    /** The failure message when `status === "error"`. */
    error?: string;
    /** The workflow instance id of the in-flight run — the handle `cancel` targets. */
    instanceId?: string;
    messageCount?: number;
    /** The verified thread owner, when the run was started with one. */
    owner?: string;
    status: AgentThreadStatus;
    title?: string;
    updatedAt?: number;
}

/**
 * One persisted (or optimistic) thread message, as `agents:agentMessages`
 * surfaces it. Client-safe mirror of `@lunora/agent`'s `AgentMessageRow` —
 * re-declared here (rather than imported) so this Angular entry never pulls in the
 * server-only `@lunora/agent` module graph. Keep in sync with the
 * `agent_messages` table in `packages/agent/src/component.ts`.
 * @experimental
 */
interface AgentChatMessage {
    content: string;
    createdAt?: number;

    /**
     * `true` for a client-side optimistic user message not yet acknowledged by
     * the server. Cleared once the durable history carries the matching user turn.
     */
    optimistic?: boolean;
    role: "assistant" | "system" | "tool" | "user";
    seq: number;
    /** Approval lifecycle marker on a human-in-the-loop tool message. */
    status?: "approved" | "awaiting_approval" | "rejected";
    toolCallId?: string;
    toolCalls?: ReadonlyArray<{ id: string; input: unknown; name: string }>;
    toolName?: string;
}

/**
 * A live token delta streamed while a turn is generating. Client-safe mirror of
 * `@lunora/agent`'s `AgentTokenDelta`. Ephemeral — deltas feed the chat surface's
 * streaming text live and are never replayed; the persisted assistant message
 * stays the single source of truth.
 * @experimental
 */
interface AgentTokenDelta {
    /** Discriminates the token arm of {@link AgentLiveEvent}; unset on the wire (token is the default). */
    kind?: "token";
    /** The incremental text chunk the model just produced. */
    text: string;
    /** The thread this delta belongs to. */
    threadKey: string;
    /** The zero-based index of the turn producing the delta. */
    turn: number;
}

/**
 * A live tool-progress event streamed via `ctx.reportProgress(...)`. Client-safe
 * mirror of `@lunora/agent`'s `AgentProgressEvent`. Ephemeral and `toolCallId`-keyed;
 * surfaced by `agentToolEvents`, ignored by the chat surface's streaming text.
 * @experimental
 */
interface AgentProgressEvent {
    /** The arbitrary, JSON-serializable payload the tool reported. */
    data: unknown;
    /** Discriminates the progress arm of {@link AgentLiveEvent}. */
    kind: "progress";
    /** The thread this event belongs to. */
    threadKey: string;
    /** The tool call this progress belongs to. */
    toolCallId: string;
}

/**
 * A single event on the agent's live-only channel — a streamed token delta or a
 * tool progress event. Client-safe mirror of `@lunora/agent`'s `AgentLiveEvent`.
 * Discriminate on `kind` (`"progress"` for the progress arm; token deltas leave
 * it unset).
 * @experimental
 */
type AgentLiveEvent = AgentProgressEvent | AgentTokenDelta;

/**
 * The `agents.agentThread` reference the primitive subscribes to for live thread
 * state (status + the in-flight `instanceId`). A structural subset of the
 * generated `api.agents` surface, so the whole generated `api` object is
 * assignable.
 * @experimental
 */
interface AgentApi {
    agents: {
        agentThread: FunctionReference<"query", { key: string }, Record<string, unknown> | undefined>;
    };
}

/**
 * `AgentOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
interface AgentOptions {
    /** The generated `api` — its `agents.agentThread` query drives live thread state. */
    api: AgentApi;

    /**
     * Optional app mutation over the agent's cancel path
     * (`ctx.agents.<name>.cancel(id)`). Called with `{ instanceId, threadKey }`.
     * When omitted (or no run is in flight) {@link AgentResult.cancel} is a no-op.
     */
    cancel?: FunctionReference<"mutation">;

    /** Client to bind to. Defaults to the injected `LUNORA_CLIENT`. */
    client?: LunoraClient;

    /**
     * `DestroyRef` whose `onDestroy` tears the live subscription down. Defaults to
     * `inject(DestroyRef)` — the calling component/service.
     */
    destroyRef?: DestroyRef;

    /**
     * Called when the live thread subscription reports an error (a session
     * expiry, an RLS denial). Without it — and without reading `error` — such a
     * failure is invisible and `thread` / `status` are cleared until a later frame arrives.
     */
    onError?: SubscriptionErrorCallback;

    /**
     * The app mutation that starts (or continues) a run — a thin wrapper over
     * `ctx.agents.<name>.run(...)`. Called with `{ threadKey, input }` merged with
     * {@link AgentOptions.runArgs} and the per-call args.
     */
    run: FunctionReference<"mutation">;
    /** Extra args merged into every `run` call (e.g. an `owner` or `title`). */
    runArgs?: Record<string, unknown>;
    /** The thread to observe and drive. */
    threadKey: string;
}

/**
 * `AgentResult` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
interface AgentResult {
    /**
     * Terminate the in-flight run and mark its thread `"cancelled"`. Resolves as a
     * no-op when no `cancel` mutation was supplied or no run is in flight.
     */
    cancel: () => Promise<void>;
    /** The live thread subscription's last error, or `undefined`. */
    error: Signal<SubscriptionError | undefined>;
    /** `true` while a `run` invocation is in flight. */
    pending: Signal<boolean>;
    /** Start (or continue) a run with a user message; extra args merge over `runArgs`. */
    run: (input: string, args?: Record<string, unknown>) => Promise<void>;
    /** The live thread status, or `undefined` before the thread exists. */
    status: Signal<AgentThreadStatus | undefined>;
    /** The live thread record (status, `instanceId`, …), or `undefined` before it exists. */
    thread: Signal<AgentThreadRecord | undefined>;
}

/**
 * A thin agent handle: live thread `status` plus `run` / `cancel`, without the
 * chat message surface. Composes `subscription(api.agents.agentThread)` for live
 * state and drives the run/cancel writes straight on the client — the Angular
 * counterpart to React's `useAgent`, re-expressed with signals. For the full
 * conversation surface (durable history + streaming + approvals) use `agentChat`.
 *
 * `run` and `cancel` stay generic over the app-defined mutations that wrap
 * `ctx.agents.<name>.run` / `.cancel`, so the primitive hard-codes no function
 * names beyond the `agents:*` surface.
 *
 * Call from an injection context (component/service field or constructor); pass an
 * explicit `client` / `destroyRef` to drive it outside one (e.g. in a test).
 * @experimental
 */
const agent = (options: AgentOptions): AgentResult => {
    const { api, cancel: cancelReference, onError, run: runReference, runArgs, threadKey } = options;

    const client = resolveLunoraClient(options.client);

    // Forward the caller's `destroyRef` verbatim (`undefined` when they are in an
    // injection context) rather than a resolved one: each child primitive then
    // injects its own and keeps its SSR platform gate, because an explicitly
    // passed `destroyRef` marks a manual-lifetime caller that drives the socket
    // itself and bypasses that gate (see `shouldOpenSubscription`).
    const { data: threadData, error } = subscription(api.agents.agentThread, { key: threadKey }, { client, destroyRef: options.destroyRef, onError });

    const thread = computed(() => threadData() as unknown as AgentThreadRecord | undefined);
    const status = computed(() => thread()?.status);

    const pending = signal(false);

    const run = async (input: string, arguments_?: Record<string, unknown>): Promise<void> => {
        pending.set(true);

        try {
            await client.mutation(runReference, { input, threadKey, ...runArgs, ...arguments_ });
        } finally {
            pending.set(false);
        }
    };

    const cancel = async (): Promise<void> => {
        const instanceId = thread()?.instanceId;

        // No cancel path, or no run to cancel — nothing to terminate.
        if (cancelReference === undefined || instanceId === undefined) {
            return;
        }

        await client.mutation(cancelReference, { instanceId, threadKey });
    };

    return { cancel, error, pending: pending.asReadonly(), run, status, thread };
};

export type {
    AgentApi,
    AgentChatMessage,
    AgentLiveEvent,
    AgentOptions,
    AgentProgressEvent,
    AgentResult,
    AgentThreadRecord,
    AgentThreadStatus,
    AgentTokenDelta,
};
export { agent };
