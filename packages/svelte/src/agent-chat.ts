import type { FunctionReference, LunoraClient, OptimisticMessage, SubscriptionErrorCallback } from "@lunora/client";
import { maxSeq, reconcileOptimistic } from "@lunora/client";
import type { Readable } from "svelte/store";
import { writable } from "svelte/store";

import { isBrowser } from "../../../shared/is-browser";
import type { AgentThreadRecord, AgentThreadStatus } from "./agent";
import { isClient, NO_MUTATION_REF } from "./agent";
import { getLunoraClient } from "./context";
import { mutation } from "./mutation";
import { stream } from "./stream";

/**
 * One persisted (or optimistic) thread message, as `agents:agentMessages`
 * surfaces it. Client-safe mirror of `@lunora/agent`'s `AgentMessageRow` —
 * re-declared here (rather than imported) so this Svelte entry never pulls in the
 * server-only `@lunora/agent` module graph. Keep in sync with the
 * `agent_messages` table in `packages/agent/src/component.ts`.
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
 * `@lunora/agent`'s `AgentTokenDelta`. Ephemeral — deltas feed
 * {@link AgentChatHandle.streamingText} live and are never replayed; the
 * persisted assistant message stays the single source of truth.
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
 * surfaced by `agentToolEvents`, ignored by {@link AgentChatHandle.streamingText}.
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
 */
type AgentLiveEvent = AgentProgressEvent | AgentTokenDelta;

/** The `agents:agentMessages` reference — live durable thread history. */
type AgentMessagesReference = FunctionReference<"query", { key: string; limit?: number }, ReadonlyArray<Record<string, unknown>>>;

/** The `agents:agentResolveApproval` reference — resolves a human-in-the-loop tool approval. */
type AgentApprovalReference = FunctionReference<
    "mutation",
    { decision: "approve" | "reject"; instanceId: string; note?: string; threadKey: string; toolCallId: string },
    { resolved: boolean }
>;

/** The `agents:agentThread` reference — live thread status + in-flight `instanceId`. */
type AgentThreadReference = FunctionReference<"query", { key: string }, Record<string, unknown> | undefined>;

/**
 * An app stream reference that tees the agent's in-flight live events, keyed by
 * thread. Carries token deltas and — since `ctx.reportProgress` rides the same
 * sink — tool progress events; this handle consumes only the token arm.
 */
type AgentTokenStreamReference = FunctionReference<"stream", { key: string }, AgentLiveEvent>;

/**
 * The `agents.*` reference surface the chat handle reads. A structural subset of
 * the generated `api.agents`, so the whole generated `api` object is assignable.
 */
interface AgentChatApi {
    agents: {
        agentMessages: AgentMessagesReference;
        agentResolveApproval: AgentApprovalReference;
        agentThread: AgentThreadReference;
    };
}

interface AgentChatOptions {
    /** The generated `api` — its `agents.*` surface provides history, thread state, and approval resolution. */
    api: AgentChatApi;

    /**
     * Optional app mutation over the agent's cancel path
     * (`ctx.agents[name].cancel(id)`). Called with `{ instanceId, threadKey }`.
     * When omitted (or no run is in flight) {@link AgentChatHandle.cancel} is a
     * no-op.
     */
    cancel?: FunctionReference<"mutation">;
    /** History depth forwarded to `agents:agentMessages`. */
    limit?: number;

    /**
     * Called when the live history or thread subscription reports an error (a
     * session expiry, an RLS denial). Without it such an error is dropped and
     * `messages` / `status` freeze at their last value.
     */
    onError?: SubscriptionErrorCallback;

    /**
     * The app mutation that starts (or continues) a run — a thin wrapper over
     * `ctx.agents[name].run(...)`. Called with `{ threadKey, input }` merged with
     * {@link AgentChatOptions.sendArgs} and the per-call args.
     */
    send: FunctionReference<"mutation">;
    /** Extra args merged into every `send` call (e.g. an `owner` or `title`). */
    sendArgs?: Record<string, unknown>;

