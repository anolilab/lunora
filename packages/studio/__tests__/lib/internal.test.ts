import type { FunctionReference, LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { dispatchByKind, fireAndForget, formatCell, jsonRowReplacer } from "../../src/lib/internal";

const REF: FunctionReference = { __lunoraRef: "messages:list" };

/** A minimal client whose three RPC methods echo which one was invoked. */
const makeClient = (): Pick<LunoraClient, "action" | "mutation" | "query"> =>
    ({
        action: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "action-result"),
        mutation: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "mutation-result"),
        query: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "query-result"),
    }) as unknown as Pick<LunoraClient, "action" | "mutation" | "query">;

describe("dispatchByKind", () => {
    it("routes an action to client.action", async () => {
        expect.assertions(2);

        const client = makeClient();

        await expect(dispatchByKind(client, "action", REF, { a: 1 }, { shardKey: "room-1" })).resolves.toBe("action-result");
        expect(client.action).toHaveBeenCalledWith(REF, { a: 1 }, { shardKey: "room-1" });
    });

    it("routes a mutation to client.mutation", async () => {
        expect.assertions(2);

        const client = makeClient();

        await expect(dispatchByKind(client, "mutation", REF, {}, {})).resolves.toBe("mutation-result");
        expect(client.mutation).toHaveBeenCalledTimes(1);
    });

    it("routes a query — and any unknown/undefined kind — to client.query", async () => {
        expect.assertions(3);

        const client = makeClient();

        await expect(dispatchByKind(client, "query", REF, {}, {})).resolves.toBe("query-result");
        await expect(dispatchByKind(client, undefined, REF, {}, {})).resolves.toBe("query-result");
        expect(client.query).toHaveBeenCalledTimes(2);
    });
});

describe("fireAndForget", () => {
    it("invokes onError with the rejection reason", async () => {
        expect.assertions(2);

        const reason = new Error("boom");
        const onError = vi.fn<(error: unknown) => void>();

        fireAndForget(Promise.reject(reason), onError);

        // Let the rejected promise's .catch microtask settle.
        await Promise.resolve();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(reason);
    });

    it("does not throw when a promise rejects and no sink is provided", async () => {
        expect.assertions(1);

        expect(() => {
            fireAndForget(Promise.reject(new Error("ignored")));
        }).not.toThrow();

        // Drain the swallowed rejection so it can't leak into other tests.
        await Promise.resolve();
    });

    it("does not call onError when the promise resolves", async () => {
        expect.assertions(1);

        const onError = vi.fn<(error: unknown) => void>();

        fireAndForget(Promise.resolve("ok"), onError);

        await Promise.resolve();

        expect(onError).not.toHaveBeenCalled();
    });
});

describe("formatCell", () => {
    // A `v.bytes()` column decodes to an ArrayBuffer or a typed-array view.
    // `JSON.stringify` renders the former as a bare `{}` and the latter as its
    // indices (`{"0":1,"1":2,…}`) — neither says anything useful about the cell.
    it("summarizes byte values by size instead of stringifying them", () => {
        expect.assertions(4);

        expect(formatCell(new ArrayBuffer(3))).toBe("<bytes: 3 B>");
        expect(formatCell(new Uint8Array([1, 2, 3, 4]))).toBe("<bytes: 4 B>");
        // A typed array reports its BYTE length, not its element count.
        expect(formatCell(new Uint32Array([1, 2]))).toBe("<bytes: 8 B>");
        // Scaled by the shared `formatBytes`, not a bespoke byte count.
        expect(formatCell(new ArrayBuffer(2 * 1024 * 1024))).toBe("<bytes: 2.0 MB>");
    });

    it("leaves every other value formatted exactly as before", () => {
        expect.assertions(6);

        expect(formatCell(null)).toBe("");
        expect(formatCell(undefined)).toBe("");
        expect(formatCell(1000n)).toBe("1000");
        expect(formatCell("text")).toBe("text");
        expect(formatCell(false)).toBe("false");
        expect(formatCell({ a: 1 })).toBe('{"a":1}');
    });
});

describe("jsonRowReplacer", () => {
    // The client decodes the wire codec, so a `v.bigint()` column reaches the
    // studio as a real bigint — and `JSON.stringify` throws outright on one.
    // Any row-serializing surface (JSON view, JSON export) dies without this.
    it("keeps a row with decoded bigint and bytes serializable", () => {
        expect.assertions(2);

        const row = { amountMinor: 1000n, blob: new ArrayBuffer(3), note: "ok" };

        expect(() => JSON.stringify([row])).toThrow(/BigInt/u);
        expect(JSON.stringify(row, jsonRowReplacer)).toBe('{"amountMinor":"1000","blob":"<bytes: 3 B>","note":"ok"}');
    });

    it("leaves every other value untouched", () => {
        expect.assertions(1);

        const row = { flag: true, nested: { list: [1, "two", null] }, num: 1, text: "x" };

        expect(JSON.stringify(row, jsonRowReplacer)).toBe(JSON.stringify(row));
    });
});
