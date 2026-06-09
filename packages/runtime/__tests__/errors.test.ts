import { describe, expect, it } from "vitest";

import { CirrusError, toErrorResponse } from "../src/errors";

describe("cirrusError", () => {
    it("defaults to 500 INTERNAL when no status is provided", () => {
        expect.assertions(2);

        const error = new CirrusError("boom", { code: "INTERNAL" });

        expect(error.status).toBe(500);
        expect(error.code).toBe("INTERNAL");
    });

    it("toResponse roundtrips through JSON", async () => {
        expect.assertions(2);

        const error = new CirrusError("nope", { code: "FORBIDDEN", status: 403 });
        const response = error.toResponse();

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({ error: { code: "FORBIDDEN", message: "nope" } });
    });

    it("toErrorResponse passes CirrusError through unchanged", async () => {
        expect.assertions(2);

        const error = new CirrusError("missing", { code: "NOT_FOUND", status: 404 });
        const response = toErrorResponse(error);

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ error: { code: "NOT_FOUND", message: "missing" } });
    });

    it("toErrorResponse wraps generic errors as INTERNAL 500 with a sanitized message", async () => {
        expect.assertions(2);

        // Per audit H10: never echo error.message to clients — it may leak
        // stack traces, file paths, or internal identifiers. The raw error
        // is logged server-side; the client only sees a generic message.
        const response = toErrorResponse(new Error("kaboom"));

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ error: { code: "INTERNAL", message: "Internal error" } });
    });

    it("toErrorResponse handles non-Error throws", async () => {
        expect.assertions(2);

        const response = toErrorResponse("just a string");

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ error: { code: "INTERNAL", message: "Internal error" } });
    });

    it("toErrorResponse maps a structural ConflictError shape to 409", async () => {
        expect.assertions(2);

        // Structurally identical to what `@cirrus/do` throws — the runtime
        // does not take a hard dependency on that package, so we recognise
        // the shape (name + numeric status + string code) instead.
        const conflict = Object.assign(new Error("stale version"), {
            code: "CONFLICT",
            name: "ConflictError",
            status: 409,
        });
        const response = toErrorResponse(conflict);

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({ error: { code: "CONFLICT", message: "stale version" } });
    });

    it("toErrorResponse maps a structural CirrusError shape (name + code + status) to its status", async () => {
        expect.assertions(2);

        // `@cirrus/do`'s `CountRlsUnsupportedError` (and any future
        // cross-package error mirroring CirrusError's shape) lets the runtime
        // route it without an `instanceof` check, so the DO package stays
        // free of a runtime dep on `@cirrus/server`.
        const countUnsupported = Object.assign(new Error("count() is not supported in an RLS-restricted context"), {
            code: "COUNT_RLS_UNSUPPORTED",
            name: "CirrusError",
            status: 422,
        });
        const response = toErrorResponse(countUnsupported);

        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toEqual({
            error: { code: "COUNT_RLS_UNSUPPORTED", message: "count() is not supported in an RLS-restricted context" },
        });
    });
});
