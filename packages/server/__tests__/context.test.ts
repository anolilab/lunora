import { describe, expect, expectTypeOf, it } from "vitest";

import type { MutationCtx as MutationContext, QueryCtx as QueryContext, ReadOnlyStorage, Storage } from "../src/index.js";
import { query, v } from "../src/index.js";

/**
 * Asserts at compile time that `Lhs` and `Rhs` are mutually assignable.
 * Wrapped in a function so the noop call below keeps vitest happy without
 * leaking type-only helpers into the runtime build.
 */
type Assert<T extends true> = T;
type Extends<X, Y> = X extends Y ? true : false;

describe("queryCtx.storage / MutationCtx.storage", () => {
    it("exposes the read-only storage surface (getSignedUrl, getUrl, download)", () => {
        expect.assertions(0);

        // Build a minimal `ReadOnlyStorage` double and verify it satisfies
        // both `QueryCtx["storage"]` and `MutationCtx["storage"]`.
        const storage: ReadOnlyStorage = {
            download: async (_key) => null,
            getSignedUrl: async (key, options) => `signed://${key}?expires=${String(options?.expiresInSeconds ?? 60)}`,
            getUrl: (key) => `https://cdn.example.com/${key}`,
        };

        const queryContext: QueryContext["storage"] = storage;
        const mutationContext: MutationContext["storage"] = storage;

        expectTypeOf(queryContext.getSignedUrl).toBeFunction();
        expectTypeOf(queryContext.getUrl).toBeFunction();
        expectTypeOf(queryContext.download).toBeFunction();
        expectTypeOf(mutationContext.getSignedUrl).toBeFunction();
    });

    it("does NOT expose write operations on QueryCtx.storage at the type level", () => {
        expect.assertions(1);

        // `upload` lives only on the full `cirrus-storage` Storage / on
        // `ActionCtx`. Asserting at compile-time that `QueryCtx["storage"]`
        // never grows it back guards against accidental regressions where
        // someone widens the type back to the full surface.
        type QueryStorage = QueryContext["storage"];

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

    it("a query handler can call ctx.storage.getSignedUrl", async () => {
        expect.assertions(2);

        const calls: { expiresInSeconds?: number; key: string }[] = [];

        const storage: ReadOnlyStorage = {
            download: async () => null,
            getSignedUrl: async (key, options) => {
                calls.push({ expiresInSeconds: options?.expiresInSeconds, key });

                return `signed://${key}`;
            },
            getUrl: (key) => `https://cdn.example.com/${key}`,
        };

        const getAvatar = query({
            args: { userId: v.id("users") },
            handler: async (context, { userId }): Promise<{ url: string }> => {
                const url = await context.storage.getSignedUrl(`avatars/${userId}/profile`, { expiresInSeconds: 300 });

                return { url };
            },
        });

        const context = {
            auth: { getIdentity: async () => null, userId: null },
            db: {} as QueryContext["db"],
            storage,
            vectors: {} as QueryContext["vectors"],
        } satisfies QueryContext;

        const result = await getAvatar.handler(context, { userId: "u_1" as unknown as Parameters<typeof getAvatar.handler>[1]["userId"] });

        expect(result).toEqual({ url: "signed://avatars/u_1/profile" });
        expect(calls).toEqual([{ expiresInSeconds: 300, key: "avatars/u_1/profile" }]);
    });
});
