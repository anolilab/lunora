import { LunoraError } from "@lunora/errors";
import type { ShardHost } from "@lunora/platform";
import { describe, expect, it } from "vitest";

import { createShardHost } from "../src/cloudflare-host";

/**
 * Unit-level pins for the error-identity contract documented on `runSerialized`
 * and `transaction` in ../src/cloudflare-host.ts.
 *
 * The doubles below reproduce the two workerd behaviours those wrappers exist to
 * absorb (flatten on rethrow, abort on rejection). Because a double can only
 * assert against the author's model of the platform, the same properties are
 * pinned against the real thing by the conformance suite running under
 * `runInDurableObject` in `@lunora/do`'s workerd project.
 */

/** A `storage` double that flattens a thrown error exactly the way workerd does. */
const flatteningStorage = (): { calls: string[]; transaction: <R>(closure: () => Promise<R>) => Promise<R> } => {
    const calls: string[] = [];

    return {
        calls,
        transaction: async <R>(closure: () => Promise<R>): Promise<R> => {
            try {
                const value = await closure();

                calls.push("committed");

                return value;
            } catch (error) {
                calls.push("rolled-back");

                // The lossy re-throw this fix exists to survive: workerd keeps
                // only the stringified form. `cause` is carried for the lint
                // rule's benefit — the point of the double is that `code` /
                // `status` do NOT survive.
                throw new Error(String(error), { cause: error });
            }
        },
    };
};

const hostWith = (storage: Partial<DurableObjectState["storage"]> | Record<string, unknown>): ShardHost => createShardHost({ storage } as never);

/**
 * A `blockConcurrencyWhile` double that mirrors workerd's behaviour: a closure
 * that REJECTS aborts the object. The double records that abort so a regression
 * is visible rather than merely slower.
 */
const gate = (): { aborted: boolean; blockConcurrencyWhile: <R>(closure: () => Promise<R>) => Promise<R> } => {
    const record = {
        aborted: false,
        blockConcurrencyWhile: async <R>(closure: () => Promise<R>): Promise<R> => {
            try {
                return await closure();
            } catch (error) {
                record.aborted = true;

                throw new Error(String(error), { cause: error });
            }
        },
    };

    return record;
};

