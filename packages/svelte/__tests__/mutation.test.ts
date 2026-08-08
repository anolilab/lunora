import type { FunctionReference, LunoraClient } from "@lunora/client";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

import { mutation } from "../src/mutation";

const fnRef = { __lunoraRef: "messages:send" } as unknown as FunctionReference;
const args = { text: "hi" } as unknown;

describe("mutation handle", () => {
    it("forwards args and options to client.mutation and resolves the result", async () => {
        const mutationFn = vi.fn<() => Promise<unknown>>().mockResolvedValue({ id: 1 });
        const client = { mutation: mutationFn } as unknown as LunoraClient;

        const { mutate } = mutation(client, fnRef);
        const result = await mutate(args, { shardKey: "general" });

        expect(result).toStrictEqual({ id: 1 });
        expect(mutationFn).toHaveBeenCalledWith(fnRef, args, { shardKey: "general" });
    });

    it("flips pending true during the call and back to false after it settles", async () => {
        let resolveCall: (value: unknown) => void = () => {};
        const mutationFn = vi.fn<() => Promise<unknown>>(
            () =>
                new Promise((resolve) => {
                    resolveCall = resolve;
                }),
        );
        const client = { mutation: mutationFn } as unknown as LunoraClient;

        const { mutate, pending } = mutation(client, fnRef);

        expect(get(pending)).toBe(false);

        const inflight = mutate(args);

        expect(get(pending)).toBe(true);

        resolveCall({ ok: true });
        await inflight;

        expect(get(pending)).toBe(false);
    });

    it("keeps pending true until the last overlapping call settles (ref-counted)", async () => {
        const resolvers: ((value: unknown) => void)[] = [];
        const mutationFn = vi.fn<() => Promise<unknown>>(
            () =>
                new Promise((resolve) => {
                    resolvers.push(resolve);
                }),
        );
        const client = { mutation: mutationFn } as unknown as LunoraClient;

        const { mutate, pending } = mutation(client, fnRef);
        const first = mutate(args);
        const second = mutate(args);

        expect(get(pending)).toBe(true);

        resolvers[0]?.(null);
        await first;

        // One call still in flight → still pending.
        expect(get(pending)).toBe(true);

        resolvers[1]?.(null);
        await second;

        expect(get(pending)).toBe(false);
    });
});
