import { describe, expect, it } from "vitest";

import type { ErrorCatalogEntry } from "../src";
import { ERROR_CATALOG, flattenHint, isInternalCode, MESSAGE_SOLUTIONS } from "../src";

const codes = Object.keys(ERROR_CATALOG) as (keyof typeof ERROR_CATALOG)[];

// The catalog is the single source of truth every transport edge, the client
// SDK, the CLI renderer, and the Studio consume. These tests pin its structural
// invariants so a new entry can't silently ship a bad status, an empty title,
// or an inconsistent redaction posture.
describe("error catalog integrity", () => {
    it("has at least the core transport codes", () => {
        expect(codes).toContain("BAD_REQUEST");
        expect(codes).toContain("UNAUTHORIZED");
        expect(codes).toContain("FORBIDDEN");
        expect(codes).toContain("NOT_FOUND");
        expect(codes).toContain("CONFLICT");
        expect(codes).toContain("VALIDATION_ERROR");
        expect(codes).toContain("INTERNAL");
    });

    it.each(codes)("%s maps to a real HTTP status and a non-empty title", (code) => {
        const entry = ERROR_CATALOG[code];

        expect(Number.isInteger(entry.status)).toBe(true);
        expect(entry.status).toBeGreaterThanOrEqual(400);
        expect(entry.status).toBeLessThanOrEqual(599);
        expect(entry.title.trim().length).toBeGreaterThan(0);
    });

    it.each(codes)("%s is a SCREAMING_SNAKE_CASE machine code", (code) => {
        expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    });

    it("every internal-flagged code maps to a 5xx status", () => {
        // A redacted code is an internal failure by definition — a 4xx internal
        // code would tell the client "your fault" while hiding why.
        const internalCodes = codes.filter((code) => (ERROR_CATALOG[code] as ErrorCatalogEntry).internal === true);

        expect(internalCodes.length).toBeGreaterThan(0);

        for (const code of internalCodes) {
            expect(ERROR_CATALOG[code].status, `${code} is internal but has status ${String(ERROR_CATALOG[code].status)}`).toBeGreaterThanOrEqual(500);
        }
    });

    it.each(codes)("isInternalCode(%s) agrees with the catalog's internal flag", (code) => {
        const entry: ErrorCatalogEntry = ERROR_CATALOG[code];

        expect(isInternalCode(code)).toBe(entry.internal === true);
    });

    it("keeps INTERNAL, its alias, and RPC_FAILED aligned on status + title", () => {
        // INTERNAL_SERVER_ERROR is documented as an alias of INTERNAL; RPC_FAILED
        // presents the same generic face. If they drift, the same failure renders
        // differently depending on which edge mapped it.
        expect(ERROR_CATALOG.INTERNAL_SERVER_ERROR.status).toBe(ERROR_CATALOG.INTERNAL.status);
        expect(ERROR_CATALOG.INTERNAL_SERVER_ERROR.title).toBe(ERROR_CATALOG.INTERNAL.title);
        expect(ERROR_CATALOG.RPC_FAILED.status).toBe(ERROR_CATALOG.INTERNAL.status);
        expect(ERROR_CATALOG.RPC_FAILED.title).toBe(ERROR_CATALOG.INTERNAL.title);
    });

    it("every authored hint flattens to non-empty terminal text", () => {
        const hintedCodes = codes.filter((code) => (ERROR_CATALOG[code] as ErrorCatalogEntry).hint !== undefined);

        expect(hintedCodes.length).toBeGreaterThan(0);

        for (const code of hintedCodes) {
            const entry: ErrorCatalogEntry = ERROR_CATALOG[code];

            expect(flattenHint(entry.hint as string | string[]).trim().length, `${code} has an empty hint`).toBeGreaterThan(0);
        }
    });

    it("isInternalCode treats unknown codes as client-safe (author's vouch)", () => {
        expect(isInternalCode("SOME_FUTURE_PACKAGE_CODE")).toBe(false);
        expect(isInternalCode("")).toBe(false);
    });
});

describe("message solutions integrity", () => {
    it("has unique, stable ids", () => {
        const ids = MESSAGE_SOLUTIONS.map((rule) => rule.id);

        expect(new Set(ids).size).toBe(ids.length);
    });

    it("every rule carries a header, body, and a working matcher", () => {
        for (const rule of MESSAGE_SOLUTIONS) {
            expect(rule.header.trim().length, `${rule.id} has an empty header`).toBeGreaterThan(0);
            expect(rule.body.trim().length, `${rule.id} has an empty body`).toBeGreaterThan(0);
            // A matcher must be a total function over arbitrary messages.
            expect(rule.test("totally unrelated message")).toBe(false);
        }
    });

    it("the duplicate-table rule does not false-positive on unrelated 'already exists' messages", () => {
        const rule = MESSAGE_SOLUTIONS.find((r) => r.id === "lunora-table-duplicate");

        // Anchored on `.extend(` by design — a plain filesystem error with an
        // "extension" word must not match.
        expect(rule?.test('file "foo.png" already exists — pick another extension')).toBe(false);
        expect(rule?.test('defineSchema(...).extend(...): table "users" already exists in the base schema')).toBe(true);
    });
});
