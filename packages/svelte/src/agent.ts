import type { FunctionReference, LunoraClient, SubscriptionErrorCallback } from "@lunora/client";
import type { Readable } from "svelte/store";
import { writable } from "svelte/store";

import { isBrowser } from "../../../shared/is-browser";
import { getLunoraClient } from "./context";
import { mutation } from "./mutation";

/**
 * The lifecycle status stored on an agent thread. Client-safe mirror of
 * `@lunora/agent`'s `AgentThreadStatus` — re-declared here (rather than imported)
 * so this Svelte entry never pulls in the server-only `@lunora/agent` module graph
 * (the adapter stays Svelte + `@lunora/client` only). Keep in sync with
 * `packages/agent/src/types.ts`.
 */
type AgentThreadStatus = "awaiting_input" | "cancelled" | "error" | "idle" | "running";

/**
 * The live thread record surfaced by the `agents:agentThread` query. A structural
 * subset of the persisted thread row — every field beyond `status` is optional so
 * the shape stays forgiving as the server schema grows. Keep in sync with the
 * `agent_threads` table in `packages/agent/src/component.ts`.
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
 * The `agents.agentThread` reference the handle subscribes to for live thread
 * state (status + the in-flight `instanceId`). A structural subset of the
 * generated `api.agents` surface, so the whole generated `api` object is
 * assignable.
 */
interface AgentApi {
    agents: {
        agentThread: FunctionReference<"query", { key: string }, Record<string, unknown> | undefined>;
    };
}

interface AgentOptions {
    /** The generated `api` — its `agents.agentThread` query drives live thread state. */
    api: AgentApi;

    /**
     * Optional app mutation over the agent's cancel path
     * (`ctx.agents[name].cancel(id)`). Called with `{ instanceId, threadKey }`.
     * When omitted (or no run is in flight) {@link AgentHandle.cancel} is a no-op.
     */
    cancel?: FunctionReference<"mutation">;

    /**
     * Called when the live thread subscription reports an error (a session
     * expiry, an RLS denial). Without it such an error is dropped and `thread` /
     * `status` freeze at their last value.
     */
    onError?: SubscriptionErrorCallback;

    /**
     * The app mutation that starts (or continues) a run — a thin wrapper over
     * `ctx.agents[name].run(...)`. Called with `{ threadKey, input }` merged with
     * {@link AgentOptions.runArgs} and the per-call args.
     */
    run: FunctionReference<"mutation">;
    /** Extra args merged into every `run` call (e.g. an `owner` or `title`). */
    runArgs?: Record<string, unknown>;
    /** The thread to observe and drive. */
    threadKey: string;
}

interface AgentHandle {
    /**
     * Terminate the in-flight run and mark its thread `"cancelled"`. Resolves as a
     * no-op when no `cancel` mutation was supplied or no run is in flight.
     */
    cancel: () => Promise<void>;
    /** `true` while a `run` invocation is in flight. Read with `$pending`. */
    pending: Readable<boolean>;
    /** Start (or continue) a run with a user message; extra args merge over `runArgs`. */
    run: (input: string, args?: Record<string, unknown>) => Promise<void>;
    /** The live thread status, or `undefined` before the thread exists. Read with `$status`. */
    status: Readable<AgentThreadStatus | undefined>;

    /**
     * Stop the live thread subscription. Call in `onDestroy`
     * (`onDestroy(handle.teardown)`).
     */
    teardown: () => void;
    /** The live thread record (status, `instanceId`, …), or `undefined` before it exists. Read with `$thread`. */
    thread: Readable<AgentThreadRecord | undefined>;
}

/**
 * A placeholder mutation reference so {@link mutation} is called unconditionally
 * even when the caller supplies no `cancel` mutation. Its `__lunoraRef` is never
 * dispatched — `cancel()` short-circuits before invoking it unless a real
 * reference was provided.
 */
const NO_MUTATION_REF: FunctionReference<"mutation"> = { __lunoraRef: "" };

