import type { AgentDefinition, AgentMemoryOptions, AgentMemorySource } from "./types";

/**
 * Whether a memory source is AUTO-INJECTED at run start (vs. driven by a minted
 * tool). Every `"graph"`- or `"episodic"`-kind source is injected — it traverses
 * / recalls the owner store per run and `mode` doesn't apply. A `"semantic"`
 * source is injected only in `"inject"` mode; its `"agentic"` mode mints a
 * `searchMemory` tool instead, so it is never one-shot injected.
 *
 * The single source of truth for that rule, shared by `defineAgent` (which folds
 * the injected sources into `agent.memorySources` up front) and the loop's
 * fallback for a directly-authored definition — so the two can never drift.
 */
const isInjectedMemorySource = (memory: AgentMemoryOptions): boolean => memory.kind === "graph" || memory.kind === "episodic" || memory.mode !== "agentic";

/**
 * The keyed memory sources the loop AUTO-INJECTS for a run. Prefer the list
 * `defineAgent` already folded (`agent.memorySources`); fall back to the agent's
 * own `memory` as the `"default"` source for a directly-authored definition,
 * filtered by {@link isInjectedMemorySource} so an `"agentic"`-mode semantic
 * memory is never wrongly injected.
 */
const resolveInjectedSources = (agent: AgentDefinition): ReadonlyArray<AgentMemorySource> => {
    if (agent.memorySources) {
        return agent.memorySources;
    }

    return agent.memory && isInjectedMemorySource(agent.memory) ? [{ key: "default", ...agent.memory }] : [];
};

/**
 * The first `"graph"`-kind injected source, if any — the write target for run-end
 * extraction. A graph source is always injected, so resolving over the injected
 * set finds it whether it was pre-folded or authored directly.
 */
const firstGraphSource = (agent: AgentDefinition): AgentMemorySource | undefined => resolveInjectedSources(agent).find((source) => source.kind === "graph");

/**
 * The first `"episodic"`-kind injected source, if any — the write target for the
 * run-end episode summary. An episodic source is always injected, so resolving
 * over the injected set finds it whether pre-folded or authored directly.
 */
const firstEpisodicSource = (agent: AgentDefinition): AgentMemorySource | undefined =>
    resolveInjectedSources(agent).find((source) => source.kind === "episodic");

/**
 * A memory durable-step name for a source: the bare `base` for the reserved
 * `"default"` source, `base:key` otherwise. The one place the step-name
 * convention lives — the `"default"` source keeps the historic bare name so
 * in-flight runs replay identically, and a keyed skill source gets its own
 * namespace.
 */
const memoryStepName = (base: string, key: string): string => (key === "default" ? base : `${base}:${key}`);

export { firstEpisodicSource, firstGraphSource, isInjectedMemorySource, memoryStepName, resolveInjectedSources };
