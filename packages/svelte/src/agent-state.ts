import type { FunctionReference, LunoraClient } from "@lunora/client";
import type { Readable } from "svelte/store";
import { derived } from "svelte/store";

import { isClient } from "./agent";
import { getLunoraClient } from "./context";
import { subscription } from "./subscription";

/**
 * The `agents.agentState` reference the handle subscribes to for the thread's live
 * synced state. A structural subset of the generated `api.agents` surface (like
 * `AgentApi` for `agentThread`), so the whole generated `api` object is
 * assignable. Client-safe: no `@lunora/agent` import — the per-agent state type is
 * mirrored by the handle's generic `T`, since codegen pins the reference return as
 * an optional record (it never evaluates agent config).
 */
interface AgentStateApi {
    agents: {
        agentState: FunctionReference<"query", { key: string }, Record<string, unknown> | undefined>;
    };
}

interface AgentStateOptions {
    /** The generated `api` — its `agents.agentState` query drives live thread state. */
    api: AgentStateApi;
    /** The thread whose synced state to observe. */
    threadKey: string;
}

interface AgentStateHandle<T> {
    /** Svelte readable store of the subscription error, if the live channel reported one. Read with `$error`. */
    error: Readable<Error | undefined>;
    /** Svelte readable store of the live synced state, or `undefined` before it is seeded/first pushed. Read with `$state`. */
    state: Readable<T | undefined>;
}

/**
 * Subscribe to an agent thread's synced state — the `setState`-style value a tool
 * writes with `ctx.setState(...)`, seeded by `defineAgent({ initialState })`. A
 * thin wrapper over {@link subscription} against `api.agents.agentState`: the
 * server pushes a fresh frame whenever the state changes (the dedicated query's
 * per-socket JSON memo suppresses no-op pushes on unrelated thread writes), so
 * `state` updates only on a real `setState`. The Svelte counterpart to React's
 * `useAgentState`, re-expressed as stores you read with `$`.
 *
 * Generic over the app's state shape (`agentState<SupportState>(...)`, itself a
 * record) — the reference is typed as an optional record because codegen cannot
 * see the per-agent state type; the generic casts to `T`. The `state`/`error`
 * stores are lazy, so the subscription opens on the first subscriber to `state`
 * and tears down when the last one leaves — there is no `teardown` to call.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published by
 * `setLunoraClient`.
 */
export function agentState<T extends Record<string, unknown> = Record<string, unknown>>(options: AgentStateOptions): AgentStateHandle<T>;
export function agentState<T extends Record<string, unknown> = Record<string, unknown>>(client: LunoraClient, options: AgentStateOptions): AgentStateHandle<T>;
export function agentState<T extends Record<string, unknown> = Record<string, unknown>>(
    clientOrOptions: AgentStateOptions | LunoraClient,
    maybeOptions?: AgentStateOptions,
): AgentStateHandle<T> {
    const hasExplicitClient = isClient(clientOrOptions);
    const client = hasExplicitClient ? clientOrOptions : getLunoraClient();
    const options = (hasExplicitClient ? maybeOptions : clientOrOptions) as AgentStateOptions;

    const { data, error } = subscription(client, options.api.agents.agentState, { key: options.threadKey });
    const state = derived(data, (value) => value as T | undefined);

    return { error, state };
}

export type { AgentStateApi, AgentStateHandle, AgentStateOptions };
