import { describe, expect, it } from "vitest";

import { emitShard } from "../src/emit";

/**
 * The dispatch guarantees the docs sell, pinned on the emitted text.
 *
 * The emitted shard is a STRING; nothing in this package compiles or runs it
 * (`emitted-shard-contract.ts` proves the calls compile against the real base
 * class, and `@lunora/testing`'s `transactional-composition.test.ts` pins the
 * behaviour). So this suite pins the placement facts that make three documented
 * promises true, each of which an innocuous-looking edit would silently undo.
 *
 * One: a mutation reached through `ctx.runMutation` gets the SAME transaction
 * wrapper the top-level RPC gets ("do the transactional reads and writes inside a
 * `mutation` and call it from the action").
 *
 * Two: `ctx.scheduler` inside a mutation is buffered until that transaction
 * commits ("the deterministic equivalent of an `afterCommit` hook").
 *
 * Three: a query ctx cannot compose a mutation or an action ("There is no
 * `runMutation`/`runAction`" on `QueryCtx`).
 */
const shard = (): string => emitShard({ schema: { tables: [], vectorIndexes: [] } });

/**
 * The body of one emitted method: from its signature to whichever member
 * declaration comes next. Sliced on declarations rather than by brace-matching,
 * so reformatting the emitted body cannot silently empty the slice and turn these
 * assertions green for the wrong reason.
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

describe("emitShard — transactional ctx.runMutation", () => {
    it("routes every mutation dispatch through the one transaction helper", () => {
        expect.assertions(3);

        const emitted = shard();

        // The top-level RPC, a reactor, and `ctx.runMutation`. A second copy of the
        // span is how the composed path drifted out of atomicity in the first place.
        expect(methodBody(emitted, "public override async handleRpc(")).toContain("await this.runMutationTransaction(ctx, async () => {");
        expect(methodBody(emitted, "protected override async runReactor(")).toContain("await this.runMutationTransaction(ctx, async () =>");
        expect(emitted).toContain(
            'dispatchRun("mutation", reference.__lunoraRef, fnArgs, ctx, contextKind, async (work) => this.runMutationTransaction(ctx, work))',
        );
    });

    it("opens the span exactly once, in that helper", () => {
        expect.assertions(1);

        const emitted = shard();

        // `runInTransaction` rejects a nested open, so the helper is also the only
        // place that may decide to skip it.
        expect(emitted.split("await this.runInTransaction(")).toHaveLength(2);
    });

    it("runs a composed mutation inline when a transaction is already open", () => {
        expect.assertions(2);

        const emitted = shard();
        const helper = methodBody(emitted, "private async runMutationTransaction<T>(");

        // A `ctx.runMutation` from inside a mutation is NESTED: SQLite-in-DO has no
        // savepoints, so it rides the enclosing span rather than opening a second.
        expect(helper).toContain("if (this.isInTransaction()) {");
        expect(helper.indexOf("if (this.isInTransaction()) {")).toBeLessThan(helper.indexOf("await this.runInTransaction(work)"));
    });

    it("dispatches the handler under the caller's wrapper when one is supplied", () => {
        expect.assertions(1);

        const emitted = shard();

        expect(emitted).toContain("return await runTransactional(async () => registered.handler(ctx, args));");
    });
});

describe("emitShard — deferred scheduling", () => {
    it("installs the buffer on every dispatch that can host a mutation handler", () => {
        expect.assertions(2);

        const emitted = shard();

        // Not mutations alone, for the same reason the deferred-delete queue is not:
        // `ctx.runMutation` hands the CALLER's ctx to the callee.
        expect(emitted).toContain('contextKind === "mutation" || contextKind === "action" ? withDeferredSchedules(schedulerBase) : schedulerBase');
        expect(emitted).toContain("scheduler,");
    });

    it("wraps outside the read-stamping facade so get/list stay stamped", () => {
        expect.assertions(2);

        const emitted = shard();

        expect(emitted).toContain(
            'const schedulerBase = markUnvouchableReads((config.scheduler?.(env) ?? schedulerStub) as SchedulerLike, options.onRead, ["get", "list"]);',
        );
        expect(emitted.indexOf("const schedulerBase =")).toBeLessThan(emitted.indexOf("withDeferredSchedules(schedulerBase)"));
    });

    it("settles the buffer against the transaction outcome, and only after it resolves", () => {
        expect.assertions(3);

        const emitted = shard();
        const helper = methodBody(emitted, "private async runMutationTransaction<T>(");
        const open = helper.indexOf("beginDeferredSchedules(ctx as { scheduler?: unknown })");
        const span = helper.indexOf("await this.runInTransaction(work)");

        expect(open).toBeGreaterThan(-1);
        // The window opens before the span and the commit settle comes after it: a
        // job enqueued mid-transaction can fire against state that never landed.
        expect(open).toBeLessThan(span);
        expect(helper.indexOf("await settleSchedules(true);", span)).toBeGreaterThan(span);
    });

    it("discards the buffer when the span throws", () => {
        expect.assertions(1);

        const emitted = shard();

        expect(methodBody(emitted, "private async runMutationTransaction<T>(")).toContain("await settleSchedules(false);");
    });
});

describe("emitShard — ctx.run* caller guard", () => {
    it("refuses a mutation or action composed from a query context", () => {
        expect.assertions(2);

        const emitted = shard();

        // The ctx installs `run*` on every kind (one object shape), so the TYPE is
        // all that stops a read-only handler from writing — and a cast walks past
        // it, inside a subscription re-run that may execute many times per write.
        expect(emitted).toContain('if (callerKind === "query" && expected !== "query") {');
        expect(emitted).toContain('throw new LunoraError(\n            "RUN_KIND_FORBIDDEN",');
    });

    it("threads the calling context's kind into every run* entry point", () => {
        expect.assertions(3);

        const emitted = shard();

        expect(emitted).toContain('dispatchRun("action", reference.__lunoraRef, fnArgs, ctx, contextKind)');
        expect(emitted).toContain('dispatchRun("mutation", reference.__lunoraRef, fnArgs, ctx, contextKind,');
        // `runQuery` passes it too: its untracked form builds a fresh ctx, so the
        // kind cannot be recovered from the ctx it is handed.
        expect(methodBody(emitted, "private buildCtx(")).toContain("                    contextKind,\n                );");
    });

    it("checks the caller before the registry lookup, so the refusal does not depend on the target", () => {
        expect.assertions(2);

        const emitted = shard();
        const dispatch = emitted.indexOf("const dispatchRun = async (");
        const guard = emitted.indexOf('if (callerKind === "query" && expected !== "query")', dispatch);
        // eslint-disable-next-line no-secrets/no-secrets -- matching an emitted TypeScript statement, not a credential
        const lookup = emitted.indexOf("const registered = LUNORA_FUNCTIONS[functionPath];", dispatch);

        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(lookup);
    });
});
