import { describe, expect, test } from "vitest";

import { CirrusError, toErrorResponse } from "../src/errors.js";

describe("cirrusError", () => {
    test("defaults to 500 INTERNAL when no status is provided", () => {
        expect.assertions(2);

        const err = new CirrusError("boom", { code: "INTERNAL" });

        expect(err.status).toBe(500);
        expect(err.code).toBe("INTERNAL");
    });

    test("toResponse roundtrips through JSON", async () => {
        expect.assertions(2);

        const err = new CirrusError("nope", { code: "FORBIDDEN", status: 403 });
        const response = err.toResponse();

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({ error: { code: "FORBIDDEN", message: "nope" } });
    });

    test("toErrorResponse passes CirrusError through unchanged", async () => {
        expect.assertions(2);

        const err = new CirrusError("missing", { code: "NOT_FOUND", status: 404 });
        const response = toErrorResponse(err);

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ error: { code: "NOT_FOUND", message: "missing" } });
    });

    test("toErrorResponse wraps generic errors as INTERNAL 500 with a sanitized message", async () => {
        expect.assertions(2);

        // Per audit H10: never echo error.message to clients — it may leak
        // stack traces, file paths, or internal identifiers. The raw error
        // is logged server-side; the client only sees a generic message.
        const response = toErrorResponse(new Error("kaboom"));

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ error: { code: "INTERNAL", message: "Internal error" } });
    });

    test("toErrorResponse handles non-Error throws", async () => {
        expect.assertions(2);

        const response = toErrorResponse("just a string");

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ error: { code: "INTERNAL", message: "Internal error" } });
    });

    test("toErrorResponse maps a structural ConflictError shape to 409", async () => {
        expect.assertions(2);

        // Structurally identical to what `@cirrus/do` throws — the runtime
        // does not take a hard dependency on that package, so we recognise
        // the shape (name + numeric status + string code) instead.
        const conflict = Object.assign(new Error("stale version"), {
            name: "ConflictError",
            code: "CONFLICT",
            status: 409,
        });
        const response = toErrorResponse(conflict);

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({ error: { code: "CONFLICT", message: "stale version" } });
    });

    test("toErrorResponse maps a structural CirrusError shape (name + code + status) to its status", async () => {
        expect.assertions(2);

        // `@cirrus/do`'s `CountRlsUnsupportedError` (and any future
        // cross-package error mirroring CirrusError's shape) lets the runtime
        // route it without an `instanceof` check, so the DO package stays
        // free of a runtime dep on `@cirrus/server`.
        const countUnsupported = Object.assign(new Error("count() is not supported in an RLS-restricted context"), {
            name: "CirrusError",
            code: "COUNT_RLS_UNSUPPORTED",
            status: 422,
        });
        const response = toErrorResponse(countUnsupported);

        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toEqual({
            error: { code: "COUNT_RLS_UNSUPPORTED", message: "count() is not supported in an RLS-restricted context" },
        });
    });
});
