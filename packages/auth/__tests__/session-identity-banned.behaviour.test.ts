import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";

import { createAuthAdmin } from "../src/admin";
import { createAuth } from "../src/create-auth";
import { admin, apiKey } from "../src/plugins";
import { identityFromSession } from "../src/session-identity";

/**
 * better-auth enforces a ban only when a session row is created, so the resolver has to
 * refuse a banned user itself for the credentials that never create one (API keys, cached
 * cookie sessions).
 */

const HOUR_MS = 3_600_000;

const sessionFor = (user: Record<string, unknown>) => {
    return { session: { expiresAt: new Date(Date.now() + HOUR_MS) }, user: { email: "a@example.test", id: "u1", name: "Ada", ...user } };
};

describe("identityFromSession with a banned user", () => {
    it("resolves a permanent ban (no banExpires) to no identity", () => {
        expect.assertions(1);

        expect(identityFromSession(sessionFor({ banned: true }))).toBeNull();
    });

    it("resolves a permanent ban (banExpires null) to no identity", () => {
        expect.assertions(1);

        expect(identityFromSession(sessionFor({ banExpires: null, banned: true }))).toBeNull();
    });

    it("resolves a ban that has not yet expired to no identity", () => {
        expect.assertions(1);

        expect(identityFromSession(sessionFor({ banExpires: new Date(Date.now() + HOUR_MS), banned: true }))).toBeNull();
    });

    it("resolves a lapsed ban to the identity", () => {
        expect.assertions(1);

        expect(identityFromSession(sessionFor({ banExpires: new Date(Date.now() - HOUR_MS), banned: true }))).toMatchObject({ userId: "u1" });
    });

    it("reads an ISO-string banExpires from an adapter that does not hydrate dates", () => {
        expect.assertions(1);

        expect(identityFromSession(sessionFor({ banExpires: new Date(Date.now() + HOUR_MS).toISOString(), banned: true }))).toBeNull();
    });

    it("keeps a ban whose expiry cannot be read", () => {
        expect.assertions(1);

        expect(identityFromSession(sessionFor({ banExpires: "not a date", banned: true }))).toBeNull();
    });

    it("resolves an unbanned user, with or without the column, to the identity", () => {
        expect.assertions(2);

        expect(identityFromSession(sessionFor({ banned: false }))).toMatchObject({ userId: "u1" });
        expect(identityFromSession(sessionFor({}))).toMatchObject({ userId: "u1" });
    });

    it("follows the columns banUser and unbanUser really write", async () => {
        expect.assertions(2);

        const database: Record<string, unknown[]> = { account: [], apikey: [], session: [], user: [], verification: [] };
        const adminApi = createAuthAdmin(
            createAuth({
                baseURL: "http://localhost",
                database: memoryAdapter(database),
                plugins: [admin(), apiKey({ enableSessionForAPIKeys: true })],
                secret: "x".repeat(32),
            }),
        );
        const created = await adminApi.createUser({ email: "ban@example.com", name: "Ban" });
        const row = () => (database["user"] ?? []).find((candidate) => (candidate as { id: string }).id === created.id) as Record<string, unknown>;

        await adminApi.banUser({ userId: created.id });

        expect(identityFromSession({ session: { expiresAt: new Date(Date.now() + HOUR_MS) }, user: row() })).toBeNull();

        await adminApi.unbanUser({ userId: created.id });

        expect(identityFromSession({ session: { expiresAt: new Date(Date.now() + HOUR_MS) }, user: row() })).toMatchObject({ userId: created.id });
    });
});
