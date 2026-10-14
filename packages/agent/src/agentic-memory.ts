import { jsonSchema } from "ai";

import { toFunctionReference } from "./paths";
import type { AgentConfig, AgentFunctionReference, AgentMemorySource, AgentToolDefinition, AnyAgentTool, SkillDefinition } from "./types";

/** Per-hit snippet truncation when a source doesn't set `snippetChars`. */
const DEFAULT_SNIPPET_CHARS = 240;

/**
 * Hard ceiling on a model-supplied `topK` for a minted `searchMemory` tool. The
 * model picks `topK` mid-reasoning, so an unbounded value would let it request
 * an arbitrarily large (token-expensive) retrieval; clamp to a sane maximum. An
 * author's configured `topK` is trusted and NOT capped here.
 */
const MAX_SEARCH_TOPK = 50;

/**
 * Input the model provides to a minted `searchMemory` tool.
 * @experimental
 */
interface AgentMemorySearchInput {
    /** The natural-language query. */
    query: string;
    /** Per-call retrieval depth (overrides the source's configured `topK`). */
    topK?: number;
}

/**
 * Input the model provides to a minted `readMemory` tool.
 * @experimental
 */
interface AgentMemoryReadInput {
    /** The chunk/document id from a `searchMemory` hit. */
    id: string;
}

/**
 * One ranked hit in a {@link AgentMemorySearchResult}.
 * @experimental
 */
interface AgentMemorySearchHit {
    id: string;
    score: number;
    /** The chunk text, truncated to the source's `snippetChars`. */
    snippet: string;
    sourceId: string;
}

/**
 * The compact shape a minted `searchMemory` tool returns to the model: ranked
 * hits plus deduped source refs, with the giant joined `.context` string
 * DROPPED — the model reads snippets and decides what (if anything) to pull with
 * `readMemory`, which is the whole point of agentic (vs inject) retrieval.
 * @experimental
 */
interface AgentMemorySearchResult {
    results: AgentMemorySearchHit[];
    sources: ReadonlyArray<unknown>;
}

/** Structural subset of `@lunora/ai/rag`'s `RetrievedChunk` this projection reads. */
interface RetrievedChunkLike {
    id?: unknown;
    score?: unknown;
    sourceId?: unknown;
    text?: unknown;
}

/** Truncate a snippet to `max` chars, appending an ellipsis when it was cut. */
const snippet = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

/**
 * Clamp a MODEL-supplied `topK` into `[1, MAX_SEARCH_TOPK]` (truncating to an
 * integer), or `undefined` for an absent/garbage value so the caller can fall
 * back to the author's configured `topK`. Guards against a model requesting an
 * unbounded, zero, negative, or non-finite retrieval depth.
 */
const clampSearchTopK = (value: number | undefined): number | undefined => {
    if (value === undefined || !Number.isFinite(value)) {
        return undefined;
    }

    return Math.min(MAX_SEARCH_TOPK, Math.max(1, Math.trunc(value)));
};

/**
 * Project a `@lunora/ai/rag` `RetrieveResult` into the compact
 * {@link AgentMemorySearchResult} a minted `searchMemory` tool returns. Defensive
 * against a source action that returns a differently-shaped value (the dispatch
 * boundary is untyped): a missing `chunks`/`sources` degrades to empty.
 * @experimental
 */
const toSearchResults = (retrieved: unknown, snippetChars: number): AgentMemorySearchResult => {
    const raw = (retrieved ?? {}) as { chunks?: unknown; sources?: unknown };
    const chunks: ReadonlyArray<RetrievedChunkLike> = Array.isArray(raw.chunks) ? (raw.chunks as RetrievedChunkLike[]) : [];
    const sources: ReadonlyArray<unknown> = Array.isArray(raw.sources) ? raw.sources : [];

    return {
        results: chunks.map((chunk) => {
            return {
                id: typeof chunk.id === "string" ? chunk.id : "",
                score: typeof chunk.score === "number" ? chunk.score : 0,
                snippet: snippet(typeof chunk.text === "string" ? chunk.text : "", snippetChars),
                sourceId: typeof chunk.sourceId === "string" ? chunk.sourceId : "",
            };
        }),
        sources,
    };
};

/** JSON schema shown to the model for a `searchMemory` tool. */
const searchInputSchema = jsonSchema<AgentMemorySearchInput>({
    additionalProperties: false,
    properties: {
        query: { description: "Natural-language search query.", type: "string" },
        topK: { description: "Maximum number of hits to return.", type: "number" },
    },
    required: ["query"],
    type: "object",
});

