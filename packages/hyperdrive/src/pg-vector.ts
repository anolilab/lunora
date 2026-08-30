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

/** Leaves room under Postgres' 63-byte identifier cap for the `__vec_` prefix and the longest derived suffix. */
const MAX_NAME_LENGTH = 40;

/** pgvector's HNSW index tops out here; the `vector` type itself allows far more. */
const MAX_HNSW_DIMENSIONS = 2000;

/** pgvector's own default `hnsw.ef_search`; the floor we widen from, never below. */
const DEFAULT_EF_SEARCH = 40;

/**
 * Postgres SQLSTATEs for "the object already exists": duplicate_object,
 * duplicate_table, duplicate_schema-ish, unique_violation on a system catalog.
 * All four are how a lost `CREATE … IF NOT EXISTS` race reports itself, and all
 * four mean the object is there — which is what the caller wanted.
 */
const DUPLICATE_OBJECT_CODES = new Set(["42P06", "42P07", "23505", "42710"]);

/** True when `error` is Postgres reporting that a concurrent session already created the object. */
const isDuplicateObjectError = (error: unknown): boolean =>
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && DUPLICATE_OBJECT_CODES.has(error.code);

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
 * cosine similarity (1 = identical), raw L2 distance (0 = identical), and — for
 * dot-product — the NEGATIVE inner product, passed straight through. Cloudflare
 * documents that last one as "larger negative values or smaller positive values
 * denote more similar vectors", which is exactly what `<#>` already returns, so
 * negating it here would inverted every score against a real binding while
 * leaving the ordering identical: silent, and invisible to an ordering test.
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
        "dot-product": { operator: "<#>", operatorClass: "vector_ip_ops", score: (distance) => distance },
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

    /**
     * Logical index name — the same key used in the shard's `vectors` map. The
     * backing table name is derived from it rather than configurable, because a
     * second name for one index is a way to lose data, not a feature.
     */
    name: string;
}

/** Render a vector as the `[1,2,3]` text literal pgvector parses on the `::vector` cast. */
const vectorLiteral = (values: ReadonlyArray<number>): string => `[${values.join(",")}]`;

/**
 * Reject a metadata filter this store cannot honour.
 *
 * Vectorize accepts comparison operators (`{ views: { $gt: 10 } }`) and
 * dot-addressed nested keys (`{ "author.role": "admin" }`). JSONB containment
 * expresses neither: `@>` would look for a literal key spelled `$gt` or
 * `author.role`, match nothing, and hand back an empty page that reads exactly
 * like "no similar vectors". A filter this store cannot honour is therefore an
 * ERROR, never a silent drop — that asymmetry is the whole point of the guard.
 *
 * The walk is recursive and descends into arrays because both are reachable:
 * `{ author: { profile: { $gt: 3 } } }` hides the operator one level down, and
 * `{ tags: [{ $in: [...] }] }` hides it inside an array.
 */
const assertContainmentFilter = (filter: Record<string, unknown>, name: string): void => {
    const reject = (reason: string, key: string): never => {
        throw new TypeError(
            `@lunora/hyperdrive: pgvector index "${name}" supports equality metadata filters only, but "${key}" ${reason}. ` +
                `Pre-compute it into an equality-shaped metadata field, or keep this index on Vectorize.`,
        );
    };

    const walk = (value: unknown, path: string): void => {
        if (Array.isArray(value)) {
            for (const entry of value) {
                walk(entry, path);
            }

            return;
        }

        if (typeof value !== "object" || value === null) {
            return;
        }

        for (const [key, nested] of Object.entries(value)) {
            if (key.startsWith("$")) {
                reject("uses a comparison operator", path);
            }

            walk(nested, path);
        }
    };

    for (const [key, value] of Object.entries(filter)) {
        if (key.includes(".")) {
            reject("uses Vectorize's dot-addressed nested syntax, which JSONB containment cannot express", key);
        }

        // `JSON.stringify` would drop an undefined value, turning the filter into
        // `{}` — which matches every row that HAS metadata and silently excludes
        // the rows that do not. Neither is what the caller asked for.
        if (value === undefined) {
            reject("is undefined", key);
        }

        walk(value, key);
    }
};

/**
 * Validate a caller-supplied identifier. Table names cannot be parameterised, so
 * this allowlist is the only thing standing between `name` and raw DDL.
 *
 * The length cap is not cosmetic: Postgres truncates identifiers at 63 bytes, and
 * this module derives `<table>__ann_<opclass>` and `<table>__ns` from the same
 * root. Past the cap those suffixes truncate away, two different indexes collapse
 * onto one name, and `CREATE INDEX IF NOT EXISTS` silently no-ops the second.
 */
