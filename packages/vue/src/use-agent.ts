import type { FunctionReference, SubscriptionErrorCallback } from "@lunora/client";
import type { ComputedRef, MaybeRefOrGetter, Ref } from "vue";
import { computed, toValue } from "vue";

import { useMutation } from "./use-mutation";
import { useSubscription } from "./use-subscription";

/**
 * The lifecycle status stored on an agent thread. Client-safe mirror of
 * `@lunora/agent`'s `AgentThreadStatus` — re-declared here (rather than imported)
 * so this Vue entry never pulls in the server-only `@lunora/agent` module graph
 * (the adapter stays Vue + `@lunora/client` only). Keep in sync with
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
 * The `agents.agentThread` reference the composable subscribes to for live thread
 * state (status + the in-flight `instanceId`). A structural subset of the
 * generated `api.agents` surface, so the whole generated `api` object is
 * assignable.
 */
interface UseAgentApi {
    agents: {
        agentThread: FunctionReference<"query", { key: string }, Record<string, unknown> | undefined>;
    };
}

interface UseAgentOptions {
    /** The generated `api` — its `agents.agentThread` query drives live thread state. */
    api: UseAgentApi;

    /**
     * Optional app mutation over the agent's cancel path
     * (`ctx.agents.<name>.cancel(id)`). Called with `{ instanceId, threadKey }`.
     * When omitted (or no run is in flight) {@link UseAgentResult.cancel} is a
     * no-op.
     */
    cancel?: FunctionReference<"mutation">;

    /**
     * Called when the live thread subscription reports an error (a session
     * expiry, an RLS denial). Without it — and without reading `error` — such a
     * failure is invisible and `thread` / `status` are cleared until a later frame arrives.
     */
    onError?: SubscriptionErrorCallback;

    /**
     * The app mutation that starts (or continues) a run — a thin wrapper over
     * `ctx.agents.<name>.run(...)`. Called with `{ threadKey, input }` merged with
     * {@link UseAgentOptions.runArgs} and the per-call args.
     */
    run: FunctionReference<"mutation">;
    /** Extra args merged into every `run` call (e.g. an `owner` or `title`). */
    runArgs?: Record<string, unknown>;
    /** The thread to observe and drive — may be a plain value, `ref`, or getter (a reactive source re-subscribes). */
    threadKey: MaybeRefOrGetter<string>;
}

interface UseAgentResult {
    /**
     * Terminate the in-flight run and mark its thread `"cancelled"`. Resolves as a
     * no-op when no `cancel` mutation was supplied or no run is in flight.
     */
    cancel: () => Promise<void>;
    /** The live thread subscription's last error, or `undefined`. */
    error: Ref<Error | undefined>;
    /** `true` while a `run` invocation is in flight. */
    pending: Readonly<Ref<boolean>>;
    /** Start (or continue) a run with a user message; extra args merge over `runArgs`. */
    run: (input: string, args?: Record<string, unknown>) => Promise<void>;
    /** The live thread status, or `undefined` before the thread exists. */
    status: ComputedRef<AgentThreadStatus | undefined>;
    /** The live thread record (status, `instanceId`, …), or `undefined` before it exists. */
    thread: ComputedRef<AgentThreadRecord | undefined>;
}

/**
 * A placeholder mutation reference so `useMutation` is called unconditionally even
 * when the caller supplies no `cancel` mutation. Its `__lunoraRef` is never
 * dispatched — `cancel()` short-circuits before invoking it unless a real
 * reference was provided.
 */
const NO_MUTATION_REF: FunctionReference<"mutation"> = { __lunoraRef: "" };

/**
 * A thin agent handle: live thread `status` plus `run` / `cancel`, without the
 * chat message surface. Composes `useSubscription(api.agents.agentThread)` for
 * live state and `useMutation` for the run/cancel writes — the Vue counterpart to
 * React's `useAgent`, re-expressed with refs. For the full conversation surface
 * (durable history + streaming + approvals) use `useAgentChat`.
 *
 * `run` and `cancel` stay generic over the app-defined mutations that wrap
 * `ctx.agents.<name>.run` / `.cancel`, so the composable hard-codes no function
 * names beyond the `agents:*` surface. `threadKey` may be reactive — a changing
 * key re-subscribes to the new thread.
 */
const useAgent = (options: UseAgentOptions): UseAgentResult => {
    const { api, cancel: cancelReference, onError, run: runReference, runArgs, threadKey } = options;

    const runMutation = useMutation(runReference);
    const cancelMutation = useMutation(cancelReference ?? NO_MUTATION_REF);
    const { data: threadData, error } = useSubscription(
        api.agents.agentThread,
        () => {
            return { key: toValue(threadKey) };
        },
        { onError },
    );

    const thread = computed(() => threadData.value as unknown as AgentThreadRecord | undefined);
    const status = computed(() => thread.value?.status);

    const run = async (input: string, arguments_?: Record<string, unknown>): Promise<void> => {
        await runMutation.mutate({ input, threadKey: toValue(threadKey), ...runArgs, ...arguments_ });
    };

    const cancel = async (): Promise<void> => {
        const instanceId = thread.value?.instanceId;

        // No cancel path, or no run to cancel — nothing to terminate.
        if (cancelReference === undefined || instanceId === undefined) {
            return;
        }

        await cancelMutation.mutate({ instanceId, threadKey: toValue(threadKey) });
    };

    return { cancel, error, pending: runMutation.pending, run, status, thread };
};

export type { AgentThreadRecord, AgentThreadStatus, UseAgentApi, UseAgentOptions, UseAgentResult };
export { NO_MUTATION_REF, useAgent };
