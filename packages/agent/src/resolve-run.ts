// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/dispatch is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { createDispatchRunner } from "@lunora/dispatch";

import type { AgentRunFunction } from "./types";

/**
 * Resolve the dispatcher the durable agent loop runs its `agents:*` function
 * calls through.
 *
 * The loop reads its own thread history + synced state back through the
 * owner-gated `agents:agentMessages` / `agents:agentState` queries. The default
 * workflow dispatcher (`context.run`) forwards NO identity, so on an OWNED
 * thread those reads come back as `[]` / `undefined` — the gate can't see the
 * caller — and the model answers blind to the very thread it just wrote. When
 * the run is owner-scoped, dispatch under that verified identity (mirrors the
 * voice DO's `resolveRun`) so the owner gate admits the loop's own reads; the
 * shard reconstructs the caller from the forwarded `x-lunora-userid`. An
 * ownerless (single-tenant / anonymous) run keeps the identity-free
 * `context.run` — its gate is already open. Thread writes are `asInternal` /
 * ungated, so forwarding the identity to them is inert.
 */
const resolveAgentRun = (contextRun: AgentRunFunction, owner: string | undefined, env: Record<string, unknown>): AgentRunFunction => {
    if (owner === undefined) {
        return contextRun;
    }

    return createDispatchRunner({ env, identity: { userId: owner }, label: "@lunora/agent" });
};

export default resolveAgentRun;
