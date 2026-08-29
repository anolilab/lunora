/**
 * A `pgvector`-backed {@link VectorizeIndexLike}, so a Hyperdrive/Postgres
 * deployment can serve `ctx.vectors` without a Cloudflare Vectorize binding.
 *
 * `.vectorize()` already talks to an interface rather than a provider: the shard
 * takes `vectors: (env) => Record<string, VectorizeIndexLike>`, and everything
 * above it — the write-through sync hook, `ctx.vectors`, codegen — is written
 * against that six-method surface. So this is a drop-in peer of the Vectorize
 * binding, not a second code path:
 *
 * ```ts
 * createShardDO({
 *     vectors: (env) => ({
 *         posts_search: createPgVectorIndex({ client, dimensions: 768, name: "posts_search" }),
 *     }),
 * });
 * ```
 *
 * It closes the same split `.global({ backend: "hyperdrive" })` already closed
 * for full-text search: an app that moved its relational tier to its own
 * Postgres kept getting pulled back to a Cloudflare binding for vectors alone.
 *
 * **Provisioning is lazy**, mirroring the global store's `ensureMigrated`: the
 * extension, table and ANN index are created on first use and cached as the
 * resolving promise, so concurrent first callers share one round trip. Every
 * statement is `IF NOT EXISTS`, so it is safe to run against a live table.
 *
 * **Where it differs from Vectorize**, deliberately and loudly:
 *
 * - `metadata` filters support equality only (JSONB containment). Vectorize's
 *   comparison operators (`$ne`, `$in`, `$lt`, …) are REJECTED rather than
 *   ignored — a silently dropped filter returns confidently wrong neighbours.
 * - `returnMetadata: "indexed"` behaves as `"all"`. Postgres indexes the whole
 *   JSONB document; there is no separate indexed-metadata projection to honour.
 * - `mutationId` is a local counter. Vectorize's is a handle for an async
 *   mutation queue; a Postgres write is already durable when its promise
 *   resolves, so there is nothing to poll for and nothing meaningful to return.
 */
import type {
    VectorizeDeleteMutation,
    VectorizeIndexDetails,
    VectorizeIndexLike,
    VectorizeMatches,
    VectorizeQueryOptions,
    VectorizeUpsertMutation,
    VectorizeVector,
    VectorMetric,
} from "@lunora/platform";

import type { SqlClient } from "./types";

/** Bare SQL identifier: the only shape allowed for a caller-supplied table name. */
const BARE_IDENTIFIER = /^[A-Z_]\w*$/i;

/** Default page size for `query` when the caller names no `topK`, matching Vectorize's own default. */
const DEFAULT_TOP_K = 5;

/**
 * Per-metric pgvector wiring: the distance operator used for both ORDER BY and
 * the score projection, and the operator class the ANN index must declare.
 *
 * Every metric orders ASCENDING — `<#>` returns the NEGATIVE inner product
 * precisely so that "smaller is better" holds for all three, which is what lets
 * one query shape serve every metric.
 *
 * `score` converts that distance back into the number Vectorize reports:
 * cosine similarity (1 = identical), raw L2 distance (0 = identical), and the
 * plain inner product.
 */
interface MetricWiring {
    /** Distance operator used for both ORDER BY and the score projection. */
    operator: string;
    /** Operator class the ANN index must declare to answer that operator. */
    operatorClass: string;
    /** Convert pgvector's distance into the number Vectorize reports. */
    score: (distance: number) => number;
}

const METRICS = new Map<VectorMetric, MetricWiring>(
    Object.entries({
        cosine: { operator: "<=>", operatorClass: "vector_cosine_ops", score: (distance) => 1 - distance },
        "dot-product": { operator: "<#>", operatorClass: "vector_ip_ops", score: (distance) => -distance },
        euclidean: { operator: "<->", operatorClass: "vector_l2_ops", score: (distance) => distance },
    }) as [VectorMetric, MetricWiring][],
);

/** Options for {@link createPgVectorIndex}. */
interface PgVectorIndexOptions {
    /** Postgres client — the same `SqlClient` the Hyperdrive global store takes. */
    client: SqlClient;

    /**
     * Vector width. Must match the embedder's output and the `dimensions` on the
     * schema's `.vectorize(...)`; Postgres enforces it per row, so a mismatch
     * surfaces as a write error rather than silently bad neighbours.
     */
    dimensions: number;

    /** Distance metric. Defaults to `"cosine"`, matching the common embedding case. */
    metric?: VectorMetric;

    /** Logical index name — the same key used in the shard's `vectors` map. */
    name: string;

    /** Table override. Defaults to `__vec_<name>`; must be a bare SQL identifier. */
    table?: string;
}