    /**
     * Optional live token-delta stream — an app stream function that tees the
     * agent's in-flight deltas. When omitted {@link AgentChatHandle.streamingText}
     * stays empty and the UI updates message-by-message from durable history.
     */
    stream?: AgentTokenStreamReference;
    /** The thread to observe and continue. */
    threadKey: string;
}

interface AgentChatHandle {
    /** Approve a paused human-in-the-loop tool call (optionally with a note). */
    approve: (toolCallId: string, note?: string) => Promise<void>;

    /**
     * Terminate the in-flight run and mark its thread `"cancelled"`. Resolves as a
     * no-op when no `cancel` mutation was supplied or no run is in flight.
     */
    cancel: () => Promise<void>;
    /** Durable thread history (oldest first) plus any un-acknowledged optimistic user turns. Read with `$messages`. */
    messages: Readable<ReadonlyArray<AgentChatMessage>>;
    /** Reject a paused human-in-the-loop tool call (optionally with a reason). */
    reject: (toolCallId: string, note?: string) => Promise<void>;
    /** Start (or continue) a run with a user message; extra args merge over `sendArgs`. Appends an optimistic user turn. */
    send: (input: string, args?: Record<string, unknown>) => Promise<void>;
    /** The live thread status, or `undefined` before the thread exists. Read with `$status`. */
    status: Readable<AgentThreadStatus | undefined>;

    /**
     * The in-flight turn's streamed text — live-only, `""` once the turn persists
     * to `messages`. Populated when a `stream` reference is supplied (via the
     * {@link stream} primitive); with no reference it stays `""` and the UI advances
     * message-by-message from durable history. Read with `$streamingText`.
     */
    streamingText: Readable<string>;

    /**
     * Stop the live history + thread subscriptions (and the token stream, if any).
     * Call in `onDestroy` (`onDestroy(handle.teardown)`).
     */
    teardown: () => void;
}

/**
 * A placeholder stream reference so {@link stream} is opened unconditionally even
 * when the caller supplies no token stream. Paired with `"skip"` args, it never
 * opens a stream.
 */
const NO_STREAM_REF: AgentTokenStreamReference = { __lunoraRef: "" };

