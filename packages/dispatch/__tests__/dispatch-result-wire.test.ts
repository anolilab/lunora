/**
 * The dispatch runner's RESULT wire — the mirror of `dispatch-args-wire.test.ts`.
 *
 * The shard is the single encoder on this half: `shard-do`'s dispatch loop calls
 * `buildDispatchResponse(mutatorClass, encodeWire(result))`, which wraps the
 * encoded value as `{ result }` (plus `commitCursor` for a plain mutation, or
 * `lastMutationId` for a `"next"` custom-mutator push). `handleSchedulerDispatch`
 * and `dispatchToShard` (`@lunora/runtime`) forward that response verbatim, so the
 * runner is the single decoder — it owns both directions of the wire.
 *
 * These pin what a `ctx.run` CALLER receives: the function's own return value, not
 * the transport envelope, and with `bigint`/`Date`/bytes restored. The `Date` case
 * is the one that fails silently — an un-decoded `Date` is a tagged array, and a
 * doubly-decoded one is `{}` — so assert the TYPE, never merely the absence of a
 * throw.
 *
 * The envelope literals below are the same ones `packages/do`'s
 * `shard-do.dispatch-result-wire.test.ts` asserts a real shard emits, and both
 * sides run the payload through the same `shared/wire-codec` — that is the join.
 */
import { describe, expect, it } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import { createDispatchRunner } from "../src/create-dispatch-runner";
import type { FunctionReference } from "../src/types";

const ENV = { LUNORA_ADMIN_TOKEN: "admin-token", LUNORA_ORIGIN_URL: "https://app.example" };
const REF: FunctionReference = { __lunoraRef: "jobs:charge" };

/** What `await ctx.run(fn)` resolves to when the shard answers with `body`. */
const runResult = async (body: string): Promise<unknown> => {
    const run = createDispatchRunner({
        env: ENV,
        fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" }, status: 200 }),
        label: "@lunora/queue",
    });

    return run(REF, {});
};

/** The exact body a shard sends for a function returning `value` — `encodeWire`, wrapped in the envelope. */
const shardBody = (value: unknown, envelope: Record<string, unknown> = {}): string => JSON.stringify({ ...envelope, result: encodeWire(value) });

describe("dispatch runner result wire", () => {
    it("resolves a bigint return value as a bigint", async () => {
        expect.assertions(2);

        const result = await runResult(shardBody({ amountCents: 4_294_967_296n }));

        expect(typeof (result as { amountCents?: unknown }).amountCents).toBe("bigint");
        expect(result).toStrictEqual({ amountCents: 4_294_967_296n });
    });

    it("resolves a Date return value as a Date", async () => {
        expect.assertions(2);

        // The TYPE, not the absence of a throw: an un-decoded `Date` comes back
        // as a tagged array and a doubly-decoded one as `{}` — neither throws.
        const result = await runResult(shardBody({ dueAt: new Date("2026-06-01T12:00:00.000Z") }));

        expect((result as { dueAt?: unknown }).dueAt).toBeInstanceOf(Date);
        expect((result as { dueAt: Date }).dueAt.toISOString()).toBe("2026-06-01T12:00:00.000Z");
    });

    it("resolves bytes as bytes", async () => {
        expect.assertions(2);

        const result = await runResult(shardBody({ blob: new Uint8Array([1, 2, 3]) }));

        expect((result as { blob?: unknown }).blob).toBeInstanceOf(Uint8Array);
        expect([...(result as { blob: Uint8Array }).blob]).toStrictEqual([1, 2, 3]);
    });

    it("resolves a plain-JSON return value unchanged", async () => {
        expect.assertions(1);

        const plain = { count: 3, flag: true, nested: { items: [1, 2, "three"], missing: null }, note: "hi" };

        await expect(runResult(shardBody(plain))).resolves.toStrictEqual(plain);
    });

    it("resolves an array return value as the array itself, not the envelope", async () => {
        expect.assertions(2);

        // `@lunora/agent`'s loop casts this straight to `AgentMessageRow[]` and
        // then iterates it — the envelope is an object, so the cast was a lie.
        const rows = [
            { role: "user", seq: 1 },
            { role: "assistant", seq: 2 },
        ];
        const result = await runResult(shardBody(rows));

        expect(Array.isArray(result)).toBe(true);
        expect(result).toStrictEqual(rows);
    });

    it("unwraps a plain mutation's `commitCursor` envelope", async () => {
        expect.assertions(1);

        await expect(runResult(shardBody({ ok: true }, { commitCursor: 12 }))).resolves.toStrictEqual({ ok: true });
    });

    it("unwraps a custom-mutator push's `lastMutationId` envelope", async () => {
        expect.assertions(1);

        await expect(runResult(shardBody({ runs: 1 }, { lastMutationId: 3 }))).resolves.toStrictEqual({ runs: 1 });
    });

    it("resolves undefined for a void function", async () => {
        expect.assertions(1);

        // `encodeWire` tags a top-level `undefined` rather than letting
        // `JSON.stringify` drop the key, so the shard really does send
        // `{ result: ["$lunora.wire$","undefined"] }` — pinned on the shard side
        // by `packages/do`'s `shard-do.dispatch-result-wire.test.ts`.
        await expect(runResult(shardBody(undefined))).resolves.toBeUndefined();
    });

    it("refuses a 200 that is not a { result } envelope", async () => {
        expect.assertions(1);

        // Not the same as a void return. Every arm of `buildDispatchResponse`
        // spells `result` literally, so a 200 without the key is a body the
        // shard cannot emit — something else answered. Reading it as
        // `undefined` would hand a handler a silent wrong answer, so it is
        // refused rather than guessed at.
        await expect(runResult(JSON.stringify({ commitCursor: 7 }))).rejects.toThrow(/not a \{ result \} envelope/u);
    });

    it("resolves undefined for an empty body", async () => {
        expect.assertions(1);

        await expect(runResult("")).resolves.toBeUndefined();
    });
});
