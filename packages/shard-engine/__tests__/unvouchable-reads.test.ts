/* eslint-disable no-secrets/no-secrets -- the flagged high-entropy string is this suite's own subject, the exported helper name `markUnvouchableReads`, not a credential. */

/**
 * `markUnvouchableReads` is what puts `ctx.kv` / `ctx.storage` / `ctx.vectors` /
 * `ctx.flags` / `ctx.db.system` into a subscription's read-set at all. Without a
 * stamp those reads are invisible to `cdcCanVouchFor`, which then vouches for a
 * read-set that never named them and hands a reconnecting client a `resume`
 * frame for a value that has since moved.
 *
 * The rules worth pinning down are the two that are easy to get subtly wrong:
 * stamping must happen on CALL (property access is feature detection, which runs
 * at ctx-build time for every request), and the allowlist must be honoured
 * exactly (`ctx.storage.getUrl` reads nothing and must stay resumable).
 */
import { describe, expect, it } from "vitest";

import { createReadFootprint, markUnvouchableReads, UNVOUCHABLE_DEP } from "../src/read-footprint";
import { writeTouchesMemo } from "../src/subscription-range-gate";

/** A storage-shaped facade: one method that reaches R2, one that only builds a URL. */
const createFacade = () => {
    return {
        base: "https://cdn.example",
        async download(key: string): Promise<string> {
            return `body:${key}`;
        },
        getUrl(this: { base: string }, key: string): string {
            // Reads `this` so the wrapper's `this`-binding is actually exercised.
            return `${this.base}/${key}`;
        },
    };
};

describe("markUnvouchableReads", () => {
    it("stamps the sentinel when an allowlisted method is CALLED", async () => {
        expect.assertions(2);

        const footprint = createReadFootprint();
        const storage = markUnvouchableReads(createFacade(), footprint.onRead, ["download"]);

        await expect(storage.download("a.png")).resolves.toBe("body:a.png");
        expect(footprint.tables).toStrictEqual(new Set([UNVOUCHABLE_DEP]));
    });

    it("does NOT stamp on property access alone", () => {
        expect.assertions(2);

        // `createShardCtxDb` probes `typeof scheduler.list === "function"` before
        // it wires `ctx.db.system`, and that probe runs while the ctx is being
        // built — before the handler has read anything. A `get` trap that stamped
        // eagerly would mark every query in a scheduler-enabled app un-resumable.
        const footprint = createReadFootprint();
        const storage = markUnvouchableReads(createFacade(), footprint.onRead, ["download"]);

        expect(typeof storage.download).toBe("function");
        expect(footprint.tables.size).toBe(0);
    });

    it("leaves a method outside the allowlist alone, `this` included", () => {
        expect.assertions(2);

        // `getUrl` builds a string from configured state and reads nothing that
        // can change under the subscriber, so stamping it would cost a
        // re-snapshot for a dependency that cannot move the result.
        const footprint = createReadFootprint();
        const storage = markUnvouchableReads(createFacade(), footprint.onRead, ["download"]);

        expect(storage.getUrl("a.png")).toBe("https://cdn.example/a.png");
        expect(footprint.tables.size).toBe(0);
    });

    it("returns the facade untouched when no read hook is wired", () => {
        expect.assertions(1);

        // The plain RPC dispatch path passes `undefined`: only a subscription
        // builds the read-set the resume verdict reads.
        const facade = createFacade();

        expect(markUnvouchableReads(facade, undefined, ["download"])).toBe(facade);
    });

    it("keeps the sentinel out of the live-refresh gate", () => {
        expect.assertions(2);

        // The sentinel is deliberately NOT the `"*"` admin wildcard, which makes
        // `refreshSubscriptions` re-run a memo on EVERY write-flush. A query that
        // read KV should still re-run exactly when one of its real tables moves —
        // forfeiting the reconnect resume must not also buy a per-write tax.
        const memo = { tables: new Set(["messages", UNVOUCHABLE_DEP]) };

        expect(UNVOUCHABLE_DEP).not.toBe("*");
        // `users` is written; the memo's real table `messages` was not, and the
        // sentinel can never appear in a written-table set.
        expect(writeTouchesMemo(memo, new Set(["users"]), new Map())).toBe(false);
    });
});
