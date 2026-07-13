import type { FunctionReference } from "@lunora/client";
import type { ComputedRef, MaybeRefOrGetter, Ref } from "vue";
import { computed, toValue } from "vue";

import { useSubscription } from "./use-subscription";

/**
 * The `agents.agentState` reference the composable subscribes to for the thread's
 * live synced state. A structural subset of the generated `api.agents` surface
 * (like `UseAgentApi` for `agentThread`), so the whole generated `api` object is
 * assignable. Client-safe: no `@lunora/agent` import — the per-agent state type is
 * mirrored by the composable's generic `T`, since codegen pins the reference
 * return as an optional record (it never evaluates agent config).
 */
interface UseAgentStateApi {
    agents: {
        agentState: FunctionReference<"query", { key: string }, Record<string, unknown> | undefined>;
    };
}

interface UseAgentStateOptions {
    /** The generated `api` — its `agents.agentState` query drives live thread state. */
    api: UseAgentStateApi;
    /** The thread whose synced state to observe — may be a plain value, `ref`, or getter (a reactive source re-subscribes). */
    threadKey: MaybeRefOrGetter<string>;
}

interface UseAgentStateResult<T> {
    /** The subscription error, if the live channel reported one. */
    error: Ref<Error | undefined>;
    /** The live synced state, or `undefined` before it is seeded/first pushed. */
    state: ComputedRef<T | undefined>;
}

/**
 * Subscribe to an agent thread's synced state — the `setState`-style value a tool
 * writes with `ctx.setState(...)`, seeded by `defineAgent({ initialState })`. A
 * thin wrapper over `useSubscription(api.agents.agentState, { key })`: the server
 * pushes a fresh frame whenever the state changes (the dedicated query's
 * per-socket JSON memo suppresses no-op pushes on unrelated thread writes), so
 * `state` updates only on a real `setState`. The Vue counterpart to React's
 * `useAgentState`, re-expressed with refs.
 *
 * Generic over the app's state shape (`useAgentState` with a `SupportState` type
 * argument, itself a record) — the reference is typed as an optional record
 * because codegen cannot see the per-agent state type; the generic casts to `T`.
 * The `extends` bound (not
 * a bare unbounded type parameter) is required: this `.ts` file is parsed
 * JSX-aware by the bundler, where an unbounded type-param arrow is ambiguous with
 * a JSX element.
 */
const useAgentState = <T extends Record<string, unknown> = Record<string, unknown>>(options: UseAgentStateOptions): UseAgentStateResult<T> => {
    const { data, error } = useSubscription(options.api.agents.agentState, () => {
        return { key: toValue(options.threadKey) };
    });

    const state = computed(() => data.value as T | undefined);

    return { error, state };
};

export type { UseAgentStateApi, UseAgentStateOptions, UseAgentStateResult };
export { useAgentState };