const createAgentChatHandle = (client: LunoraClient, options: AgentChatOptions): AgentChatHandle => {
    const { api, cancel: cancelReference, limit, onError, send: sendReference, sendArgs, stream: streamReference, threadKey } = options;

    const sendMutation = mutation(client, sendReference);
    const cancelMutation = mutation(client, cancelReference ?? NO_MUTATION_REF);
    const approvalMutation = mutation(client, api.agents.agentResolveApproval);

    // Latest server state kept in closures so the action closures read it
    // synchronously; the stores below drive reactive reads.
    let latestThread: AgentThreadRecord | undefined;
    let durable: ReadonlyArray<AgentChatMessage> = [];
    let optimistic: ReadonlyArray<OptimisticMessage> = [];
    // The live token/progress events from the current stream, kept in a closure so
    // `recomputeStreamingText` reads them synchronously alongside `durable`.
    let liveEvents: ReadonlyArray<AgentLiveEvent> = [];
    // A monotonic id source for optimistic rows — handle-instance local.
    let nextId = 0;

    const messagesStore = writable<ReadonlyArray<AgentChatMessage>>([]);
    const statusStore = writable<AgentThreadStatus | undefined>();
    const streamingTextStore = writable("");

    // Merge durable history with the optimistic user turns the server hasn't
    // acknowledged yet, and publish to the messages store.
    const recompute = (): void => {
        const visible = reconcileOptimistic(optimistic, durable);

        if (visible.length === 0) {
            messagesStore.set(durable);

            return;
        }

        // Base synthetic seqs above the highest real durable seq (not just
        // `durable.length`, which can under-count when durable rows have gaps) so
        // an optimistic row's placeholder seq never collides with a real one.
        const maxDurableSeq = maxSeq(durable);

        messagesStore.set([
            ...durable,
            ...visible.map<AgentChatMessage>((pending, index) => {
                return {
                    content: pending.content,
                    optimistic: true,
                    role: "user",
                    seq: maxDurableSeq + 1 + index,
                };
            }),
        ]);
    };

    // The in-flight turn is the one whose assistant message hasn't persisted yet:
    // each completed turn persists exactly one assistant row, so `turn >= <count of
    // durable assistant rows>` isolates deltas that have NOT been superseded. Once
    // the turn's message lands the count advances and its deltas fall away — the
    // persisted message becomes the source of truth. Token deltas only — progress
    // events (`kind === "progress"`) ride the same stream but carry no turn text;
    // `agentToolEvents` surfaces those. Recomputed on every stream chunk AND every
    // history change (the assistant count is the retire gate).
    const recomputeStreamingText = (): void => {
        const assistantCount = durable.filter((message) => message.role === "assistant").length;
        const text = liveEvents
            .filter((event): event is AgentTokenDelta => event.kind !== "progress" && event.threadKey === threadKey && event.turn >= assistantCount)
            .map((delta) => delta.text)
            .join("");

        streamingTextStore.set(text);
    };

    // The subscriptions below are client-only side effects: a component's init
    // can run server-side (this package pairs with `@lunora/nuxt`'s server
    // rendering) with no `window`, and opening a live WS subscription there
    // would fire during `renderToString` with no corresponding `onDestroy` to
    // close it — every server render would leak a subscription (SVELTE-01,
    // mirrors the `presence.ts` guard). Skip them server-side; `messages`/
    // `status`/`streamingText` stay at their inert initial values until the
    // component hydrates and `teardown` becomes a no-op.

    // The token stream is optional: with no reference we pass the sentinel + "skip"
    // so `stream` never opens a stream (and `streamingText` stays empty). Subscribed
    // eagerly (matching the history/thread subscriptions) so the stream opens with
    // the handle and closes on `teardown` — but only in the browser; `stream(...)`'s
    // `chunks` store opens the underlying stream on its first subscriber, so calling
    // it unconditionally here would open (and leak) a live stream during SSR too.
    const streamArguments = streamReference === undefined ? "skip" : { key: threadKey };
    const unsubscribeStream = isBrowser()
        ? stream(client, streamReference ?? NO_STREAM_REF, streamArguments).chunks.subscribe((value) => {
              liveEvents = value;
              recomputeStreamingText();
          })
        : (): void => undefined;

    const historyArgs = limit === undefined ? { key: threadKey } : { key: threadKey, limit };
    const unsubscribeHistory = isBrowser()
        ? client.subscribe(
              api.agents.agentMessages,
              historyArgs,
              (value) => {
                  durable = value as unknown as ReadonlyArray<AgentChatMessage>;
                  recompute();
                  recomputeStreamingText();
              },
              { onError },
          )
        : (): void => undefined;
    const unsubscribeThread = isBrowser()
        ? client.subscribe(
              api.agents.agentThread,
              { key: threadKey },
              (value) => {
                  latestThread = value as AgentThreadRecord | undefined;
                  statusStore.set(latestThread?.status);
              },
              { onError },
          )
        : (): void => undefined;

    const send = async (input: string, arguments_?: Record<string, unknown>): Promise<void> => {
        const id = nextId;

        nextId += 1;

        // Capture the reconcile baseline: the highest durable `seq` present now, so
        // only a matching user row that lands AFTER this send retires the row.
        const maxDurableSeqAtSend = maxSeq(durable);

        // Prune already-acknowledged optimistic rows as we add the new one, so the
        // list stays bounded, then reflect it immediately.
        optimistic = [...reconcileOptimistic(optimistic, durable), { content: input, id, maxDurableSeqAtSend }];
        recompute();

        try {
            await sendMutation.mutate({ input, threadKey, ...sendArgs, ...arguments_ });
        } catch (error) {
            // The mutation never landed, so no durable user turn will ever
            // reconcile this optimistic row away — drop it by id so a failed
            // send doesn't leave a permanent ghost message, then rethrow so
            // the caller can surface the failure.
            optimistic = optimistic.filter((pending) => pending.id !== id);
            recompute();

            throw error;
        }
    };

    const resolveApproval = async (decision: "approve" | "reject", toolCallId: string, note?: string): Promise<void> => {
        const instanceId = latestThread?.instanceId;

        if (instanceId === undefined) {
            throw new Error(`agentChat: cannot ${decision} — no in-flight run (thread has no instanceId)`);
        }

        await approvalMutation.mutate({ decision, instanceId, threadKey, toolCallId, ...(note === undefined ? {} : { note }) });
    };

    const approve = async (toolCallId: string, note?: string): Promise<void> => resolveApproval("approve", toolCallId, note);

    const reject = async (toolCallId: string, note?: string): Promise<void> => resolveApproval("reject", toolCallId, note);

    const cancel = async (): Promise<void> => {
        const instanceId = latestThread?.instanceId;

        // No cancel path, or no run to cancel — nothing to terminate.
        if (cancelReference === undefined || instanceId === undefined) {
            return;
        }

        await cancelMutation.mutate({ instanceId, threadKey });
    };

    const teardown = (): void => {
        unsubscribeHistory();
        unsubscribeThread();
        // Drops the last subscriber, so the stream store's stop callback cancels
        // the underlying stream.
        unsubscribeStream();
    };

    return {
        approve,
        cancel,
        messages: { subscribe: messagesStore.subscribe },
        reject,
        send,
        status: { subscribe: statusStore.subscribe },
        streamingText: { subscribe: streamingTextStore.subscribe },
        teardown,
    };
};

