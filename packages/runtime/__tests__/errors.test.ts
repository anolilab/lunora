import { describe, expect, it } from "vitest";

import { LunoraError, toErrorResponse } from "../src/errors";

describe("lunoraError", () => {
    it("defaults to 500 INTERNAL when no status is provided", () => {
        expect.assertions(2);

        const error = new LunoraError("boom", { code: "INTERNAL" });

        expect(error.status).toBe(500);
        expect(error.code).toBe("INTERNAL");
    });

    it("toResponse roundtrips through JSON", async () => {
        expect.assertions(2);

        const error = new LunoraError("nope", { code: "FORBIDDEN", status: 403 });
        const response = error.toResponse();

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({ error: { code: "FORBIDDEN", message: "nope" } });
    });

    it("toErrorResponse passes LunoraError through unchanged", async () => {
        expect.assertions(2);

        const error = new LunoraError("missing", { code: "NOT_FOUND", status: 404 });
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

        // Structurally identical to what `@lunora/do` throws — the runtime
        // does not take a hard dependency on that package, so we recognise
        // the shape (name + numeric status + string code) instead.
        const conflict = Object.assign(new Error("stale version"), {
            code: "CONFLICT",
            name: "ConflictError",
            status: 409,
        });
        const response = toErrorResponse(conflict);

        expect(response.status).toBe(409);
        // The runtime edge now attaches the code's catalog hint (matchObject
        // ignores the extra `hint` key added for `CONFLICT`).
        await expect(response.json()).resolves.toMatchObject({ error: { code: "CONFLICT", message: "stale version" } });
    });

    it("attaches the catalog hint for a non-internal code", async () => {
        expect.assertions(1);

        const response = toErrorResponse(new LunoraError("boom", { code: "CONFLICT", status: 409 }));

        // `expect.anything()` matches the (defined) `hint` array without pinning
        // its exact contents to the catalog.
        await expect(response.json()).resolves.toMatchObject({ error: { hint: expect.anything() } });
    });

    it("toErrorResponse maps a structural LunoraError shape (name + code + status) to its status", async () => {
        expect.assertions(2);

        // `@lunora/do`'s `CountRlsUnsupportedError` (and any future
        // cross-package error mirroring LunoraError's shape) lets the runtime
        // route it without an `instanceof` check, so the DO package stays
        // free of a runtime dep on `@lunora/server`.
        const countUnsupported = Object.assign(new Error("count() is not supported in an RLS-restricted context"), {
            code: "COUNT_RLS_UNSUPPORTED",
            name: "LunoraError",
            status: 422,
        });
        const response = toErrorResponse(countUnsupported);

        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toEqual({
            error: { code: "COUNT_RLS_UNSUPPORTED", message: "count() is not supported in an RLS-restricted context" },
        });
    });
});