/** Narrow the overloaded first argument: an explicit {@link LunoraClient} carries a `subscribe` method. */
const isClient = (value: unknown): value is LunoraClient =>
    typeof value === "object" && value !== null && typeof (value as { subscribe?: unknown }).subscribe === "function";

const createAgentHandle = (client: LunoraClient, options: AgentOptions): AgentHandle => {
    const { api, cancel: cancelReference, onError, run: runReference, runArgs, threadKey } = options;

    const runMutation = mutation(client, runReference);
    const cancelMutation = mutation(client, cancelReference ?? NO_MUTATION_REF);

    // Keep the latest thread in a closure so the action closures below read the
    // in-flight `instanceId` synchronously (the store is for reactive reads).
    let latestThread: AgentThreadRecord | undefined;
    const threadStore = writable<AgentThreadRecord | undefined>();
    const statusStore = writable<AgentThreadStatus | undefined>();

    // Client-only: a component's init can run server-side (this package pairs
    // with `@lunora/nuxt`'s server rendering) with no `window`, and opening a
    // live WS subscription there would fire during `renderToString` with no
    // corresponding `onDestroy` to close it (SVELTE-01, mirrors the
    // `presence.ts`/`agent-chat.ts` guard). Skip it server-side; `thread`/
    // `status` stay at their inert initial values until the component hydrates.
    const unsubscribe = isBrowser()
        ? client.subscribe(
              api.agents.agentThread,
              { key: threadKey },
              (value) => {
                  latestThread = value as AgentThreadRecord | undefined;
                  threadStore.set(latestThread);
                  statusStore.set(latestThread?.status);
              },
              { onError },
          )
        : (): void => undefined;

    const run = async (input: string, arguments_?: Record<string, unknown>): Promise<void> => {
        await runMutation.mutate({ input, threadKey, ...runArgs, ...arguments_ });
    };

    const cancel = async (): Promise<void> => {
        const instanceId = latestThread?.instanceId;

        // No cancel path, or no run to cancel — nothing to terminate.
        if (cancelReference === undefined || instanceId === undefined) {
            return;
        }

        await cancelMutation.mutate({ instanceId, threadKey });
    };

    const teardown = (): void => {
        unsubscribe();
    };

    return {
        cancel,
        pending: runMutation.pending,
        run,
        status: { subscribe: statusStore.subscribe },
        teardown,
        thread: { subscribe: threadStore.subscribe },
    };
};

/**
 * A thin agent handle: live thread `status` plus `run` / `cancel`, without the
 * chat message surface — the Svelte counterpart to React's `useAgent`,
 * re-expressed as stores you read with `$`. Composes `client.subscribe` for live
 * thread state and {@link mutation} for the run/cancel writes. For the full
 * conversation surface (durable history + approvals) use `agentChat`.
 *
 * `run` and `cancel` stay generic over the app-defined mutations that wrap
 * `ctx.agents[name].run` / `.cancel`, so the handle hard-codes no function names
 * beyond the `agents:*` surface. The subscription opens eagerly on the call and
 * runs until {@link AgentHandle.teardown} — call `onDestroy(handle.teardown)`.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published by
 * `setLunoraClient`.
 */
export function agent(options: AgentOptions): AgentHandle;
export function agent(client: LunoraClient, options: AgentOptions): AgentHandle;
export function agent(clientOrOptions: AgentOptions | LunoraClient, maybeOptions?: AgentOptions): AgentHandle {
    const hasExplicitClient = isClient(clientOrOptions);
    const client = hasExplicitClient ? clientOrOptions : getLunoraClient();
    const options = (hasExplicitClient ? maybeOptions : clientOrOptions) as AgentOptions;

    return createAgentHandle(client, options);
}

export type { AgentApi, AgentHandle, AgentOptions, AgentThreadRecord, AgentThreadStatus };
export { isClient, NO_MUTATION_REF };
