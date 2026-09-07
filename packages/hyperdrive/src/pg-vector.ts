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
 * extension, the table, the ANN index and the two filter indexes are created on
 * first use and cached as the
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

import { isBareIdentifier } from "../../../shared/bare-identifier";
import type { SqlClient } from "./types";

/** pgvector's HNSW index tops out here; the `vector` type itself allows far more. */
const MAX_HNSW_DIMENSIONS = 2000;

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
/** Affixes every derived identifier is built from; the name budget is what they leave. */
const TABLE_PREFIX = "__vec_";
const ANN_INFIX = "__ann_";

interface MetricWiring {
    /** Distance operator used for both ORDER BY and the score projection. */
    operator: string;
    /** Operator class the ANN index must declare to answer that operator. */
    operatorClass: string;
    /** Convert pgvector's distance into the number Vectorize reports. */
    score: (distance: number) => number;
}

const METRICS: Record<VectorMetric, MetricWiring> = {
    cosine: { operator: "<=>", operatorClass: "vector_cosine_ops", score: (distance) => 1 - distance },
    "dot-product": { operator: "<#>", operatorClass: "vector_ip_ops", score: (distance) => distance },
    euclidean: { operator: "<->", operatorClass: "vector_l2_ops", score: (distance) => distance },
};

/** Postgres' identifier limit. Longer names are truncated, silently. */
const IDENTIFIER_BYTES = 63;

/**
 * Derived, not asserted: the longest identifier this module builds is
 * `__vec_<name>__ann_<operatorClass>`, so the room left for `name` is whatever
 * the affixes do not take. Computing it means adding a metric with a longer
 * operator class cannot quietly push two index names onto the same truncated
 * string, where the second `CREATE INDEX IF NOT EXISTS` would no-op.
 */
const MAX_NAME_LENGTH =
    IDENTIFIER_BYTES - TABLE_PREFIX.length - ANN_INFIX.length - Math.max(...Object.values(METRICS).map((wiring) => wiring.operatorClass.length));

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
     * Names the backing table (`__vec_<name>`), derived rather than configurable —
     * a second name for one index is a way to lose data, not a feature.
     *
     * This is NOT required to equal the key in the shard's `vectors` map, and often
     * cannot: that key mirrors the schema's `.vectorize({ index })`, which may carry
     * hyphens (`"docs-body"`), while this must be a bare SQL identifier. Keep it
     * stable — changing it points the index at a different, empty table.
     */
    name: string;
}

/** Render a vector as the `[1,2,3]` text literal pgvector parses on the `::vector` cast. */
const vectorLiteral = (values: ReadonlyArray<number>): string => `[${values.join(",")}]`;

/**
 * Whether `value`'s own enumerable entries ARE its contents — the only shape
 * `JSON.stringify` preserves field-for-field, and the only one the containment
 * filter's walk can inspect.
 */
const isPlainObject = (value: object): boolean => {
    const prototype: unknown = Object.getPrototypeOf(value);

    return prototype === null || prototype === Object.prototype;
};

/** Best-effort class name for an error message. */
const constructorName = (value: object): string => (value.constructor as { name?: string } | undefined)?.name ?? "non-plain object";

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
 *
 * Every object it meets — the filter itself included — must be plain
 * ({@link isPlainObject}). A `Map`, `Set` or class instance has no own
 * enumerable entries, so walking it inspects nothing and the value stringifies
 * to `{}`, which JSONB containment matches for every row that has metadata at
 * all. That is a fail-OPEN filter across tenants, which is why the shape is
 * rejected outright rather than walked.
 */
