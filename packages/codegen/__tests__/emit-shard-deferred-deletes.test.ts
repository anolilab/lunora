import { describe, expect, it } from "vitest";

import { emitShard } from "../src/emit";

/**
 * `ctx.storage.deleteAfterCommit(key)` — the object half of a row deletion,
 * flushed only once the write that removed the row has committed.
 *
 * The emitted shard is a STRING; nothing in this package compiles it (see
 * `emitted-shard-contract.ts`, which proves the same calls compile against the
 * real base class). So this suite pins the placement facts that make the feature
 * correct and that an innocuous-looking edit would silently break: the flush is
 * OUTSIDE the transaction, and EVERY dispatch that installs the queue also
 * drains it.
 */
const shard = (): string => emitShard({ schema: { tables: [], vectorIndexes: [] } });

/**
 * The body of one emitted method: from its signature to whichever member
 * declaration comes next. Sliced on declarations rather than by brace-matching,
 * so reformatting the emitted body cannot silently empty the slice and turn
 * these assertions green for the wrong reason.
 */
const methodBody = (emitted: string, signature: string): string => {
    const start = emitted.indexOf(signature);

    // Throw rather than `expect`, so this helper never inflates a caller's
    // `expect.assertions` count — a renamed method still fails loudly.
    if (start === -1) {
        throw new Error(`emitted shard has no ${signature}`);
    }

    const rest = emitted.slice(start + signature.length);
    const next = [...rest.matchAll(/\n {8}(?:private|protected|public) /gu)][0]?.index;

    return next === undefined ? rest : rest.slice(0, next);
};

describe("emitShard — deferred storage deletes", () => {
    it("installs the queue on every dispatch that can host a mutation handler", () => {
        expect.assertions(2);

        const emitted = shard();

        // Not mutations alone: `ctx.runMutation` hands the caller's ctx to the
        // callee, so a mutation reached from an action runs on the action's ctx.
        // Gating on `kind === "mutation"` made that composition throw a TypeError
        // on a method the handler's own type promises.
        expect(emitted).toContain('contextKind === "mutation" || contextKind === "action" ? withDeferredDeletes(storage) : storage');
        expect(emitted).toContain("storage: contextStorage,");
    });

    it("leaves ctx.db.system._storage on the unwrapped adapter", () => {
        expect.assertions(1);

        const emitted = shard();

        // `withDeferredDeletes` wraps the already-stamped facade into a SEPARATE
        // binding. If it replaced `storage` itself, the system reader would pick
        // up a `deleteAfterCommit` that no dispatch drains.
        expect(emitted).toContain("const contextStorage =");
    });

    it("flushes from every dispatch that installs the queue", () => {
        expect.assertions(3);

        const emitted = shard();

        // The coverage that matters: a wrap without a matching flush leaks
        // silently — no error, no warning, nothing to find. Every dispatch that can
        // run a mutation handler goes through `runMutationTransaction`, which
        // flushes; the action branch of `handleRpc` flushes whatever a composed
        // mutation queued after its own span had already settled.
        expect(methodBody(emitted, "private async runMutationTransaction<T>(")).toContain("flushDeferredDeletes(ctx)");
        expect(methodBody(emitted, "public override async handleRpc(")).toContain("flushDeferredDeletes(ctx)");
        expect(emitted.split("flushDeferredDeletes(ctx)")).toHaveLength(3);
    });

    it("flushes after the transaction resolves, never inside it", () => {
        expect.assertions(2);

        const emitted = shard();
        const helper = methodBody(emitted, "private async runMutationTransaction<T>(");
        const transaction = helper.indexOf("await this.runInTransaction(");
        const flush = helper.indexOf("flushDeferredDeletes(ctx)", transaction);

        // An R2 delete cannot roll back. Issued from inside the span, a delete
        // whose transaction later aborts destroys data the surviving row still
        // points at — so this ordering IS the guarantee.
        expect(transaction).toBeGreaterThan(-1);
        expect(flush).toBeGreaterThan(transaction);
    });

    it("defers the flush past the response instead of awaiting it on the hot path", () => {
        expect.assertions(1);

        const emitted = shard();

        expect(emitted).toContain("await this.deferPastResponse(flushDeferredDeletes(ctx));");
    });
});
