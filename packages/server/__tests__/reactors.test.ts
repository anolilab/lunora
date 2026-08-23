import { describe, expect, it } from "vitest";

import type { ReactorOutcome } from "../src/reactors";
import { onQueryChange } from "../src/reactors";
import type { QueryCtx } from "../src/types";

/**
 * `onQueryChange` — the registration and the digest comparison that is the whole
 * point of a reactor.
 *
 * A trigger fires on a row write. A reactor fires only when the watched read's
 * RESULT changed, and these tests pin that difference: same result in, handler
 * suppressed; different result in, handler runs. The rest of the machinery (the
 * footprint gate, the durable baseline, the convergence bound) belongs to the
 * shard and is covered in `@lunora/do`'s `shard-do.reactors.test.ts`.
 */

/**
 * Dispatch a reactor the way the shard does. The registration's `args` is typed
 * `Record<string, never>` (a reactor takes no app arguments), so the
 * framework-supplied `{ previousDigest }` is cast in — the shard passes the same
 * value through the same seam.
 */
const run = async (registered: ReturnType<typeof onQueryChange>, previousDigest?: string): Promise<ReactorOutcome> =>
    await registered.handler({}, { previousDigest } as unknown as Record<string, never>);

describe("onQueryChange", () => {
    it("registers as an internal mutation tagged `reactor`", () => {
        expect.assertions(3);

        const registered = onQueryChange(
            () => [],
            () => undefined,
        );

        // Internal: a client must never be able to invoke a reactor by path.
        expect(registered.visibility).toBe("internal");
        expect(registered.kind).toBe("mutation");
        expect(registered.lifecycle).toBe("reactor");
    });

    it("runs the handler on the first dispatch, when there is no baseline", async () => {
        expect.assertions(3);

        const seen: unknown[] = [];
        const registered = onQueryChange(
            () => ["a"],
            (_ctx, result) => {
                seen.push(result);
            },
        );

        const outcome = await run(registered);

        // "No baseline" reads as "changed" — never as "unchanged". The redundant
        // run is the acceptable failure; a missed one is silent and permanent.
        expect(outcome.ran).toBe(true);
        expect(seen).toStrictEqual([["a"]]);
        expect(outcome.digest).toHaveLength(16);
    });

    it("suppresses the handler when the result is unchanged", async () => {
        expect.assertions(3);

        let calls = 0;
        const registered = onQueryChange(
            () => {
                return { pending: 2 };
            },
            () => {
                calls += 1;
            },
        );

        const first = await run(registered);
        const second = await run(registered, first.digest);

        expect(first.ran).toBe(true);
        expect(second.ran).toBe(false);
        // Only the first: a write that touched the table but did not move the
        // result costs one query and stops there.
        expect(calls).toBe(1);
    });

    it("runs the handler again once the result moves", async () => {
        expect.assertions(2);

        let pending = 2;
        const registered = onQueryChange(
            () => {
                return { pending };
            },
            () => undefined,
        );

        const first = await run(registered);

        pending = 3;

        const second = await run(registered, first.digest);

        expect(second.ran).toBe(true);
        expect(second.digest).not.toBe(first.digest);
    });

    it("digests by structure, not by key order", async () => {
        expect.assertions(1);

        const a = await run(
            onQueryChange(
                () => {
                    return { desk: "x", status: "waiting" };
                },
                () => undefined,
            ),
        );
        const b = await run(
            onQueryChange(
                () => {
                    return { status: "waiting", desk: "x" };
                },
                () => undefined,
            ),
        );

        // `stableStringify`, not `JSON.stringify`: if key order decided the
        // digest, an unrelated refactor of a select would re-fire every reactor.
        expect(a.digest).toBe(b.digest);
    });

    it("passes the current result to the handler and awaits it", async () => {
        expect.assertions(2);

        const order: string[] = [];
        const registered = onQueryChange(
            async (_ctx: QueryCtx) => {
                order.push("select");

                return [1, 2];
            },
            async (_ctx, result) => {
                await Promise.resolve();
                order.push(`handler:${JSON.stringify(result)}`);
            },
        );

        const outcome = await run(registered);

        expect(order).toStrictEqual(["select", "handler:[1,2]"]);
        expect(outcome.ran).toBe(true);
    });

    it("reports the digest even when the handler throws, without swallowing it", async () => {
        expect.assertions(1);

        const registered = onQueryChange(
            () => ["a"],
            () => {
                throw new Error("handler failed");
            },
        );

        // The throw propagates to the shard, which contains it and — critically —
        // does NOT advance the baseline, so the next flush retries.
        await expect(run(registered)).rejects.toThrow("handler failed");
    });
});