const assertContainmentFilter = (filter: Record<string, unknown>, name: string): void => {
    const reject = (reason: string, key: string): never => {
        throw new TypeError(
            `@lunora/hyperdrive: pgvector index "${name}" supports equality metadata filters only, but "${key}" ${reason}. ` +
                `Pre-compute it into an equality-shaped metadata field, or keep this index on Vectorize.`,
        );
    };

    /**
     * `JSON.stringify` silently drops undefined, function and symbol values. Each
     * one narrows the containment document — `{ tenant: () => {} }` becomes `{}`,
     * which matches every row that has metadata at all. That fails OPEN, across
     * tenants, so it is rejected rather than trusted to be unreachable: `filter` is
     * typed `Record<string, unknown>`, so a class instance or an object carrying a
     * method reaches here without TypeScript objecting.
     */
    const assertSerialisable = (value: unknown, path: string): void => {
        if (value === undefined || typeof value === "function" || typeof value === "symbol") {
            reject(`has a value at "${path}" that JSON cannot represent, which would widen the filter to match every row`, path);
        }

        // `JSON.stringify` turns NaN/Infinity into `null`, which silently becomes a
        // filter for null-valued rows rather than the number the caller meant.
        if (typeof value === "number" && !Number.isFinite(value)) {
            reject(`has a non-finite number at "${path}", which JSON turns into null`, path);
        }

        // And it throws on a bigint — better here, before anything is provisioned,
        // and with a message naming the field.
        if (typeof value === "bigint") {
            reject(`has a bigint at "${path}", which JSON cannot serialise`, path);
        }
    };

    const walk = (value: unknown, path: string): void => {
        assertSerialisable(value, path);

        if (Array.isArray(value)) {
            for (const [position, entry] of value.entries()) {
                walk(entry, `${path}[${String(position)}]`);
            }

            return;
        }

        if (typeof value !== "object" || value === null) {
            return;
        }

        // A `Map`, a `Set`, a `Date`, a class instance — anything whose own
        // enumerable entries are not its contents — serialises to something
        // other than its fields, and `Object.entries` is `[]` for it, so the
        // walk below inspects nothing and rejects nothing. `{"tenant": new Map()}`
        // stringifies to `{"tenant":{}}`, which JSONB containment matches for
        // EVERY row that has metadata: the filter fails open, across tenants.
        // Reject by prototype rather than by walking own entries, since walking
        // is exactly what cannot see this.
        if (!isPlainObject(value)) {
            reject(`is a ${constructorName(value)}, whose fields JSON does not preserve`, path);
        }

        for (const [key, nested] of Object.entries(value)) {
            if (key.startsWith("$")) {
                reject("uses a comparison operator", path);
            }

            walk(nested, `${path}.${key}`);
        }
    };

    // The top level is subject to the same prototype rule as every nested one —
    // and it is the more dangerous of the two, because `Object.keys(someMap)` is
    // empty, so the caller's `Object.keys(filter).length > 0` gate skipped both
    // this guard and the containment clause and issued an UNFILTERED query.
    if (!isPlainObject(filter)) {
        reject(`is a ${constructorName(filter)}, whose fields JSON does not preserve`, "filter");
    }

    for (const [key, value] of Object.entries(filter)) {
        // Vectorize's own operators are legal at the top level too.
        if (key.startsWith("$")) {
            reject("uses a comparison operator", key);
        }

        if (key.includes(".")) {
            reject("uses Vectorize's dot-addressed nested syntax, which JSONB containment cannot express", key);
        }

        walk(value, key);
    }
};

/**
 * Validate a caller-supplied identifier. Table names cannot be parameterised, so
 * this allowlist is the only thing standing between `name` and raw DDL.
 *
 * The length cap is not cosmetic: Postgres truncates identifiers at 63 bytes, and
 * this module derives `<table>__ann_<opclass>`, `<table>__ns` and `<table>__meta`
 * from the same root. Past the cap those suffixes truncate away, two different indexes collapse
 * onto one name, and `CREATE INDEX IF NOT EXISTS` silently no-ops the second.
 */
