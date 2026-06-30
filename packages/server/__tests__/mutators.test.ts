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

        const client = vi.fn();
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

        const server = vi.fn((_ctx: MutationCtx, args: { text: string }) => `ok:${args.text}`);
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
});
