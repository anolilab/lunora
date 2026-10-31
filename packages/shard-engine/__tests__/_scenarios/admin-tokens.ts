import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAdminTokenRecord, listAdminTokens, revokeAdminTokenRecord, verifyAdminTokenDigest } from "../../src/admin-tokens";
import type { SqlHarness } from "../_helpers/sql-harness";

const DIGEST = "a".repeat(64);
const NOW = 1_700_000_000_000;

/**
 * The named admin-token store, over whichever SQLite the caller's harness opens:
 * `node:sqlite` from `../admin-tokens.test.ts`, a Durable Object's
 * `state.storage.sql` from `../workerd/admin-tokens.workerd.test.ts`.
 */
const runAdminTokenScenarios = (factory: () => SqlHarness): void => {
    describe("admin-tokens", () => {
        let harness: SqlHarness;

        beforeEach(() => {
            harness = factory();
        });

        afterEach(() => {
            harness.close();
        });

        it("verifies the stored digest and refuses any other", () => {
            expect.assertions(3);

            expect(createAdminTokenRecord(harness.sql, { createdAt: NOW, digest: DIGEST, name: "ci" })).toBe(true);
            expect(verifyAdminTokenDigest(harness.sql, "ci", DIGEST, NOW)).toStrictEqual({ createdAt: NOW });
            expect(verifyAdminTokenDigest(harness.sql, "ci", "b".repeat(64), NOW)).toBeUndefined();
        });

        it("refuses an unknown name and a duplicate create", () => {
            expect.assertions(2);

            createAdminTokenRecord(harness.sql, { createdAt: NOW, digest: DIGEST, name: "ci" });

            expect(verifyAdminTokenDigest(harness.sql, "nope", DIGEST, NOW)).toBeUndefined();
            expect(createAdminTokenRecord(harness.sql, { createdAt: NOW, digest: "c".repeat(64), name: "ci" })).toBe(false);
        });

        it("deletes only the issuance it was told about, so a stale revoke cannot remove a re-created token", () => {
            expect.assertions(3);

            createAdminTokenRecord(harness.sql, { createdAt: NOW, digest: DIGEST, name: "ci" });
            revokeAdminTokenRecord(harness.sql, "ci", NOW);
            createAdminTokenRecord(harness.sql, { createdAt: NOW + 1, digest: "c".repeat(64), name: "ci" });

            // A second revoke of the first issuance, arriving after the name was re-created.
            expect(revokeAdminTokenRecord(harness.sql, "ci", NOW)).toBe(false);
            expect(verifyAdminTokenDigest(harness.sql, "ci", "c".repeat(64), NOW + 2)).toStrictEqual({ createdAt: NOW + 1 });
            expect(revokeAdminTokenRecord(harness.sql, "ci", NOW + 1)).toBe(true);
        });

        it("refuses a revoked token, and revoking twice reports the second as a miss", () => {
            expect.assertions(3);

            createAdminTokenRecord(harness.sql, { createdAt: NOW, digest: DIGEST, name: "ci" });

            expect(revokeAdminTokenRecord(harness.sql, "ci", NOW)).toBe(true);
            expect(verifyAdminTokenDigest(harness.sql, "ci", DIGEST, NOW)).toBeUndefined();
            expect(revokeAdminTokenRecord(harness.sql, "ci", NOW)).toBe(false);
        });

        it("refuses a token at its expiry", () => {
            expect.assertions(2);

            createAdminTokenRecord(harness.sql, { createdAt: NOW, digest: DIGEST, expiresAt: NOW + 1000, name: "ci" });

            expect(verifyAdminTokenDigest(harness.sql, "ci", DIGEST, NOW + 999)).toStrictEqual({ createdAt: NOW, expiresAt: NOW + 1000 });
            expect(verifyAdminTokenDigest(harness.sql, "ci", DIGEST, NOW + 1000)).toBeUndefined();
        });

        it("lists metadata without the digest and throttles last-used writes", () => {
            expect.assertions(3);

            createAdminTokenRecord(harness.sql, { createdAt: NOW, digest: DIGEST, expiresAt: NOW + 3_600_000, name: "ci" });
            verifyAdminTokenDigest(harness.sql, "ci", DIGEST, NOW + 10);
            verifyAdminTokenDigest(harness.sql, "ci", DIGEST, NOW + 20);

            expect(listAdminTokens(harness.sql)).toStrictEqual([{ createdAt: NOW, expiresAt: NOW + 3_600_000, lastUsedAt: NOW + 10, name: "ci" }]);
            expect(JSON.stringify(listAdminTokens(harness.sql))).not.toContain(DIGEST);

            verifyAdminTokenDigest(harness.sql, "ci", DIGEST, NOW + 60_010);

            expect(listAdminTokens(harness.sql)[0]?.lastUsedAt).toBe(NOW + 60_010);
        });
    });
};

export default runAdminTokenScenarios;