const safeIdentifier = (value: string): string => {
    if (!isBareIdentifier(value)) {
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
    const table = `${TABLE_PREFIX}${safeIdentifier(name)}`;
    // Closed union at the type level, so this guard is only for a JS caller (or a
    // widened config) passing a string the table has no wiring for. `hasOwn`, not
    // `in`: `in` walks the prototype chain, so `"toString"` would pass and then
    // destructure to an undefined operator — provisioning the extension and table
    // before the HNSW statement failed on it.
    if (!Object.hasOwn(METRICS, metric)) {
        throw new TypeError(`@lunora/hyperdrive: pgvector index "${name}" got an unknown metric "${metric}" — expected cosine, euclidean, or dot-product`);
    }

    const { operator, operatorClass, score } = METRICS[metric];

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
                `CREATE INDEX IF NOT EXISTS "${table}${ANN_INFIX}${operatorClass}" ON "${table}" USING hnsw (embedding ${operatorClass})`,
                // These make the filtered query's CTE cheap; `query` is what makes it
                // CORRECT. Indexes alone cannot: the planner costs the ANN scan
                // against the bitmap path and sometimes picks the ANN one, which
                // post-filters and returns a short page. Session GUCs
                // (`hnsw.iterative_scan`) were the other candidate and are unusable
                // here — `SqlClient` exposes one statement at a time, so a pooled
                // client can run the SET and the SELECT on different sessions.
                `CREATE INDEX IF NOT EXISTS "${table}__ns" ON "${table}" (namespace)`,
                `CREATE INDEX IF NOT EXISTS "${table}__meta" ON "${table}" USING gin (metadata)`,
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

        // Postgres rejects `ON CONFLICT ... DO UPDATE` when one statement touches the
        // same id twice (SQLSTATE 21000), while Vectorize simply takes the last
        // write. Collapse duplicates here so a repeated id is a no-op difference
        // rather than a hard error the caller never sees from a real binding.
        const deduped = [...new Map(vectors.map((vector) => [vector.id, vector])).values()];

        const parameters: unknown[] = [];
        // See `query` — `push` returns the 1-based bind index, so placeholder and
        // value cannot drift, and a new column is one edit rather than three.
        const bind = (value: unknown): string => `$${String(parameters.push(value))}`;
        const rows = deduped.map(
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
            const topK = queryOptions?.topK ?? DEFAULT_TOP_K;

            if (!Number.isInteger(topK) || topK <= 0) {
                throw new TypeError(`@lunora/hyperdrive: pgvector index "${name}" needs a positive integer \`topK\` — got ${String(topK)}`);
            }

            // Guarded on presence, NOT on `Object.keys(...).length`: a `Map` (or
            // any other non-plain object) has no own enumerable keys, so keying
            // the guard off the count let exactly the value the guard exists to
            // reject walk straight past it.
            if (queryOptions?.filter !== undefined) {
                assertContainmentFilter(queryOptions.filter, name);
            }

            // Provision only after the cheap guards pass — an invalid `topK` or an
            // unsupported filter should not create an extension, a table and three
            // indexes on the way to throwing.
            await ensure();

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
                where.push(`metadata @> ${bind(JSON.stringify(queryOptions.filter))}::jsonb`);
            }

            const projection = ["id", "namespace", `${distance} AS distance`];

            if (wantMetadata) {
                projection.push("metadata");
            }

            if (wantValues) {
                projection.push("embedding::text AS embedding");
            }

            // A filtered query resolves the filter FIRST, in a materialized CTE, and
            // orders exactly over what survives. Leaving both to the planner is not
            // an option: pgvector post-filters after the ANN scan, so when the cost
            // model prefers the HNSW index a selective filter starves the page —
            // measured at 20k rows / 40 namespaces, `topK: 5` returned ONE row, and
            // smaller `topK` is worse, so the default shape is the broken one. The
            // btree/GIN indexes below make the CTE cheap; they cannot make the
            // choice deterministic, which is why this is a query shape and not an
            // index. Unfiltered queries keep the plain ANN path.
            const source = where.length > 0 ? `(SELECT * FROM "${table}" WHERE ${where.join(" AND ")})` : `"${table}"`;
            const statement =
                where.length > 0
                    ? `WITH filtered AS MATERIALIZED ${source} SELECT ${projection.join(", ")} FROM filtered ORDER BY ${distance} LIMIT ${bind(topK)}`
                    : `SELECT ${projection.join(", ")} FROM "${table}" ORDER BY ${distance} LIMIT ${bind(topK)}`;

            const rows = await client.query<{
                distance: number | string;
                embedding?: string;
                id: string;
                metadata?: Record<string, unknown> | null;
                namespace: null | string;
            }>(statement, parameters);

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