/** JSON schema shown to the model for a `readMemory` tool. */
const readInputSchema = jsonSchema<AgentMemoryReadInput>({
    additionalProperties: false,
    properties: {
        id: { description: "The `id` of a hit returned by the search tool.", type: "string" },
    },
    required: ["id"],
    type: "object",
});

/** Mint the search tool — `searchMemory` for the default source, `search_KEY` for a skill's knowledge. */
const buildSearchTool = (
    source: AgentMemorySource,
    sourceReference: AgentFunctionReference | string,
    readToolName: string | undefined,
): AgentToolDefinition<AgentMemorySearchInput, AgentMemorySearchResult> => {
    const target = toFunctionReference(sourceReference);
    // Floor to 1 so a misconfigured `snippetChars: 0` (or negative) can't collapse
    // every hit to a bare ellipsis, hiding the passage text the model needs.
    const snippetChars = Math.max(1, source.snippetChars ?? DEFAULT_SNIPPET_CHARS);
    const configuredTopK = source.topK;
    const pull = readToolName === undefined ? "" : ` Use \`${readToolName}\` with a hit's \`id\` to fetch its full text.`;

    return {
        description:
            `Search long-term memory for passages relevant to a query. Returns ranked ` +
            `{ id, sourceId, score, snippet } hits — call again with a refined query to dig deeper.${pull}`,
        execute: async (input, context) => {
            // A model-supplied `topK` is clamped to `[1, MAX_SEARCH_TOPK]`; an absent
            // or garbage value falls back to the author's trusted configured `topK`.
            const topK = clampSearchTopK(input.topK) ?? configuredTopK;
            const retrieved = await context.run(target, { query: input.query, ...(topK === undefined ? {} : { topK }) });

            return toSearchResults(retrieved, snippetChars);
        },
        inputSchema: searchInputSchema,
        isLunoraAgentTool: true,
    };
};

/** Mint the companion read tool — `readMemory`, or `read_KEY` for a skill — for a source that set `read`. */
const buildReadTool = (readReference: NonNullable<AgentMemorySource["read"]>): AgentToolDefinition<AgentMemoryReadInput> => {
    const target = toFunctionReference(readReference);

    return {
        description: "Fetch the full text of a memory document by the `id` from a search hit.",
        execute: (input, context) => context.run(target, { id: input.id }),
        inputSchema: readInputSchema,
        isLunoraAgentTool: true,
    };
};

/**
 * Mint the model-facing tools for every `mode: "agentic"` memory source — the
 * agent's own `memory` (keyed `"default"` → `searchMemory`/`readMemory`) and
 * each skill's `knowledge` (keyed by the skill name → `search_KEY`/`read_KEY`).
 * An `"inject"`-mode source contributes NO tool (it stays on the auto-injection
 * path). The returned map is folded into the agent's flat tool namespace by
 * `defineAgent`, where a collision with a real tool throws.
 *
 * Walks the same two source origins as `collectMemorySources` so the two stay in
 * lockstep; the split is deliberate — inject sources feed retrieval, agentic
 * sources feed tools, and no source is ever on both paths.
 * @experimental
 */
const collectAgenticMemoryTools = (config: AgentConfig, skills: ReadonlyArray<SkillDefinition>): Record<string, AnyAgentTool> => {
    const sources: AgentMemorySource[] = [];

    if (config.memory) {
        sources.push({ key: "default", ...config.memory });
    }

    for (const skill of skills) {
        if (skill.knowledge) {
            sources.push({ key: skill.name, ...skill.knowledge });
        }
    }

    const tools: Record<string, AnyAgentTool> = {};

    for (const source of sources) {
        // Agentic tools are a semantic-kind feature; a graph or episodic source is
        // always auto-injected (via `collectMemorySources`) and mints no tool.
        if (source.kind === "graph" || source.kind === "episodic" || source.mode !== "agentic" || source.source === undefined) {
            continue;
        }

        const searchName = source.key === "default" ? "searchMemory" : `search_${source.key}`;
        const readName = source.key === "default" ? "readMemory" : `read_${source.key}`;
        const hasRead = source.read !== undefined;

        tools[searchName] = buildSearchTool(source, source.source, hasRead ? readName : undefined);

        if (hasRead) {
            tools[readName] = buildReadTool(source.read as NonNullable<AgentMemorySource["read"]>);
        }
    }

    return tools;
};

export type { AgentMemoryReadInput, AgentMemorySearchHit, AgentMemorySearchInput, AgentMemorySearchResult };
export { collectAgenticMemoryTools, toSearchResults };
