import { describe, expect, expectTypeOf, test } from "vitest";

import type { MutationCtx, QueryCtx, ReadOnlyStorage, Storage } from "../src/index.js";
import { query, v } from "../src/index.js";

/**
 * Asserts at compile time that `Lhs` and `Rhs` are mutually assignable.
 * Wrapped in a function so the noop call below keeps vitest happy without
 * leaking type-only helpers into the runtime build.
 */
type Assert<T extends true> = T;
type Extends<X, Y> = X extends Y ? true : false;

describe("queryCtx.storage / MutationCtx.storage", () => {
    test("exposes the read-only storage surface (getSignedUrl, getUrl, download)", () => {
        // Build a minimal `ReadOnlyStorage` double and verify it satisfies
        // both `QueryCtx["storage"]` and `MutationCtx["storage"]`.
        const storage: ReadOnlyStorage = {
            download: async (_key) => null,
            getSignedUrl: async (key, opts) => `signed://${key}?expires=${opts?.expiresInSeconds ?? 60}`,
            getUrl: (key) => `https://cdn.example.com/${key}`,
        };

        const queryCtx: QueryCtx["storage"] = storage;
        const mutationCtx: MutationCtx["storage"] = storage;

        expectTypeOf(queryCtx.getSignedUrl).toBeFunction();
        expectTypeOf(queryCtx.getUrl).toBeFunction();
        expectTypeOf(queryCtx.download).toBeFunction();
        expectTypeOf(mutationCtx.getSignedUrl).toBeFunction();
    });

    test("does NOT expose write operations on QueryCtx.storage at the type level", () => {
        // `upload` lives only on the full `cirrus-storage` Storage / on
        // `ActionCtx`. Asserting at compile-time that `QueryCtx["storage"]`
        // never grows it back guards against accidental regressions where
        // someone widens the type back to the full surface.
        type QueryStorage = QueryCtx["storage"];

        // `upload` must NOT be assignable as a key of `QueryStorage`.
        type NoUpload = Assert<Extends<"upload", keyof QueryStorage> extends true ? false : true>;
        // `delete` is on full `Storage` but stripped from `ReadOnlyStorage`.
        type NoDelete = Assert<Extends<"delete", keyof QueryStorage> extends true ? false : true>;
        // Storage (full) does expose `delete` (smoke check that the wider
        // alias still resolves and is distinct from the read-only one).
        type StorageHasDelete = Assert<Extends<"delete", keyof Storage>>;

        // Surface the asserted aliases through a tuple read so `tsc --noEmit`
        // doesn't flag them as unused while still keeping the type-level
        // checks above as the actual contract.
        const _checks: [NoUpload, NoDelete, StorageHasDelete] = [true, true, true];

        expect(_checks).toEqual([true, true, true]);
    });

    test("a query handler can call ctx.storage.getSignedUrl", async () => {
        const calls: Array<{ expiresInSeconds?: number; key: string }> = [];

        const storage: ReadOnlyStorage = {
            download: async () => null,
            getSignedUrl: async (key, opts) => {
                calls.push({ key, expiresInSeconds: opts?.expiresInSeconds });

                return `signed://${key}`;
            },
            getUrl: (key) => `https://cdn.example.com/${key}`,
        };

        const getAvatar = query({
            args: { userId: v.id("users") },
            handler: async (ctx, { userId }): Promise<{ url: string }> => {
                const url = await ctx.storage.getSignedUrl(`avatars/${userId}/profile`, { expiresInSeconds: 300 });

                return { url };
            },
        });

        const ctx = {
            auth: { getIdentity: async () => null, userId: null },
            db: {} as QueryCtx["db"],
            storage,
            vectors: {} as QueryCtx["vectors"],
        } satisfies QueryCtx;

        const result = await getAvatar.handler(ctx, { userId: "u_1" as unknown as Parameters<typeof getAvatar.handler>[1]["userId"] });

        expect(result).toEqual({ url: "signed://avatars/u_1/profile" });
        expect(calls).toEqual([{ key: "avatars/u_1/profile", expiresInSeconds: 300 }]);
    });
});
