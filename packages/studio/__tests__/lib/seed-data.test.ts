import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeWire } from "../../../../shared/wire-codec";
import { collectUnresolvableFkColumns, requestSeedRows, SEED_ENDPOINT } from "../../src/lib/seed-data";

/** A minimal `Response`-like the seed-data client reads (`.ok` + `.json()` + `.status`). */
interface ResponseStub {
    json: () => Promise<unknown>;
    ok: boolean;
    status: number;
}

const jsonResponse = (ok: boolean, payload: unknown): ResponseStub => {
    return {
        json: async () => payload,
        ok,
        status: ok ? 200 : 500,
    };
};

const request = { count: 1, existingIds: {}, seed: 1, table: "posts" } as const;

describe("requestSeedRows", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("decodes a well-formed reply into rows", async () => {
        expect.assertions(1);

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => jsonResponse(true, { ok: true, rows: encodeWire([{ amount: 42n }]) })),
        );

        await expect(requestSeedRows(request)).resolves.toStrictEqual({ kind: "ok", rows: [{ amount: 42n }] });
    });

    it("returns an error result when the transport rejects", async () => {
        expect.assertions(1);

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("Failed to fetch");
            }),
        );

        await expect(requestSeedRows(request)).resolves.toStrictEqual({ kind: "error", message: expect.stringContaining("Failed to fetch") });
    });

    it("returns an error result when the body is not JSON", async () => {
        expect.assertions(1);

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                return {
                    json: async () => {
                        throw new SyntaxError("Unexpected token < in JSON");
                    },
                    ok: true,
                    status: 200,
                };
            }),
        );

        await expect(requestSeedRows(request)).resolves.toStrictEqual({ kind: "error", message: expect.any(String) });
    });

    it("returns an error result when the body is literal null", async () => {
        expect.assertions(1);

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => jsonResponse(true, null)),
        );

        await expect(requestSeedRows(request)).resolves.toStrictEqual({ kind: "error", message: expect.any(String) });
    });

    it("rejects a decoded payload that is not a list of row documents", async () => {
        expect.assertions(1);

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => jsonResponse(true, { ok: true, rows: { notAn: "array" } })),
        );

        await expect(requestSeedRows(request)).resolves.toStrictEqual({ kind: "error", message: expect.any(String) });
    });

    it("rejects a row list carrying a non-object entry", async () => {
        expect.assertions(1);

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => jsonResponse(true, { ok: true, rows: [{ ok: true }, 42] })),
        );

        await expect(requestSeedRows(request)).resolves.toStrictEqual({ kind: "error", message: expect.any(String) });
    });

    it("rejects a row list whose entries decode to non-plain objects", async () => {
        expect.assertions(1);

        // `decodeWire` turns tagged leaves into `Date`/`Map`/`Set`/`Uint8Array`,
        // all of which are `typeof "object"` and none of which is a row
        // document — `importShard`'s per-column validators would be handed a
        // value that cannot satisfy `Record<string, unknown>`.
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => jsonResponse(true, { ok: true, rows: encodeWire([new Date(0), new Map([["a", 1]])]) })),
        );

        await expect(requestSeedRows(request)).resolves.toStrictEqual({ kind: "error", message: expect.any(String) });
    });

    it("returns an error result when the wire payload cannot be decoded", async () => {
        expect.assertions(1);

        // A bigint tag whose digit count exceeds the codec's decode cap.
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => jsonResponse(true, { ok: true, rows: [{ amount: ["$lunora.wire$", "bigint", "9".repeat(2000)] }] })),
        );

        await expect(requestSeedRows(request)).resolves.toStrictEqual({ kind: "error", message: expect.any(String) });
    });

    it("names the parent tables an fk-parents-empty refusal lists", async () => {
        expect.assertions(1);

        // Only the string entries reach the message — the field is host-supplied
        // and unvalidated, so a stray non-string must not render as `42`.
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => jsonResponse(false, { error: "fk-parents-empty", ok: false, tables: ["users", 42, "teams"] })),
        );

        await expect(requestSeedRows(request)).resolves.toStrictEqual({
            kind: "error",
            message: expect.stringContaining("users, teams"),
        });
    });

    it("survives an fk-parents-empty refusal whose tables field is not an array", async () => {
        expect.assertions(1);

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => jsonResponse(false, { error: "fk-parents-empty", ok: false, tables: "users" })),
        );

        await expect(requestSeedRows(request)).resolves.toStrictEqual({ kind: "error", message: expect.any(String) });
    });

    it("posts to the seed endpoint", async () => {
        expect.assertions(1);

        const fetchStub = vi.fn<(input: string, init: RequestInit) => Promise<ResponseStub>>(async () => jsonResponse(true, { ok: true, rows: [] }));

        vi.stubGlobal("fetch", fetchStub);
        await requestSeedRows(request);

        expect(fetchStub.mock.calls[0]?.[0]).toBe(SEED_ENDPOINT);
    });
});

describe("collectUnresolvableFkColumns", () => {
    it("names every FK column whose parent table has no sampled rows", () => {
        expect.assertions(1);

        const blocked = collectUnresolvableFkColumns(
            [
                { name: "_id", optional: false, pk: true, type: "id" },
                { name: "authorId", optional: false, ref: "users", type: "id" },
                { name: "title", optional: false, type: "string" },
            ],
            { users: [] },
        );

        expect(blocked).toStrictEqual(["authorId"]);
    });

    it("clears an FK column once its parent has sampled rows, and blocks one whose parent was never sampled", () => {
        expect.assertions(2);

        const columns = [
            { name: "authorId", optional: false, ref: "users", type: "id" },
            { name: "teamId", optional: false, ref: "teams", type: "id" },
        ] as const;

        // `teams` is absent from the pools entirely — the same "nothing to link
        // against" as an empty pool, so it blocks too.
        expect(collectUnresolvableFkColumns([...columns], { users: ["u1"] })).toStrictEqual(["teamId"]);
        expect(collectUnresolvableFkColumns([...columns], { teams: ["t1"], users: ["u1"] })).toStrictEqual([]);
    });
});
