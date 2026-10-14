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

    // Ref-counted `pending` across overlapping calls lives entirely in
    // `createCallRunner` and is pinned there; what only a Svelte test can prove
    // is that the runner's writes reach store subscribers, which is what `$data`
    // in a component compiles down to.
    it("notifies store subscribers on data and pending", async () => {
        const actionFn = vi.fn<() => Promise<unknown>>().mockResolvedValue({ code: 0 });
        const client = { action: actionFn } as unknown as LunoraClient;

        const { call, data, pending } = action(client, fnRef);

        const seenData: unknown[] = [];
        const seenPending: boolean[] = [];
        const stopData = data.subscribe((value) => seenData.push(value));
        const stopPending = pending.subscribe((value) => seenPending.push(value));

        await call(args);

        // Each store replays its current value on subscribe, so the first entry
        // is the initial state and everything after it is a real notification.
        expect(seenData).toStrictEqual([undefined, { code: 0 }]);
        expect(seenPending).toStrictEqual([false, true, false]);

        stopData();
        stopPending();
    });

    it("keeps the previous data when a later call fails", async () => {
        const actionFn = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce({ code: 0 }).mockRejectedValueOnce(new Error("refused"));
        const client = { action: actionFn } as unknown as LunoraClient;

        const { call, data, error } = action(client, fnRef);

        await call(args);

        expect(get(data)).toStrictEqual({ code: 0 });

        await expect(call(args)).rejects.toThrow("refused");

        // The adapter-wide contract: a failure sets `error` and leaves the last
        // successful `data` in place.
        expect(get(error)?.message).toBe("refused");
        expect(get(data)).toStrictEqual({ code: 0 });
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
