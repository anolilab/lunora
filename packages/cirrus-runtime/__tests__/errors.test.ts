import { describe, expect, test } from "vitest";

import { CirrusError, toErrorResponse } from "../src/errors.js";

describe("CirrusError", () => {
    test("defaults to 500 INTERNAL when no status is provided", () => {
        const err = new CirrusError("boom", { code: "INTERNAL" });

        expect(err.status).toBe(500);
        expect(err.code).toBe("INTERNAL");
    });

    test("toResponse roundtrips through JSON", async () => {
        const err = new CirrusError("nope", { code: "FORBIDDEN", status: 403 });
        const response = err.toResponse();

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({ error: { code: "FORBIDDEN", message: "nope" } });
    });

    test("toErrorResponse passes CirrusError through unchanged", async () => {
        const err = new CirrusError("missing", { code: "NOT_FOUND", status: 404 });
        const response = toErrorResponse(err);

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ error: { code: "NOT_FOUND", message: "missing" } });
    });

    test("toErrorResponse wraps generic errors as INTERNAL 500 with a sanitized message", async () => {
        // Per audit H10: never echo error.message to clients — it may leak
        // stack traces, file paths, or internal identifiers. The raw error
        // is logged server-side; the client only sees a generic message.
        const response = toErrorResponse(new Error("kaboom"));

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ error: { code: "INTERNAL", message: "Internal error" } });
    });

    test("toErrorResponse handles non-Error throws", async () => {
        const response = toErrorResponse("just a string");

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ error: { code: "INTERNAL", message: "Internal error" } });
    });
});
