import type { DestroyRef, Signal } from "@angular/core";
import { computed } from "@angular/core";
import type { FunctionReference, LunoraClient, SubscriptionError } from "@lunora/client";

import { subscription } from "./subscription";

/**
 * The `agents.agentState` reference the primitive subscribes to for the thread's
 * live synced state. A structural subset of the generated `api.agents` surface
 * (like `AgentApi` for `agentThread`), so the whole generated `api` object is
 * assignable. Client-safe: no `@lunora/agent` import — the per-agent state type is
 * mirrored by the primitive's generic `T`, since codegen pins the reference return
 * as an optional record (it never evaluates agent config).
 * @experimental
 */
interface AgentStateApi {
    agents: {
        agentState: FunctionReference<"query", { key: string }, Record<string, unknown> | undefined>;
    };
}

/**
 * `AgentStateOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
interface AgentStateOptions {
    /** The generated `api` — its `agents.agentState` query drives live thread state. */
    api: AgentStateApi;

    /** Client to bind to. Defaults to the injected `LUNORA_CLIENT`. */
    client?: LunoraClient;

    /**
     * `DestroyRef` whose `onDestroy` tears the subscription down. Defaults to
     * `inject(DestroyRef)` — the calling component/service.
     */
    destroyRef?: DestroyRef;
    /** The thread whose synced state to observe. */
    threadKey: string;
}

/**
 * `AgentStateResult` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
interface AgentStateResult<T> {
    /** The subscription error, if the live channel reported one. */
    error: Signal<SubscriptionError | undefined>;
    /** The live synced state, or `undefined` before it is seeded/first pushed. */
    state: Signal<T | undefined>;
}

/**
 * Subscribe to an agent thread's synced state — the `setState`-style value a tool
 * writes with `ctx.setState(...)`, seeded by `defineAgent({ initialState })`. A
 * thin wrapper over `subscription(api.agents.agentState, { key })`: the server
 * pushes a fresh frame whenever the state changes (the dedicated query's per-socket
 * JSON memo suppresses no-op pushes on unrelated thread writes), so `state` updates
 * only on a real `setState`. The Angular counterpart to React's `useAgentState`,
 * re-expressed with signals.
 *
 * Generic over the app's state shape (`agentState&lt;SupportState>(...)`, itself a
 * record) — the reference is typed as an optional record because codegen cannot see
 * the per-agent state type; the generic casts to `T`. The `extends` bound (not a
 * bare unbounded type parameter) is required: this `.ts` file is parsed JSX-aware by
 * the bundler, where an unbounded type-param arrow is ambiguous with a JSX element.
 *
 * Call from an injection context (component/service field or constructor); pass an
 * explicit `client` / `destroyRef` to drive it outside one (e.g. in a test).
 * @experimental
 */
const agentState = <T extends Record<string, unknown> = Record<string, unknown>>(options: AgentStateOptions): AgentStateResult<T> => {
    const { data, error } = subscription(options.api.agents.agentState, { key: options.threadKey }, { client: options.client, destroyRef: options.destroyRef });

    const state = computed(() => data() as T | undefined);

    return { error, state };
};

export type { AgentStateApi, AgentStateOptions, AgentStateResult };
export { agentState };
