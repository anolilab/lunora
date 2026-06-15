import type { EmbedFunction, VectorizeIndexLike, VectorMetric } from "./types";

/** Vectorize hard ceiling on `topK`, mirrored from `create-vectors`. */
const MAX_TOP_K = 100;

/** Default neighbours returned by an admin similarity query when the caller omits `topK`. */
const DEFAULT_TOP_K = 10;

/**
 * One vector index as the generated `LUNORA_VECTOR_INDEXES` registry describes
 * it — the static schema shape, independent of any live binding. Structurally
 * the codegen `LunoraVectorIndex`, restated here so this package stays free of a
 * dependency on `@lunora/codegen`.
 */
interface VectorIndexRegistryEntry {
    dimensions?: number;
    field?: string;
    metadata?: ReadonlyArray<string>;
    metric?: VectorMetric;
    name: string;
    table: string;
}

/** A registry entry merged with the live `describe()` stats (when the binding is reachable). */
interface VectorAdminIndexSummary extends VectorIndexRegistryEntry {
    processedUpToMutation?: string;
    vectorsCount?: number;
}

/** One nearest-neighbour hit from an admin similarity query. */
interface VectorAdminQueryMatch {
    id: string;
    metadata?: Record<string, unknown>;
    score: number;
}

/**
 * The admin introspector the worker passes to `createWorker({ vectorIntrospector })`.
 * `queryIndex` is present only when at least one embedder is wired.
 */
interface VectorAdminIntrospector {
    listIndexes: () => Promise<VectorAdminIndexSummary[]>;
    queryIndex?: (options: { name: string; text: string; topK?: number }) => Promise<{ matches: VectorAdminQueryMatch[] }>;
}

interface VectorAdminIntrospectorOptions {
    /**
     * Per-index embedder (text → vector), keyed by index name. Supply the
     * schema's embedders to enable studio similarity queries; omit it (or leave
     * an index out) and that index lists read-only — `queryIndex` is withheld
     * entirely when no embedder is provided.
     */
    embedders?: Record<string, EmbedFunction<string>>;

    /** Live Vectorize bindings keyed by index name, from `env`. */
    indexes: Record<string, VectorizeIndexLike>;

    /** The generated `LUNORA_VECTOR_INDEXES` registry (Vectorize can't enumerate at runtime). */
    registry: ReadonlyArray<VectorIndexRegistryEntry>;
}

/**
 * Build the read-only Vectorize introspector backing the studio's vector
 * browser. `listIndexes` returns the static registry, enriching each entry with
 * live `describe()` stats when the matching binding is present (a binding that
 * throws or lacks `describe` degrades to the static shape rather than failing
 * the whole list). `queryIndex` embeds the query text via the index's embedder
 * and runs an ANN search; it is omitted when no embedders are configured, so the
 * worker reports `VECTOR_QUERY_UNSUPPORTED` rather than half-answering.
 */
const createVectorAdminIntrospector = (options: VectorAdminIntrospectorOptions): VectorAdminIntrospector => {
    const { embedders, indexes, registry } = options;

    const listIndexes = async (): Promise<VectorAdminIndexSummary[]> =>
        Promise.all(
            registry.map(async (entry): Promise<VectorAdminIndexSummary> => {
                const binding = indexes[entry.name];

                if (binding?.describe === undefined) {
                    return { ...entry };
                }

                try {
                    const details = await binding.describe();

                    return {
                        ...entry,
                        dimensions: entry.dimensions ?? details.dimensions,
                        processedUpToMutation: details.processedUpToMutation,
                        vectorsCount: details.vectorsCount,
                    };
                } catch {
                    // A binding that can't describe itself (transient error, or a
                    // local dev stub) still lists with its declared shape.
                    return { ...entry };
                }
            }),
        );

    const hasEmbedders = embedders !== undefined && Object.keys(embedders).length > 0;

    if (!hasEmbedders) {
        return { listIndexes };
    }

    const queryIndex = async ({ name, text, topK }: { name: string; text: string; topK?: number }): Promise<{ matches: VectorAdminQueryMatch[] }> => {
        const binding = indexes[name];

        if (binding === undefined) {
            throw new Error(`@lunora/vectors: no Vectorize binding registered for index "${name}"`);
        }

        const embed = embedders[name];

        if (embed === undefined) {
            throw new Error(`@lunora/vectors: no embedder registered for index "${name}" — it lists read-only`);
        }

        const vector = await embed(text);
        const result = await binding.query(vector, {
            returnMetadata: "all",
            topK: Math.min(topK ?? DEFAULT_TOP_K, MAX_TOP_K),
        });

        return {
            matches: result.matches.map((match) => {
                return { id: match.id, metadata: match.metadata, score: match.score };
            }),
        };
    };

    return { listIndexes, queryIndex };
};

export default createVectorAdminIntrospector;
export type { VectorAdminIndexSummary, VectorAdminIntrospector, VectorAdminIntrospectorOptions, VectorAdminQueryMatch, VectorIndexRegistryEntry };