const safeIdentifier = (value: string): string => {
    if (!BARE_IDENTIFIER.test(value)) {
        throw new TypeError(
            `@lunora/hyperdrive: pgvector \`name\` must be a bare SQL identifier (letters, digits, underscore; not starting with a digit) — got "${value}"`,
        );
    }

    if (value.length > MAX_NAME_LENGTH) {
        throw new TypeError(
            `@lunora/hyperdrive: pgvector \`name\` must be at most ${String(MAX_NAME_LENGTH)} characters — got "${value}" (${String(value.length)}). ` +
                `Postgres truncates identifiers at 63 bytes and this index derives longer names from it.`,
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
    const table = `__vec_${safeIdentifier(name)}`;
    // `metric` is a closed union at the type level, so this guard is for a JS
    // caller (or a widened config) passing a string the map has no wiring for.
    const wiring = METRICS.get(metric);

    if (wiring === undefined) {
        throw new TypeError(`@lunora/hyperdrive: pgvector index "${name}" got an unknown metric "${metric}" — expected cosine, euclidean, or dot-product`);
    }

    const { operator, operatorClass, score } = wiring;

    if (!Number.isInteger(dimensions) || dimensions <= 0) {
        throw new TypeError(`@lunora/hyperdrive: pgvector index "${name}" needs a positive integer \`dimensions\` — got ${String(dimensions)}`);
    }

    // Caught here rather than at `CREATE INDEX`: past this width pgvector fails
    // the ANN index with an opaque error AFTER the table exists, which reads as a
    // provisioning bug rather than a config one.
    if (dimensions > MAX_HNSW_DIMENSIONS) {
        throw new TypeError(
            `@lunora/hyperdrive: pgvector index "${name}" declares ${String(dimensions)} dimensions, over the HNSW limit of ${String(MAX_HNSW_DIMENSIONS)}. ` +
                `Reduce the embedding width (Vectorize itself tops out at 1536), or keep this index on Vectorize.`,
        );
    }

    let mutations = 0;
    const nextMutationId = (): string => {
        mutations += 1;

        return `${table}:${String(mutations)}`;
    };

    /**
     * Provision once per instance, lazily.
     *
     * The cache holds the resolving promise so concurrent first callers in THIS
     * isolate share one round trip — but a rejection must not stick. A Durable
     * Object is long-lived and the write-through vector sync runs inline inside
     * the mutation, so caching one transient DDL failure would fail every
     * mutation on a vectorized table until the isolate is evicted. This mirrors
     * the global-table migration memo in `@lunora/sql-store`, whose `.catch`
     * clearing the slot is the load-bearing half of that pattern.
     *
     * `IF NOT EXISTS` dedupes within a session but is NOT atomic across them:
     * several isolates hitting a cold database race on the system catalogs and
     * one loses with a duplicate-object error. That is a success for our purpose
     * — the object exists — so those codes are swallowed rather than cached as a
     * failure. PGlite is a single session and can never reproduce it.
     */
    let provisioned: Promise<void> | undefined;
    const ensure = async (): Promise<void> => {
        provisioned ??= (async (): Promise<void> => {
            for (const statement of [
                "CREATE EXTENSION IF NOT EXISTS vector",
                `CREATE TABLE IF NOT EXISTS "${table}" (id text PRIMARY KEY, namespace text, embedding vector(${String(dimensions)}) NOT NULL, metadata jsonb)`,
                // The operator class is part of the NAME, not just the body: an
                // index built for one metric cannot answer another metric's
                // operator, so a bare `__ann` would let `IF NOT EXISTS` no-op
                // against a stale index and quietly demote every query to a
                // sequential scan — the exact failure this index prevents.
                `CREATE INDEX IF NOT EXISTS "${table}__ann_${operatorClass}" ON "${table}" USING hnsw (embedding ${operatorClass})`,
                `CREATE INDEX IF NOT EXISTS "${table}__ns" ON "${table}" (namespace)`,
            ]) {
                try {
                    // eslint-disable-next-line no-await-in-loop -- DDL is ordered: the table must exist before its indexes.
                    await client.query(statement);
                } catch (error: unknown) {
                    if (!isDuplicateObjectError(error)) {
                        throw error;
                    }
                }
            }
        })().catch((error: unknown) => {
            provisioned = undefined;

            throw error;
        });

        return provisioned;
    };

    /**
     * Widen the ANN search before a filtered query.
     *
     * pgvector applies `WHERE` AFTER scanning the HNSW index, so a selective
     * filter starves the result set: at the default `ef_search` of 40, a
     * namespace matching 0.5% of rows yields well under one match and the caller
     * gets an empty page with no error. Every `.shardBy()` table hits this —
     * `ctx.vectors` requires a namespace there.
     *
     * `iterative_scan` (pgvector 0.8+) is the real fix: it keeps scanning until
     * enough rows survive the filter. `ef_search` is raised alongside it so an
     * unfiltered `topK` above 40 is not truncated either. Both are best-effort —
     * an older pgvector rejects the GUC, and exact search without the index is
     * still correct, only slower.
     */
    const widenSearch = async (topK: number, filtered: boolean): Promise<void> => {
        const efSearch = String(Math.max(DEFAULT_EF_SEARCH, topK * 2));

        try {
            await client.query("SELECT set_config('hnsw.iterative_scan', $1, false), set_config('hnsw.ef_search', $2, false)", [
                filtered ? "relaxed_order" : "off",
                efSearch,
            ]);
        } catch {
            try {
                await client.query("SELECT set_config('hnsw.ef_search', $1, false)", [efSearch]);
            } catch {
                // Pre-0.8 pgvector, or a role that cannot set GUCs. Recall may be
                // lower than Vectorize's on a filtered query; correctness of the
                // rows returned is unaffected.
            }
        }
    };

    /**
     * Shared INSERT body for `upsert` (overwrite) and `insert` (skip existing).
     *
     * Postgres caps a statement at 65535 bind parameters; at four per row this
     * tops out near 16k vectors. `createVectors` admits at most 1000 per call, so
     * the ceiling is unreachable through `ctx.vectors` — it matters only to a
     * caller holding this object directly.
     */
    const write = async (vectors: ReadonlyArray<VectorizeVector>, onConflict: string): Promise<VectorizeUpsertMutation> => {
        if (vectors.length === 0) {
            return { mutationId: nextMutationId() };
        }

        await ensure();

        const parameters: unknown[] = [];
        // See `query` — `push` returns the 1-based bind index, so placeholder and
        // value cannot drift, and a new column is one edit rather than three.
        const bind = (value: unknown): string => `$${String(parameters.push(value))}`;
        const rows = vectors.map(
            (vector) =>
                // eslint-disable-next-line unicorn/no-null -- a SQL bind needs a real NULL; `undefined` is sent as a missing bind
                `(${bind(vector.id)}, ${bind(vector.namespace ?? null)}, ${bind(vectorLiteral(vector.values))}::vector, ` +
                // eslint-disable-next-line unicorn/no-null -- same: absent metadata must bind SQL NULL
                `${bind(vector.metadata === undefined ? null : JSON.stringify(vector.metadata))}::jsonb)`,
        );

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

            if (!Number.isInteger(topK) || topK <= 0) {
                throw new TypeError(`@lunora/hyperdrive: pgvector index "${name}" needs a positive integer \`topK\` — got ${String(topK)}`);
            }

            const wantValues = queryOptions?.returnValues === true;
            const wantMetadata = (queryOptions?.returnMetadata ?? "none") !== "none";

            const parameters: unknown[] = [];
            // `push` returns the new length, which IS the 1-based bind index — so
            // the placeholder and its value can never drift apart, and adding a
            // column stays a one-place edit.
            const bind = (value: unknown): string => `$${String(parameters.push(value))}`;

            const distance = `embedding ${operator} ${bind(vectorLiteral(vector))}::vector`;
            const where: string[] = [];

            if (queryOptions?.namespace !== undefined) {
                where.push(`namespace = ${bind(queryOptions.namespace)}`);
            }

            if (queryOptions?.filter !== undefined && Object.keys(queryOptions.filter).length > 0) {
                assertContainmentFilter(queryOptions.filter, name);
                where.push(`metadata @> ${bind(JSON.stringify(queryOptions.filter))}::jsonb`);
            }

            await widenSearch(topK, where.length > 0);

            const projection = ["id", "namespace", `${distance} AS distance`];

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
                `SELECT ${projection.join(", ")} FROM "${table}" ${where.length > 0 ? `WHERE ${where.join(" AND ")} ` : ""}ORDER BY ${distance} LIMIT ${bind(topK)}`,
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
