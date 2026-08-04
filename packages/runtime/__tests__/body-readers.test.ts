import { describe, expect, it } from "vitest";

import { readJsonBodyWithLimit } from "../src/body-readers";

/**
 * `readJsonBodyWithLimit` promised `Record<string, unknown>` but only checked
 * that the body was valid JSON — `null`, `[1, 2]`, and a bare scalar all parse
 * cleanly and used to satisfy the `as` cast, so a caller that dereferenced a
 * property on the "object" (every admin route does) would 500 on what should
 * be a 400 (RUNTIME-04, advisor 226). `handleBatchRpc` used to run this same
 * check by hand after its own parse — it now delegates here instead.
 */
const jsonRequest = (body: string): Request => new Request("https://app.example/x", { body, method: "POST" });

describe("readJsonBodyWithLimit", () => {
    it("rejects a literal `null` body with a 400 BAD_REQUEST", async () => {
        expect.assertions(2);

        await expect(readJsonBodyWithLimit(jsonRequest("null"))).rejects.toThrow(/must be an object/u);
        await expect(readJsonBodyWithLimit(jsonRequest("null"))).rejects.toMatchObject({ status: 400 });
    });

    it("rejects a body that parses to an array", async () => {
        expect.assertions(1);

        await expect(readJsonBodyWithLimit(jsonRequest("[1,2]"))).rejects.toMatchObject({ status: 400 });
    });

    it("rejects a body that parses to a bare scalar", async () => {
        expect.assertions(2);

        await expect(readJsonBodyWithLimit(jsonRequest("5"))).rejects.toMatchObject({ status: 400 });
        await expect(readJsonBodyWithLimit(jsonRequest('"hi"'))).rejects.toMatchObject({ status: 400 });
    });

    it("still accepts a well-formed object body", async () => {
        expect.assertions(1);

        await expect(readJsonBodyWithLimit(jsonRequest('{"a":1}'))).resolves.toEqual({ a: 1 });
    });

    it("still defaults an empty body to `{}`", async () => {
        expect.assertions(1);

        await expect(readJsonBodyWithLimit(new Request("https://app.example/x", { method: "POST" }))).resolves.toEqual({});
    });

    it("still maps malformed JSON to a 400 (not the object-shape message)", async () => {
        expect.assertions(1);

        await expect(readJsonBodyWithLimit(jsonRequest("{not json"))).rejects.toMatchObject({ status: 400 });
    });
});
