import { ERROR_CATALOG, LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { EXIT_CODE, exitCodeForCode, exitCodeForError, exitCodeForStatus } from "../../src/util/exit-code";

describe("exit-code taxonomy", () => {
    it("assigns every bucket a distinct, stable number", () => {
        expect.assertions(2);

        expect(EXIT_CODE).toStrictEqual({
            AUTH: 3,
            CANCELLED: 130,
            CONFLICT: 6,
            FAILURE: 1,
            MISSING_DEPENDENCY: 9,
            NOT_FOUND: 5,
            PERMISSION: 4,
            RATE_LIMITED: 7,
            SUCCESS: 0,
            UNAVAILABLE: 8,
            USAGE: 2,
        });
        expect(new Set(Object.values(EXIT_CODE)).size).toBe(Object.keys(EXIT_CODE).length);
    });

    it.each([
        [400, EXIT_CODE.USAGE],
        [401, EXIT_CODE.AUTH],
        [403, EXIT_CODE.PERMISSION],
        [404, EXIT_CODE.NOT_FOUND],
        [409, EXIT_CODE.CONFLICT],
        [429, EXIT_CODE.RATE_LIMITED],
        [503, EXIT_CODE.UNAVAILABLE],
        [507, EXIT_CODE.USAGE],
        [500, EXIT_CODE.FAILURE],
        [501, EXIT_CODE.FAILURE],
    ])("maps status %s to exit %s", (status, expected) => {
        expect.assertions(1);

        expect(exitCodeForStatus(status)).toBe(expected);
    });

    it("falls back to a general failure for an unmapped or absent status", () => {
        expect.assertions(2);

        expect(exitCodeForStatus(undefined)).toBe(EXIT_CODE.FAILURE);
        expect(exitCodeForStatus(418)).toBe(EXIT_CODE.FAILURE);
    });

    it("derives a code's bucket from the catalog rather than a parallel list", () => {
        expect.assertions(4);

        expect(exitCodeForCode("UNAUTHORIZED")).toBe(EXIT_CODE.AUTH);
        expect(exitCodeForCode("FORBIDDEN")).toBe(EXIT_CODE.PERMISSION);
        expect(exitCodeForCode("TOO_MANY_REQUESTS")).toBe(EXIT_CODE.RATE_LIMITED);
        // Unregistered: nothing to derive from, so a general failure.
        expect(exitCodeForCode("NOT_A_REAL_CODE")).toBe(EXIT_CODE.FAILURE);
    });

    it("overrides the build-time diagnostics the catalog has to call 500", () => {
        expect.assertions(4);

        // These are 500 on a wire they never cross; what they report is the
        // developer's own source being wrong, which is a usage failure.
        expect(ERROR_CATALOG.CODEGEN_DIAGNOSTIC.status).toBe(500);
        expect(exitCodeForCode("CODEGEN_DIAGNOSTIC")).toBe(EXIT_CODE.USAGE);
        expect(exitCodeForCode("NAMESPACE_COLLISION")).toBe(EXIT_CODE.USAGE);
        expect(exitCodeForCode("SCHEMA_SNAPSHOT_PARSE")).toBe(EXIT_CODE.USAGE);
    });

    /**
     * `UNAVAILABLE`'s documented contract is "retryable", and a CI step or agent
     * reading it will retry. A ceiling is not retryable: the same backup, or the
     * same stream, fails identically every time until a human narrows it.
     */
    it("does not tell automation to retry a ceiling it can never get under", () => {
        expect.assertions(4);

        expect(ERROR_CATALOG.BACKUP_TOO_LARGE.status).toBe(507);
        expect(ERROR_CATALOG.STREAM_TOO_LONG.status).toBe(507);
        expect(exitCodeForCode("BACKUP_TOO_LARGE")).toBe(EXIT_CODE.USAGE);
        expect(exitCodeForCode("STREAM_TOO_LONG")).toBe(EXIT_CODE.USAGE);
    });

    /**
     * The other side of the same question: the statuses that ARE transient must
     * keep telling automation to retry, or the fix above has overreached.
     */
    it("keeps the genuinely transient statuses retryable", () => {
        expect.assertions(4);

        // A replica that has not caught up, and a write that reached one:
        // routing resolves both on the next attempt.
        expect(exitCodeForCode("REPLICA_NOT_READY")).toBe(EXIT_CODE.UNAVAILABLE);
        expect(exitCodeForCode("REPLICA_READ_ONLY")).toBe(EXIT_CODE.UNAVAILABLE);
        // An index still building finishes building.
        expect(exitCodeForCode("SEARCH_INDEX_BUILDING")).toBe(EXIT_CODE.UNAVAILABLE);
        expect(exitCodeForCode("SHARD_TIMEOUT")).toBe(EXIT_CODE.UNAVAILABLE);
    });

    it("gives a missing local tool its own bucket", () => {
        expect.assertions(1);

        expect(exitCodeForCode("LOCAL_DEPENDENCY_MISSING")).toBe(EXIT_CODE.MISSING_DEPENDENCY);
    });

    it("classifies a thrown LunoraError by its code and status", () => {
        expect.assertions(3);

        expect(exitCodeForError(new LunoraError("NOT_FOUND", "gone"))).toBe(EXIT_CODE.NOT_FOUND);
        expect(exitCodeForError(new LunoraError("CONFLICT", "raced"))).toBe(EXIT_CODE.CONFLICT);
        // An explicit status on the instance wins over the catalog default —
        // the upstream-API codes pass the real upstream status through.
        expect(exitCodeForError(new LunoraError("ANALYTICS_SQL_ERROR", "upstream", { status: 429 }))).toBe(EXIT_CODE.RATE_LIMITED);
    });

    it("treats anything that is not a Lunora error as a general failure", () => {
        expect.assertions(3);

        expect(exitCodeForError(new Error("boom"))).toBe(EXIT_CODE.FAILURE);
        expect(exitCodeForError("boom")).toBe(EXIT_CODE.FAILURE);
        expect(exitCodeForError(undefined)).toBe(EXIT_CODE.FAILURE);
    });

    it("resolves every catalogued code to a documented exit code", () => {
        expect.hasAssertions();

        const documented: ReadonlyArray<number> = Object.values(EXIT_CODE);

        for (const code of Object.keys(ERROR_CATALOG)) {
            expect(documented, `${code} resolved to an undocumented exit code`).toContain(exitCodeForCode(code));
        }
    });
});
