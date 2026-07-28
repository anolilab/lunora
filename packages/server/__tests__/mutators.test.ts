import { describe, expect, it, vi } from "vitest";

import type { MutationCtx } from "../src/index";
import { defineMutator, v, ValidationError } from "../src/index";

/**
 * `defineMutator` brands the declaration with `__lunoraMutator` (so codegen
 * discovers it and splits server/client impls into separate bundles) and wraps
 * the authoritative `server` impl in a dispatch `handler` that validates `args`
 * first — so the DO push path invokes a mutator exactly like a procedure.
 */
describe("defineMutator", () => {
    it("brands the declaration and preserves both impls", () => {
        expect.assertions(3);

        const client = vi.fn<(tx: unknown, args: { text: string }) => void>();
        const mutator = defineMutator({
            args: { text: v.string() },
            client,
            server: (_ctx: MutationCtx, args) => `stored:${args.text}`,
        });

        expect((mutator as unknown as Record<string, unknown>)["__lunoraMutator"]).toBe(true);
        expect(mutator.client).toBe(client);
        expect(typeof mutator.handler).toBe("function");
    });

    it("validates args before running the server impl via handler", async () => {
        expect.assertions(2);

        const server = vi.fn<(_ctx: MutationCtx, args: { text: string }) => string>((_ctx, args) => `ok:${args.text}`);
        const mutator = defineMutator({ args: { text: v.string() }, server });

        await expect(mutator.handler({} as MutationCtx, { text: "hi" })).resolves.toBe("ok:hi");

        // A bad envelope is rejected at the dispatch boundary, before `server` runs.
        await expect(mutator.handler({} as MutationCtx, { text: 42 })).rejects.toBeInstanceOf(ValidationError);
    });

    it("supports a parameterless mutator (no args validator)", async () => {
        expect.assertions(1);

        const mutator = defineMutator({ server: () => "done" });

        await expect(mutator.handler({} as MutationCtx, {})).resolves.toBe("done");
    });

    describe("owner scoping", () => {
        /** A trusted ctx as the DO builds it, carrying the socket's verified identity. */
        const ctxFor = (userId: null | string): MutationCtx => ({ auth: { userId } }) as unknown as MutationCtx;

        it("overwrites the owner column with the verified identity", async () => {
            expect.assertions(1);

            // The point of the primitive: the impl reads `args.userId` without
            // trusting the client, so no mutator repeats an `assertOwner` check.
            const mutator = defineMutator({
                args: { text: v.string(), userId: v.string() },
                owner: "userId",
                server: (_ctx: MutationCtx, args) => args.userId,
            });

            await expect(mutator.handler(ctxFor("user-1"), { text: "hi", userId: "user-1" })).resolves.toBe("user-1");
        });

        it("rejects a client-supplied owner that disagrees with the identity", async () => {
            expect.assertions(2);

            const server = vi.fn<(context: MutationCtx, args: { userId: string }) => string>(() => "ran");
            const mutator = defineMutator({ args: { userId: v.string() }, owner: "userId", server });

            await expect(mutator.handler(ctxFor("user-1"), { userId: "user-2" })).rejects.toThrow(/does not match the verified identity/u);

            // Rejected at the dispatch boundary — the write never runs.
            expect(server).not.toHaveBeenCalled();
        });

        it("injects the owner when the column is left off the wire", async () => {
            expect.assertions(1);

            const mutator = defineMutator({
                args: { text: v.string(), userId: v.optional(v.string()) },
                owner: "userId",
                server: (_ctx: MutationCtx, args) => args.userId,
            });

            await expect(mutator.handler(ctxFor("user-7"), { text: "hi" })).resolves.toBe("user-7");
        });

        it("fails closed for an anonymous caller", async () => {
            expect.assertions(2);

            // No identity ⇒ nothing is owned. Denying beats filtering on a nullish
            // value, which a nullable owner column would happily match — the same
            // rule an `owner`-scoped `defineShape` follows on reads.
            const mutator = defineMutator({ args: { userId: v.optional(v.string()) }, owner: "userId", server: () => "ran" });

            await expect(mutator.handler(ctxFor(null), {})).rejects.toThrow(/requires a verified identity/u);
            await expect(mutator.handler({} as MutationCtx, {})).rejects.toThrow(/requires a verified identity/u);
        });

        it("leaves a mutator without `owner` untouched", async () => {
            expect.assertions(1);

            // Opt-in only: an unscoped mutator still receives exactly what the client sent.
            const mutator = defineMutator({
                args: { userId: v.string() },
                server: (_ctx: MutationCtx, args) => args.userId,
            });

            await expect(mutator.handler(ctxFor("user-1"), { userId: "someone-else" })).resolves.toBe("someone-else");
        });

        it("rejects a blank owner column at dispatch", async () => {
            expect.assertions(1);

            const mutator = defineMutator({ args: {}, owner: "  ", server: () => "ran" });

            await expect(mutator.handler(ctxFor("user-1"), {})).rejects.toThrow(/must name the column carrying the row owner/u);
        });
    });
});
