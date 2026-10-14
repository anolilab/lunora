import type { FunctionReference, LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import {
    adminRef,
    dispatchByKind,
    errorDocumentationUrl,
    errorHint,
    fireAndForget,
    formatCell,
    formatTimestamp,
    jsonRowReplacer,
    sqlIdentifier,
} from "../../src/lib/internal";

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

describe("sqlIdentifier", () => {
    it("double-quotes a name so a non-bare identifier survives", () => {
        expect.assertions(3);

        expect(sqlIdentifier("users")).toBe('"users"');
        // The reason the helper exists: `-` makes this illegal unquoted.
        expect(sqlIdentifier("query-result")).toBe('"query-result"');
        expect(sqlIdentifier("")).toBe('""');
    });

    // The escape is what stops a crafted column/table name from closing the
    // quoted identifier and continuing as SQL. `toSql` (the export) and
    // `composeIndexSql` both build statements the operator then runs.
    it("doubles an embedded quote so the identifier cannot be closed early", () => {
        expect.assertions(3);

        expect(sqlIdentifier('a"b')).toBe('"a""b"');
        expect(sqlIdentifier('"; DROP TABLE users; --')).toBe('"""; DROP TABLE users; --"');
        // Every quote, not just the first.
        expect(sqlIdentifier('""')).toBe('""""""');
    });

    it("leaves a single quote alone — it is not the identifier delimiter", () => {
        expect.assertions(1);

        expect(sqlIdentifier("o'brien")).toBe('"o\'brien"');
    });
});

describe("errorDocumentationUrl", () => {
    it("returns an http(s) docsUrl", () => {
        expect.assertions(2);

        expect(errorDocumentationUrl({ docsUrl: "https://lunora.dev/errors/X" })).toBe("https://lunora.dev/errors/X");
        expect(errorDocumentationUrl({ docsUrl: "http://localhost:5173/errors/X" })).toBe("http://localhost:5173/errors/X");
    });

    // The value is rendered as an `href`, so a non-http scheme is an XSS sink.
    // Dropped even though `docsUrl` normally comes from the trusted catalog.
    it("drops any non-http(s) scheme", () => {
        expect.assertions(4);

        // eslint-disable-next-line no-script-url -- the script URL IS the input under test; the assertion is that it never reaches an href
        expect(errorDocumentationUrl({ docsUrl: "javascript:alert(1)" })).toBeUndefined();
        expect(errorDocumentationUrl({ docsUrl: "data:text/html,<script>alert(1)</script>" })).toBeUndefined();
        expect(errorDocumentationUrl({ docsUrl: "vbscript:msgbox(1)" })).toBeUndefined();
        expect(errorDocumentationUrl({ docsUrl: "file:///etc/passwd" })).toBeUndefined();
    });

    it("drops a relative or unparseable value", () => {
        expect.assertions(2);

        expect(errorDocumentationUrl({ docsUrl: "/errors/X" })).toBeUndefined();
        expect(errorDocumentationUrl({ docsUrl: "not a url" })).toBeUndefined();
    });

    it("returns undefined for anything that carries no string docsUrl", () => {
        expect.assertions(5);

        expect(errorDocumentationUrl(null)).toBeUndefined();
        expect(errorDocumentationUrl(undefined)).toBeUndefined();
        expect(errorDocumentationUrl("a string error")).toBeUndefined();
        expect(errorDocumentationUrl(new Error("boom"))).toBeUndefined();
        expect(errorDocumentationUrl({ docsUrl: 42 })).toBeUndefined();
    });
});

describe("errorHint", () => {
    it("returns a string hint verbatim", () => {
        expect.assertions(1);

        expect(errorHint({ hint: "Set LUNORA_ADMIN_TOKEN." })).toBe("Set LUNORA_ADMIN_TOKEN.");
    });

    it("joins an array hint into newline-separated lines", () => {
        expect.assertions(1);

        expect(errorHint({ hint: ["First, do this.", "Then this."] })).toBe("First, do this.\nThen this.");
    });

    it("drops non-string entries from an array hint rather than rendering 'undefined'", () => {
        expect.assertions(2);

        expect(errorHint({ hint: ["keep", 1, null, undefined, { a: 1 }, "me"] })).toBe("keep\nme");
        // An array with nothing usable joins to the empty string, not undefined —
        // callers render it as "no hint text" either way.
        expect(errorHint({ hint: [1, 2] })).toBe("");
    });

    it("returns undefined when the error carries no usable hint", () => {
        expect.assertions(4);

        expect(errorHint(null)).toBeUndefined();
        expect(errorHint(new Error("boom"))).toBeUndefined();
        expect(errorHint("a string error")).toBeUndefined();
        expect(errorHint({ hint: 42 })).toBeUndefined();
    });
});

describe("formatTimestamp", () => {
    it("renders an epoch-ms value and its ISO equivalent identically", () => {
        expect.assertions(1);

        const epoch = Date.UTC(2026, 0, 2, 3, 4, 5);

        expect(formatTimestamp(epoch)).toBe(formatTimestamp(new Date(epoch).toISOString()));
    });

    it("renders absent values as the fallback (blank by default)", () => {
        expect.assertions(4);

        expect(formatTimestamp(undefined)).toBe("");

        expect(formatTimestamp(null)).toBe("");
        expect(formatTimestamp("")).toBe("");
        expect(formatTimestamp(undefined, "—")).toBe("—");
    });

    // Zero is a real instant (the epoch), not an absent value — the `=== ""`
    // check must not be loosened into a falsiness test.
    it("treats 0 as the epoch, not as absent", () => {
        expect.assertions(1);

        expect(formatTimestamp(0, "—")).not.toBe("—");
    });

    it("falls back to the raw string when the value is unparseable", () => {
        expect.assertions(2);

        expect(formatTimestamp("not a date")).toBe("not a date");
        expect(formatTimestamp(Number.NaN)).toBe("NaN");
    });
});

describe("adminRef", () => {
    it("wraps a path as a client FunctionReference", () => {
        expect.assertions(1);

        expect(adminRef("__lunora_admin__:listTables")).toStrictEqual({ __lunoraRef: "__lunora_admin__:listTables" });
    });
});