/** Render a vector as the `[1,2,3]` text literal pgvector parses on the `::vector` cast. */
const vectorLiteral = (values: ReadonlyArray<number>): string => `[${values.join(",")}]`;

/**
 * Reject a metadata filter this store cannot honour.
 *
 * Vectorize accepts comparison operators (`{ views: { $gt: 10 } }`); JSONB
 * containment expresses equality only. Dropping the rest would return neighbours
 * that look plausible and ignore the constraint the caller asked for, so an
 * unsupported filter is an error with the offending key named.
 */
const assertEqualityFilter = (filter: Record<string, unknown>, name: string): void => {
    for (const [key, value] of Object.entries(filter)) {
        if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).some((operator) => operator.startsWith("$"))) {
            throw new TypeError(
                `@lunora/hyperdrive: pgvector index "${name}" supports equality metadata filters only, but "${key}" uses a comparison operator. ` +
                    `Pre-compute the comparison into an equality-shaped metadata field, or keep this index on Vectorize.`,
            );
        }
    }
};

/** Validate a caller-supplied identifier; table names cannot be parameterised, so this is the allowlist. */
const safeIdentifier = (value: string, label: string): string => {
    if (!BARE_IDENTIFIER.test(value)) {
        throw new TypeError(
            `@lunora/hyperdrive: ${label} must be a bare SQL identifier (letters, digits, underscore; not starting with a digit) — got "${value}"`,
        );
    }

    return value;
};

/**
 * Build a `pgvector`-backed vector index that satisfies {@link VectorizeIndexLike}.
 *
 * Requires the `vector` extension to be installable by the connecting role
 * (`CREATE EXTENSION IF NOT EXISTS vector`). On a managed Postgres where the
 * role cannot create extensions, install it once out-of-band; the statement is
 * then a no-op.
 * @param options See {@link PgVectorIndexOptions}.
 * @returns An index object the shard's `vectors` map accepts as-is.
 */
