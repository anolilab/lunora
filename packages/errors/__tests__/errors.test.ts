import { describe, expect, it } from "vitest";

import { ERROR_CATALOG, findSolutionByMessage, invariant, isLunoraError, LunoraError, resolveHint, unreachable } from "../src";

describe("lunoraError", () => {
    it("fills status/title/hint from the catalog by code", () => {
        const error = new LunoraError("NOT_FOUND");

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe("NOT_FOUND");
        expect(error.status).toBe(404);
        expect(error.name).toBe("LunoraError");
        // Falls back to the catalog title when no message is given.
        expect(error.message).toBe(ERROR_CATALOG.NOT_FOUND.title);
    });

    it("carries a catalog hint for CONFLICT", () => {
        const error = new LunoraError("CONFLICT", "boom");

        expect(error.message).toBe("boom");
        expect(error.hint).toBe(ERROR_CATALOG.CONFLICT.hint);
    });

    it("lets options override status, name, hint, data, docsUrl", () => {
        const error = new LunoraError("BAD_REQUEST", "bad", {
            data: { field: "email" },
            docsUrl: "https://lunora.sh/docs/errors",
            hint: "fix it",
            name: "ConflictError",
            status: 418,
        });

        expect(error.status).toBe(418);
        expect(error.name).toBe("ConflictError");
        expect(error.hint).toBe("fix it");
        expect(error.data).toStrictEqual({ field: "email" });
        expect(error.docsUrl).toBe("https://lunora.sh/docs/errors");
    });

    it("accepts a code outside the catalog (status defaults to 500)", () => {
        const error = new LunoraError("SOME_PACKAGE_CODE", "custom", { status: 502 });

        expect(error.code).toBe("SOME_PACKAGE_CODE");
        expect(error.status).toBe(502);
    });

    it("exposes code/status/hint/data as own enumerable props (so they ride the wire codec)", () => {
        const error = new LunoraError("CONFLICT", "boom", { data: { retryAfterMs: 10 } });
        const keys = Object.keys(error);

        expect(keys).toContain("code");
        expect(keys).toContain("status");
        expect(keys).toContain("hint");
        expect(keys).toContain("data");
    });
});

describe("isLunoraError", () => {
    it("matches a real LunoraError", () => {
        expect(isLunoraError(new LunoraError("FORBIDDEN"))).toBe(true);
    });

    it("matches a wire-decoded twin (plain Error with code + status)", () => {
        const twin = Object.assign(new Error("nope"), { code: "NOT_FOUND", status: 404 });

        expect(isLunoraError(twin)).toBe(true);
    });

    it("rejects a plain Error and non-errors", () => {
        expect(isLunoraError(new Error("x"))).toBe(false);
        expect(isLunoraError({ code: "X", status: 1 })).toBe(false);
        expect(isLunoraError(undefined)).toBe(false);
    });
});

describe("catalog message solutions", () => {
    it("finds the codegen missing-schema solution by message", () => {
        const solution = findSolutionByMessage("defineSchema() not found in schema.ts");

        expect(solution?.id).toBe("lunora-schema-missing");
    });

    it("returns undefined for an unrecognized message", () => {
        expect(findSolutionByMessage("totally unrelated")).toBeUndefined();
    });

    it("resolveHint prefers an explicit hint, then code, then message", () => {
        expect(resolveHint({ hint: "explicit" })).toBe("explicit");
        expect(resolveHint({ code: "CONFLICT" })).toBe(ERROR_CATALOG.CONFLICT.hint);
        expect(resolveHint("optimistic concurrency conflict on row")).toBe(ERROR_CATALOG.CONFLICT.hint.join("\n"));
    });
});

describe("invariant / unreachable", () => {
    it("invariant throws an INTERNAL LunoraError when falsy", () => {
        expect(() => {
            invariant(false, "nope");
        }).toThrow(LunoraError);

        let caught: unknown;

        try {
            invariant(0, "nope");
        } catch (error) {
            caught = error;
        }

        expect(isLunoraError(caught)).toBe(true);
        expect((caught as LunoraError).code).toBe("INTERNAL");
        expect((caught as LunoraError).status).toBe(500);
        expect((caught as Error).name).toBe("InvariantError");
    });

    it("invariant passes through when truthy", () => {
        expect(() => {
            invariant(1, "ok");
        }).not.toThrow();
    });

    it("unreachable always throws INTERNAL", () => {
        expect(() => unreachable("branch")).toThrow(LunoraError);
    });
});
