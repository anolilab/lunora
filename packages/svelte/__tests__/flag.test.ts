import type { FunctionReference, LunoraClient } from "@lunora/client";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

import { flag, flags } from "../src/flag";

/** The reserved reactive channel every flag read subscribes to. */
const FLAGS_REF = "__lunora_flags__:eval";

interface FlagSubscribeCall {
    args: { context?: unknown; default: unknown; key: string; type: string };
    callback: (value: unknown) => void;
    functionPath: string;
}

const createFakeClient = () => {
    const calls: FlagSubscribeCall[] = [];
    const unsubscribeSpy = vi.fn<() => void>();

    const subscribe = vi.fn<(function_: FunctionReference, args: FlagSubscribeCall["args"], callback: (value: unknown) => void) => () => void>(
        (function_, args, callback) => {
            // Bracket access — `__lunoraRef` is the public function-reference marker.
            calls.push({ args, callback, functionPath: function_["__lunoraRef"] });

            return unsubscribeSpy;
        },
    );

    const client = { subscribe } as unknown as LunoraClient;

    return {
        calls,
        client,
        /** Push `value` to every subscription opened for `key`. */
        pushKey: (key: string, value: unknown): void => {
            for (const call of calls) {
                if (call.args.key === key) {
                    call.callback(value);
                }
            }
        },
        subscribe,
        unsubscribeSpy,
    };
};

describe("flag store", () => {
    it("subscribes on the reserved flags channel, holds the default, then resolves on push", () => {
        const fake = createFakeClient();
        const store = flag(fake.client, "dark-mode", false);

        const seen: unknown[] = [];
        const stop = store.subscribe((value) => seen.push(value));

        expect(fake.subscribe).toHaveBeenCalledTimes(1);
        expect(fake.calls[0]?.functionPath).toBe(FLAGS_REF);
        expect(get(store)).toBe(false);

        fake.pushKey("dark-mode", true);

        expect(get(store)).toBe(true);
        expect(seen).toStrictEqual([false, true]);

        stop();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    it("is lazy — opens no subscription until the first subscriber", () => {
        const fake = createFakeClient();

        flag(fake.client, "dark-mode", false);

        expect(fake.subscribe).not.toHaveBeenCalled();
    });

    it("sends the flag key, inferred type, and default as subscribe args", () => {
        const fake = createFakeClient();
        const store = flag(fake.client, "hero", "control");

        const stop = store.subscribe(() => {});

        expect(fake.calls[0]?.args).toStrictEqual({ context: undefined, default: "control", key: "hero", type: "string" });

        stop();
    });

    it("merges a per-call targeting context into the subscribe args", () => {
        const fake = createFakeClient();
        const store = flag(fake.client, "hero", "control", { plan: "premium" });

        const stop = store.subscribe(() => {});

        expect(fake.calls[0]?.args.context).toStrictEqual({ plan: "premium" });

        stop();
    });

    it("fails open — a thrown subscribe keeps the default", () => {
        const throwing = {
            subscribe: () => {
                throw new Error("socket closed");
            },
        } as unknown as LunoraClient;

        const store = flag(throwing, "dark-mode", false);
        const stop = store.subscribe(() => {});

        expect(get(store)).toBe(false);

        stop();
    });
});

describe("flags store", () => {
    it("opens one subscription per key and resolves each independently", () => {
        const fake = createFakeClient();
        const store = flags(fake.client, { "dark-mode": false, "page-size": 10 });

        const stop = store.subscribe(() => {});

        expect(fake.subscribe).toHaveBeenCalledTimes(2);
        expect(get(store)).toStrictEqual({ "dark-mode": false, "page-size": 10 });

        fake.pushKey("dark-mode", true);
        fake.pushKey("page-size", 50);

        expect(get(store)).toStrictEqual({ "dark-mode": true, "page-size": 50 });

        stop();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(2);
    });
});