const createPgVectorIndex = (options: PgVectorIndexOptions): VectorizeIndexLike => {
    const { client, dimensions, metric = "cosine", name } = options;
    const table = safeIdentifier(options.table ?? `__vec_${name}`, "pgvector `table`");
    // Annotated rather than inferred: `metric` is a closed union at the type
    // level, so this guard exists for a JS caller passing a bad string.
    const wiring = METRICS.get(metric);

    if (wiring === undefined) {
        throw new TypeError(`@lunora/hyperdrive: pgvector index "${name}" got an unknown metric "${metric}" — expected cosine, euclidean, or dot-product`);
    }

    const { operator, operatorClass, score } = wiring;

    if (!Number.isInteger(dimensions) || dimensions <= 0) {
        throw new TypeError(`@lunora/hyperdrive: pgvector index "${name}" needs a positive integer \`dimensions\` — got ${String(dimensions)}`);
    }

    let mutations = 0;
    const nextMutationId = (): string => {
        mutations += 1;

        return `${table}:${String(mutations)}`;
    };

    // Cache the resolving promise, not a boolean: concurrent first callers then
    // share one provisioning round trip instead of racing duplicate DDL.
    let provisioned: Promise<void> | undefined;
    const ensure = async (): Promise<void> => {
        provisioned ??= (async (): Promise<void> => {
            await client.query("CREATE EXTENSION IF NOT EXISTS vector");
            await client.query(
                `CREATE TABLE IF NOT EXISTS "${table}" (id text PRIMARY KEY, namespace text, embedding vector(${String(dimensions)}) NOT NULL, metadata jsonb)`,
            );
            // The ANN index is metric-specific: an index built for one operator
            // class cannot answer a query ordered by another operator, so the
            // scan would silently fall back to sequential.
            await client.query(`CREATE INDEX IF NOT EXISTS "${table}__ann" ON "${table}" USING hnsw (embedding ${operatorClass})`);
            await client.query(`CREATE INDEX IF NOT EXISTS "${table}__ns" ON "${table}" (namespace)`);
        })();

        return provisioned;
    };

    /** Shared INSERT body for `upsert` (overwrite) and `insert` (skip existing). */
    const write = async (vectors: ReadonlyArray<VectorizeVector>, onConflict: string): Promise<VectorizeUpsertMutation> => {
        if (vectors.length === 0) {
            return { mutationId: nextMutationId() };
        }

        await ensure();

        const parameters: unknown[] = [];
        const rows = vectors.map((vector) => {
            parameters.push(
                vector.id,
                // eslint-disable-next-line unicorn/no-null -- a SQL bind parameter needs a real NULL; `undefined` is sent as a missing bind
                vector.namespace ?? null,
                vectorLiteral(vector.values),
                // eslint-disable-next-line unicorn/no-null -- same: absent metadata must bind SQL NULL
                vector.metadata === undefined ? null : JSON.stringify(vector.metadata),
            );
            const base = parameters.length - 4;

            return `($${String(base + 1)}, $${String(base + 2)}, $${String(base + 3)}::vector, $${String(base + 4)}::jsonb)`;
        });

        await client.query(`INSERT INTO "${table}" (id, namespace, embedding, metadata) VALUES ${rows.join(", ")} ${onConflict}`, parameters);

        return { mutationId: nextMutationId() };
    };

    return {
        async deleteByIds(ids: ReadonlyArray<string>): Promise<VectorizeDeleteMutation> {
            if (ids.length === 0) {
                return { count: 0, mutationId: nextMutationId() };
            }

            await ensure();

            const deleted = await client.query<{ id: string }>(`DELETE FROM "${table}" WHERE id = ANY($1::text[]) RETURNING id`, [[...ids]]);

            return { count: deleted.length, mutationId: nextMutationId() };
        },

        async describe(): Promise<VectorizeIndexDetails> {
            await ensure();

            const [row] = await client.query<{ count: number | string }>(`SELECT count(*) AS count FROM "${table}"`);

            return { dimensions, vectorsCount: Number(row?.count ?? 0) };
        },

        async getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<VectorizeVector>> {
            if (ids.length === 0) {
                return [];
            }

            await ensure();

            const rows = await client.query<{ embedding: string; id: string; metadata: Record<string, unknown> | null; namespace: null | string }>(
                `SELECT id, namespace, metadata, embedding::text AS embedding FROM "${table}" WHERE id = ANY($1::text[])`,
                [[...ids]],
            );

            return rows.map((row) => {
                return {
                    id: row.id,
                    ...(row.metadata === null ? {} : { metadata: row.metadata }),
                    ...(row.namespace === null ? {} : { namespace: row.namespace }),
                    // `vector::text` renders `[1,2,3]`; parse back to the numeric
                    // array the Vectorize surface hands callers.
                    values: JSON.parse(row.embedding) as number[],
                };
            });
        },

        async insert(vectors: ReadonlyArray<VectorizeVector>): Promise<VectorizeUpsertMutation> {
            // Vectorize's `insert` leaves an existing id untouched; `upsert` replaces it.
            return write(vectors, "ON CONFLICT (id) DO NOTHING");
        },

        async query(vector: ReadonlyArray<number>, queryOptions?: VectorizeQueryOptions): Promise<VectorizeMatches> {
            await ensure();

            const topK = queryOptions?.topK ?? DEFAULT_TOP_K;
            const wantValues = queryOptions?.returnValues === true;
            const wantMetadata = (queryOptions?.returnMetadata ?? "none") !== "none";

            const parameters: unknown[] = [vectorLiteral(vector)];
            const where: string[] = [];

            if (queryOptions?.namespace !== undefined) {
                parameters.push(queryOptions.namespace);
                where.push(`namespace = $${String(parameters.length)}`);
            }

            if (queryOptions?.filter !== undefined && Object.keys(queryOptions.filter).length > 0) {
                assertEqualityFilter(queryOptions.filter, name);
                parameters.push(JSON.stringify(queryOptions.filter));
                where.push(`metadata @> $${String(parameters.length)}::jsonb`);
            }

            parameters.push(topK);

            const projection = ["id", "namespace", `embedding ${operator} $1::vector AS distance`];

            if (wantMetadata) {
                projection.push("metadata");
            }

            if (wantValues) {
                projection.push("embedding::text AS embedding");
            }

            const rows = await client.query<{
                distance: number | string;
                embedding?: string;
                id: string;
                metadata?: Record<string, unknown> | null;
                namespace: null | string;
            }>(
                `SELECT ${projection.join(", ")} FROM "${table}" ${where.length > 0 ? `WHERE ${where.join(" AND ")} ` : ""}ORDER BY embedding ${operator} $1::vector LIMIT $${String(parameters.length)}`,
                parameters,
            );

            const matches = rows.map((row) => {
                return {
                    id: row.id,
                    ...(wantMetadata && row.metadata !== null && row.metadata !== undefined ? { metadata: row.metadata } : {}),
                    ...(row.namespace === null ? {} : { namespace: row.namespace }),
                    score: score(Number(row.distance)),
                    ...(wantValues && row.embedding !== undefined ? { values: JSON.parse(row.embedding) as number[] } : {}),
                };
            });

            return { count: matches.length, matches };
        },

        async upsert(vectors: ReadonlyArray<VectorizeVector>): Promise<VectorizeUpsertMutation> {
            return write(
                vectors,
                "ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, namespace = EXCLUDED.namespace, metadata = EXCLUDED.metadata",
            );
        },
    };
};

export type { PgVectorIndexOptions };
export { createPgVectorIndex };
