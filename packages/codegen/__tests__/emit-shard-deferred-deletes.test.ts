import { describe, expect, it } from "vitest";

import { emitShard } from "../src/emit";

/**
 * `ctx.storage.deleteAfterCommit(key)` — the object half of a row deletion,
 * flushed only once the mutation's transaction has committed.
 *
 * The emitted shard is a STRING; nothing in this package compiles it (see
 * `emitted-shard-contract.ts`, which proves the same calls compile against the
 * real base class). So this suite pins the two placement facts that make the
 * feature correct and that an innocuous-looking edit would silently break: the
 * flush is OUTSIDE the transaction, and the queue is attached to a mutation's
 * context only.
 */
const shard = (): string => emitShard({ schema: { tables: [], vectorIndexes: [] } });

describe("emitShard — deferred storage deletes", () => {
    it("wraps ctx.storage for a mutation and leaves every other kind alone", () => {
        expect.assertions(2);

        const emitted = shard();

        // A query has no transaction to commit and an action has the real
        // `delete`; wrapping either would put a method on `ctx.storage` that
        // nothing ever drains.
        expect(emitted).toContain('?.kind === "mutation" ? withDeferredDeletes(storage) : storage');
        expect(emitted).toContain("storage: contextStorage,");
    });

    it("shares the read-stamped adapter with ctx.db.system._storage rather than the wrapped one", () => {
        expect.assertions(1);

        const emitted = shard();

        // `withDeferredDeletes` wraps the ALREADY-stamped facade into a separate
        // binding. If the wrap replaced `storage` itself, the system reader would
        // pick up a `deleteAfterCommit` it can never flush.
        expect(emitted).toContain("const contextStorage =");
    });

    it("flushes after the transaction resolves, not inside it", () => {
        expect.assertions(3);

        const emitted = shard();
        const branch = emitted.slice(emitted.indexOf('if (registered.kind === "mutation")'));
        const flushAt = branch.indexOf("flushDeferredDeletes(dispatchCtx.storage)");
        const transactionEndsAt = branch.indexOf("});");

        // An R2 delete cannot roll back. Issued from inside the span, a delete
        // whose transaction later aborts destroys data the surviving row still
        // points at — so ordering here IS the guarantee.
        expect(flushAt).toBeGreaterThan(-1);
        expect(transactionEndsAt).toBeGreaterThan(-1);
        expect(flushAt).toBeGreaterThan(transactionEndsAt);
    });

    it("defers the flush past the response instead of awaiting it on the hot path", () => {
        expect.assertions(1);

        const emitted = shard();

        expect(emitted).toContain("await this.deferPastResponse(");
    });

    it("reports a failed delete without failing the committed mutation", () => {
        expect.assertions(2);

        const emitted = shard();
        const branch = emitted.slice(emitted.indexOf('if (registered.kind === "mutation")'));

        // The write already succeeded; a cleanup failure must leak an object and
        // say which one, never turn into a 500 for a mutation that committed.
        expect(branch).toContain("outcome.failures");
        expect(branch).toContain("object leaked");
    });
});