/**
 * A first-class agent chat surface: live durable history + in-flight token
 * streaming + the send / approve / reject / cancel writes, keyed by `threadKey` —
 * the Svelte counterpart to React's `useAgentChat`, re-expressed as stores you
 * read with `$`.
 *
 * It composes the existing primitives rather than adding transport:
 * `client.subscribe(api.agents.agentMessages)` for durable history,
 * `client.subscribe(api.agents.agentThread)` for live status + the in-flight
 * `instanceId`, {@link stream} over an app token stream for in-flight deltas, and
 * {@link mutation} for the writes (`api.agents.agentResolveApproval` for approvals;
 * app-defined wrappers for `send`/`cancel`). Only the `agents:*` surface is
 * hard-coded — `send`/`cancel`/`stream` stay generic references.
 *
 * A `send` optimistically appends the user turn so it renders immediately; the
 * optimistic row clears once the durable history carries the acknowledged turn.
 * `streamingText` is live-only: it holds the current turn's streamed text and
 * empties as soon as that turn's assistant message lands in `messages` (the
 * persisted message is the source of truth); with no `stream` reference it stays
 * `""` and the UI advances message-by-message from durable history. The
 * subscriptions (and the token stream, if any) open eagerly and run until
 * {@link AgentChatHandle.teardown} — call `onDestroy(handle.teardown)`.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published by
 * `setLunoraClient`.
 */
export function agentChat(options: AgentChatOptions): AgentChatHandle;
export function agentChat(client: LunoraClient, options: AgentChatOptions): AgentChatHandle;
export function agentChat(clientOrOptions: AgentChatOptions | LunoraClient, maybeOptions?: AgentChatOptions): AgentChatHandle {
    const hasExplicitClient = isClient(clientOrOptions);
    const client = hasExplicitClient ? clientOrOptions : getLunoraClient();
    const options = (hasExplicitClient ? maybeOptions : clientOrOptions) as AgentChatOptions;

    return createAgentChatHandle(client, options);
}

export type { AgentChatApi, AgentChatHandle, AgentChatMessage, AgentChatOptions, AgentLiveEvent, AgentProgressEvent, AgentTokenDelta };