describe("cloudflare shard host transaction", () => {
    it("holds blockConcurrencyWhile for the whole closure, which is what defers a concurrent dispatch", async () => {
        expect.assertions(2);

        // The Cloudflare answer to `@lunora/platform`'s "never lets a task
        // outside a mutation observe its uncommitted writes" conformance leg.
        // This host contributes nothing to that guarantee itself — it is the
        // input gate, and the gate only covers what `blockConcurrencyWhile`
        // spans. A `runSerialized` that ran bare, or released before the
        // closure settled, would let workerd deliver the next `fetch` mid
        // transaction and read rows that are about to roll back, with no test
        // between it and production. The Node and reference hosts have no such
        // gate and refuse the read instead; both answers keep the guarantee.
        const spans: string[] = [];
        const host = createShardHost({
            blockConcurrencyWhile: async <R>(closure: () => Promise<R>): Promise<R> => {
                spans.push("gate-open");

                try {
                    return await closure();
                } finally {
                    spans.push("gate-closed");
                }
            },
            storage: {},
        } as never);

        const result = await host.runSerialized(async () => {
            spans.push("closure-start");

            await Promise.resolve();

            spans.push("closure-end");

            return "done";
        });

        expect(result).toBe("done");
        expect(spans).toStrictEqual(["gate-open", "closure-start", "closure-end", "gate-closed"]);
    });

    it("rethrows the handler's own error instance, not the platform's flattened copy", async () => {
        expect.assertions(2);

        const storage = flatteningStorage();
        const thrown = new LunoraError("NOT_FOUND", "lobby not found");

        // Identity, not shape: a reconstructed copy can carry the same message
        // and still have lost `code`/`status`, which is the whole failure.
        await expect(hostWith(storage).transaction(() => Promise.reject(thrown))).rejects.toBe(thrown);

        // The closure must still throw INTO the platform, or nothing rolls back.
        expect(storage.calls).toStrictEqual(["rolled-back"]);
    });

    it("still surfaces a platform-side failure that the closure never raised", async () => {
        expect.assertions(1);

        // A commit/rollback fault belongs to the platform: there is no handler
        // error to restore, so it must not be swallowed or replaced.
        const storage = {
            transaction: async <R>(closure: () => Promise<R>): Promise<R> => {
                await closure();

                throw new Error("commit failed");
            },
        };

        await expect(hostWith(storage).transaction(() => Promise.resolve("ok"))).rejects.toThrow("commit failed");
    });

    it("passes a successful result through untouched", async () => {
        expect.assertions(2);

        const storage = flatteningStorage();

        await expect(hostWith(storage).transaction(() => Promise.resolve({ moved: 1 }))).resolves.toStrictEqual({ moved: 1 });
        expect(storage.calls).toStrictEqual(["committed"]);
    });

    it("preserves a thrown `undefined` rather than reporting the flattened error", async () => {
        expect.assertions(1);

        // The saved throw is boxed, so "the closure threw undefined" stays
        // distinguishable from "the closure never threw". Thrown from the body
        // rather than `Promise.reject(undefined)` so the non-Error rejection is
        // expressed the way a handler would actually produce it.
        const throwsUndefined = async (): Promise<never> => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately non-Error: surviving a non-Error throw is what this asserts
            throw undefined;
        };

        await expect(hostWith(flatteningStorage()).transaction(throwsUndefined)).rejects.toBeUndefined();
    });

    it("runs bare when the storage double has no transaction support", async () => {
        expect.assertions(1);

        await expect(hostWith({}).transaction(() => Promise.resolve("bare"))).resolves.toBe("bare");
    });

    it("does not abort the Durable Object when a handler throws", async () => {
        expect.assertions(3);

        // workerd tears the object down when a `blockConcurrencyWhile` closure
        // rejects — taking its in-memory state and every hibernating WebSocket
        // subscription with it. An ordinary application error must not cost the
        // shard its object, nor every other client connected to it.
        const state = gate();
        const host = createShardHost({ ...state, storage: {} } as never);
        const thrown = new LunoraError("CONFLICT", "not your turn");

        await expect(host.runSerialized(() => Promise.reject(thrown))).rejects.toBe(thrown);

        expect(state.aborted).toBe(false);
        // And the gate still serializes the success path.
        await expect(host.runSerialized(() => Promise.resolve(7))).resolves.toBe(7);
    });

    it("keeps the coded error intact through the full mutation path (gate + transaction)", async () => {
        expect.assertions(2);

        // `runInTransaction` composes both boundaries, and both flatten. This is
        // the shape a real mutation error travels through.
        const state = gate();
        const storage = flatteningStorage();
        const host = createShardHost({ ...state, storage } as never);
        const thrown = new LunoraError("NOT_FOUND", "lobby not found");

        await expect(host.runSerialized(async () => host.transaction(() => Promise.reject(thrown)))).rejects.toMatchObject({
            code: "NOT_FOUND",
            status: 404,
        });

        expect(storage.calls).toStrictEqual(["rolled-back"]);
    });

    it("attaches a platform failure as the cause when both fail", async () => {
        expect.assertions(2);

        const storage = {
            transaction: async <R>(closure: () => Promise<R>): Promise<R> => {
                await closure().catch(() => undefined);

                throw new Error("rollback failed");
            },
        };
        const thrown = new LunoraError("CONFLICT", "not your turn");

        await expect(hostWith(storage).transaction(() => Promise.reject(thrown))).rejects.toBe(thrown);
        expect((thrown.cause as Error | undefined)?.message).toBe("rollback failed");
    });

    it("still delivers the closure's error when it cannot carry a cause", async () => {
        expect.assertions(2);

        // A frozen sentinel error rejects the `cause` write with a `TypeError`.
        // Unguarded, that TypeError would replace the error the handler threw —
        // the exact loss this wrapper exists to prevent.
        const storage = {
            transaction: async <R>(closure: () => Promise<R>): Promise<R> => {
                await closure().catch(() => undefined);

                throw new Error("rollback failed");
            },
        };
        const frozen = Object.freeze(new LunoraError("CONFLICT", "not your turn"));

        await expect(hostWith(storage).transaction(() => Promise.reject(frozen))).rejects.toBe(frozen);
        expect(frozen.cause).toBeUndefined();
    });
});
