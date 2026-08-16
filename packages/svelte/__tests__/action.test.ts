import type { FunctionReference, LunoraClient } from "@lunora/client";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

import { action } from "../src/action";

const fnRef = { __lunoraRef: "commands:run" } as unknown as FunctionReference;
const args = { command: "lunora" } as unknown;

describe("action handle", () => {
    it("forwards args and options to client.action and resolves the result", async () => {
        const actionFn = vi.fn<(function_: unknown, args: unknown, options?: { shardKey?: string }) => Promise<unknown>>().mockResolvedValue({ code: 0 });
        const client = { action: actionFn } as unknown as LunoraClient;

        const { call } = action(client, fnRef);
        const result = await call(args, { shardKey: "project-1" });

        expect(result).toStrictEqual({ code: 0 });
        expect(actionFn).toHaveBeenCalledWith(fnRef, args, { shardKey: "project-1" });
    });

    it("flips pending true during the call and back to false after it settles", async () => {
        let resolveCall: (value: unknown) => void = () => {};
        const actionFn = vi.fn<() => Promise<unknown>>(
            () =>
                new Promise((resolve) => {
                    resolveCall = resolve;
                }),
        );
        const client = { action: actionFn } as unknown as LunoraClient;

        const { call, pending } = action(client, fnRef);

        expect(get(pending)).toBe(false);

        const inflight = call(args);

        expect(get(pending)).toBe(true);

        resolveCall({ code: 0 });
        await inflight;

        expect(get(pending)).toBe(false);
    });

    it("keeps pending true until the last of several overlapping calls settles", async () => {
        const resolvers: ((value: unknown) => void)[] = [];
        const actionFn = vi.fn<() => Promise<unknown>>(
            () =>
                new Promise((resolve) => {
                    resolvers.push(resolve);
                }),
        );
        const client = { action: actionFn } as unknown as LunoraClient;

        const { call, pending } = action(client, fnRef);

        const both = Promise.all([call(args), call(args)]);

        expect(get(pending)).toBe(true);

        // Settling only the first must NOT clear pending — that is the whole
        // point of ref-counting, and getting it wrong hides a running call.
        resolvers[0]?.({ code: 0 });
        await Promise.resolve();

        expect(get(pending)).toBe(true);

        resolvers[1]?.({ code: 0 });
        await both;

        expect(get(pending)).toBe(false);
    });

    it("records a normalized error, rejects, and clears pending", async () => {
        const actionFn = vi.fn<() => Promise<unknown>>().mockRejectedValue("refused");
        const client = { action: actionFn } as unknown as LunoraClient;

        const { call, error, pending } = action(client, fnRef);

        // A thrown non-Error is normalized, so a consumer can always read
        // `.message` rather than branching on what the server happened to throw.
        await expect(call(args)).rejects.toThrow("refused");
        expect(get(error)).toBeInstanceOf(Error);
        expect(get(pending)).toBe(false);
    });

    it("reset clears data and error back to idle", async () => {
        const actionFn = vi.fn<() => Promise<unknown>>().mockResolvedValue({ code: 0 });
        const client = { action: actionFn } as unknown as LunoraClient;

        const { call, data, reset } = action(client, fnRef);

        await call(args);

        expect(get(data)).toStrictEqual({ code: 0 });

        reset();

        expect(get(data)).toBeUndefined();
    });
});
