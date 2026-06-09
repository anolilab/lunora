import type { CustomAdapter } from "better-auth/adapters";
import { createAdapterFactory } from "better-auth/adapters";

import type { AuthRow, AuthStore } from "./store.js";

// better-auth's `CustomAdapter` methods are generic over the caller's row type;
// our store speaks the opaque `AuthRow`. These three name that (necessary)
// boundary conversion per result shape, so the unsound-but-required cast lives in
// one labelled place instead of scattered `as never` at every return.

/** A single stored row, as better-auth's generic result. */
const asRow = (row: AuthRow): never => row as never;

/** A stored row or "not found" — better-auth's contracts return `null` for the miss. */
// eslint-disable-next-line unicorn/no-null -- better-auth's findOne/update/consumeOne return null when nothing matched
const asRowOrNull = (row: AuthRow | undefined): never => (row ?? null) as never;

/** A page of stored rows, as better-auth's generic result. */
const asRows = (rows: AuthRow[]): never => rows as never;

/**
 * A better-auth database adapter backed by an {@link AuthStore} — the bridge
 * that routes better-auth's reads and writes through Cirrus's data layer
 * instead of better-auth's built-in D1/Kysely adapter. Pass the result as
 * `createAuth({ database: cirrusAuthAdapter(store) })`; better-auth's
 * `createAdapterFactory` handles id generation, default values, field-name
 * mapping and output shaping, so this only translates the cleaned CRUD calls
 * onto the store.
 *
 * ```ts
 * const auth = createAuth({
 *     secret: env.AUTH_SECRET,
 *     emailAndPassword: { enabled: true },
 *     database: cirrusAuthAdapter(cirrusStore), // cirrusStore writes via ctx.db
 * });
 * ```
 *
 * Scope: the {@link AuthStore} interface is single-table CRUD. better-auth's
 * relational `join` reads (an advanced opt-in) are not handled — pair the
 * adapter with `disableJoins` or let better-auth fall back to per-table reads.
 */
const cirrusAuthAdapter = (store: AuthStore): ReturnType<typeof createAdapterFactory> =>
    createAdapterFactory({
        adapter: (): CustomAdapter => {
            return {
                consumeOne: async ({ model, where }) => asRowOrNull(await store.consumeOne(model, where)),
                count: async ({ model, where }) => store.count(model, where ?? []),
                create: async ({ data, model }) => asRow(await store.create(model, data)),
                delete: async ({ model, where }) => {
                    await store.remove(model, where);
                },
                deleteMany: async ({ model, where }) => store.remove(model, where),
                findMany: async ({ limit, model, offset, sortBy, where }) => asRows(await store.read(model, { limit, offset, sortBy, where: where ?? [] })),
                findOne: async ({ model, where }) => {
                    const [row] = await store.read(model, { limit: 1, where });

                    return asRowOrNull(row);
                },
                update: async ({ model, update, where }) => {
                    const [row] = await store.update(model, where, update as AuthRow);

                    return asRowOrNull(row);
                },
                updateMany: async ({ model, update, where }) => {
                    const updated = await store.update(model, where, update as AuthRow);

                    return updated.length;
                },
            };
        },
        config: {
            adapterId: "cirrus",
            adapterName: "Cirrus Adapter",
            // Conservative flags so the adapter is store-agnostic: better-auth
            // serializes dates/booleans/json to primitives (string/number) before a
            // write and parses them back after a read, so a store — in-memory or
            // SQL — only ever handles primitives, never schema-aware codecs.
            supportsBooleans: false,
            supportsDates: false,
            supportsJSON: false,
            supportsNumericIds: false,
        },
    });

export default cirrusAuthAdapter;
