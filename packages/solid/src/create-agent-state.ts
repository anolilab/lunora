import type { FunctionReference } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createMemo } from "solid-js";

import type { MaybeAccessor } from "./create-agent";
import { resolveMaybe } from "./create-agent";
import { createSubscription } from "./create-subscription";

/**
 * The `agents.agentState` reference the primitive subscribes to for the thread's
 * live synced state. A structural subset of the generated `api.agents` surface
 * (like `CreateAgentApi` for `agentThread`), so the whole generated `api` object
 * is assignable. Client-safe: no `@lunora/agent` import — the per-agent state type
 * is mirrored by the primitive's generic `T`, since codegen pins the reference
 * return as an optional record (it never evaluates agent config).
 */
interface CreateAgentStateApi {
    agents: {
        agentState: FunctionReference<"query", { key: string }, Record<string, unknown> | undefined>;
    };
}

interface CreateAgentStateOptions {
    /** The generated `api` — its `agents.agentState` query drives live thread state. */
    api: CreateAgentStateApi;
    /** The thread whose synced state to observe — a plain value or accessor (an accessor re-subscribes on change). */
    threadKey: MaybeAccessor<string>;
}

interface CreateAgentStateResult<T> {
    /** The subscription error, if the live channel reported one. */
    error: Accessor<Error | undefined>;
    /** The live synced state, or `undefined` before it is seeded/first pushed. */
    state: Accessor<T | undefined>;
}

/**
 * Subscribe to an agent thread's synced state — the `setState`-style value a tool
 * writes with `ctx.setState(...)`, seeded by `defineAgent({ initialState })`. A
 * thin wrapper over `createSubscription(api.agents.agentState, { key })`: the
 * server pushes a fresh frame whenever the state changes (the dedicated query's
 * per-socket JSON memo suppresses no-op pushes on unrelated thread writes), so
 * `state` updates only on a real `setState`. The Solid counterpart to React's
 * `useAgentState`, re-expressed with signals.
 *
 * Generic over the app's state shape (`createAgentState` with a `SupportState`
 * type argument, itself a record) — the reference is typed as an optional record
 * because codegen cannot see the per-agent state type; the generic casts to `T`.
 * The `extends` bound (not a bare unbounded type parameter) is required so the
 * reference's optional-record return casts cleanly to `T`.
 */
const createAgentState = <T extends Record<string, unknown> = Record<string, unknown>>(options: CreateAgentStateOptions): CreateAgentStateResult<T> => {
    const { data, error } = createSubscription(options.api.agents.agentState, () => {
        return { key: resolveMaybe(options.threadKey) };
    });

    const state = createMemo(() => data() as T | undefined);

    return { error, state };
};

export type { CreateAgentStateApi, CreateAgentStateOptions, CreateAgentStateResult };
export { createAgentState };
