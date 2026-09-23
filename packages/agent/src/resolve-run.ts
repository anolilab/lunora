// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/dispatch is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { createDispatchRunner } from "@lunora/dispatch";

import type { AgentRunFunction } from "./types";

/**
 * Build the dispatcher the durable agent loop runs its `agents:*` function
 * calls through. Deliberately the package's OWN runner rather than the
 * workflow's `context.run`, for two independent reasons.
 *
 * **Identity.** The loop reads its own thread history + synced state back
 * through the owner-gated `agents:agentMessages` / `agents:agentState` queries.
 * `context.run` forwards NO identity, so on an OWNED thread those reads come
 * back as `[]` / `undefined` — the gate can't see the caller — and the model
 * answers blind to the very thread it just wrote. When the run is owner-scoped,
 * dispatch under that verified identity (mirrors the voice DO's `resolveRun`)
 * so the owner gate admits the loop's own reads; the shard reconstructs the
 * caller from the forwarded `x-lunora-userid`. Thread writes are `asInternal` /
 * ungated, so forwarding the identity to them is inert.
 *
 * **Replay-dedup ids.** `context.run` numbers the calls a workflow body makes
 * (`<instanceId>#body.<n>`) and sends that as the shard's replay-dedup
 * `mutationId`. That numbering is only replay-stable for a body that issues
 * the same calls in the same order on every activation — and this loop does
 * not: most of its dispatches sit inside memoized `step.do` callbacks
 * (`llm:turn:N` reads the history, a tool's `execute` dispatches its own
 * calls), which a replay serves from the journal without re-invoking. Every
 * skipped call shifts the counter, so the next activation hands an id the
 * FIRST one already committed to a different call — and the shard's dedup
 * table, keyed `(identity, mutationId)` with no function path in it, answers
 * with that call's cached result and never runs the handler. A resumed run
 * then reads `{ seq }` where its thread history belongs.
 *
 * So the loop dispatches WITHOUT a dedup id, i.e. at-least-once. What makes
 * that safe is that every function it calls is idempotent on its own key
 * rather than on the dispatch's: `agentAppendMessage` dedupes on the
 * instance-scoped `messageKey` (unique index), `agentEnsureThread` is a
 * get-or-create, `agentCompleteRun` guards on instance ownership,
 * `agentPatchThread` / `agentSetState` write absolute values, and the memory
 * upserts dedupe on a unique key and bump weights with `Math.max`. A new
 * dispatch added to the loop must hold that same property — a dedup id cannot
 * be bolted on later without a key that survives a replay of a body whose call
 * order does not.
 *
 * **`fetchImpl`.** Building our own runner also means the host's injected
 * `fetch` does not come along for free: `createDispatchRunner` falls back to the
 * global, which is the WRONG transport on a host that injected one and no
 * transport at all where there is none — the loop then throws a bare `TypeError`
 * before its first dispatch. The workflow context re-exposes what it was given
 * (`ctx.fetchImpl`) and the caller threads it through here.
 */
const resolveAgentRun = (owner: string | undefined, env: Record<string, unknown>, fetchImpl?: typeof fetch): AgentRunFunction =>
    createDispatchRunner({
        env,
        label: "@lunora/agent",
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(owner === undefined ? {} : { identity: { userId: owner } }),
    });

export default resolveAgentRun;
