import { passkey } from "@better-auth/passkey";
import { admin, jwt, organization, twoFactor, username } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

import type { LunoraAuthOptions } from "../src/create-auth";
import authTables from "../src/schema";

const baseOptions: LunoraAuthOptions = {
    emailAndPassword: { enabled: true },
    secret: "test-secret-test-secret-test-secret",
};

describe("authTables", () => {
    it("generates the four core better-auth tables from a bare config", () => {
        expect.hasAssertions();

        const tables = authTables(baseOptions);

        expect(Object.keys(tables).toSorted((a, b) => a.localeCompare(b))).toEqual(["account", "session", "user", "verification"]);
    });

    it("maps field types to the matching Lunora validators", () => {
        expect.assertions(4);

        const tables = authTables(baseOptions);

        expect(tables["user"]?.shape["email"]?.kind).toBe("string");
        expect(tables["user"]?.shape["emailVerified"]?.kind).toBe("boolean");
        expect(tables["user"]?.shape["createdAt"]?.kind).toBe("date");
        // A `references` field is typed as the referenced table's id, not a raw string.
        expect(tables["session"]?.shape["userId"]?.kind).toBe("id");
    });

    it("makes optional (`required: false`) fields nullable and keeps required ones not-null", () => {
        expect.assertions(2);

        const tables = authTables(baseOptions);

        // `image` is optional in better-auth → nullable here (accepts null).
        expect(tables["user"]?.shape["image"]?.parse(null)).toBeNull();
        // `email` is required → not-null, so parsing null throws.
        expect(() => tables["user"]?.shape["email"]?.parse(null)).toThrow(/null|expected/iu);
    });

    it("auto-includes a plugin's tables — `organization` adds org/member/invitation/team", () => {
        expect.hasAssertions();

        const tables = authTables({ ...baseOptions, plugins: [organization({ teams: { enabled: true } })] });

        for (const name of ["organization", "member", "invitation", "team"]) {
            expect(tables).toHaveProperty(name);
        }
    });

    it("auto-includes a plugin's added columns — `admin` adds user.role/banned", () => {
        expect.assertions(2);

        const tables = authTables({ ...baseOptions, plugins: [admin()] });

        expect(tables["user"]?.shape["role"]?.kind).toBe("string");
        expect(tables["user"]?.shape["banned"]?.kind).toBe("boolean");
    });

    it("generates a valid schema across a broad plugin set — no throws, every field mapped", () => {
        expect.hasAssertions();

        // Exercises the full breadth: FK references, plugin-added columns, and
        // extra tables from org/teams, twoFactor, jwt, passkey, username.
        const tables = authTables({
            ...baseOptions,
            plugins: [organization({ teams: { enabled: true } }), admin(), twoFactor(), jwt(), passkey(), username()],
        });

        // Every contributed table is present…
        for (const name of ["user", "session", "account", "verification", "organization", "member", "invitation", "team", "twoFactor", "jwks", "passkey"]) {
            expect(tables).toHaveProperty(name);
        }

        // …and no field fell through to the permissive `v.any()` fallback —
        // i.e. every better-auth field type these plugins use is mapped to a
        // concrete validator.
        const fellBack = Object.entries(tables).flatMap(([table, definition]) =>
            Object.entries(definition.shape)
                .filter(([, validator]) => validator.kind === "any")
                .map(([column]) => `${table}.${column}`),
        );

        expect(fellBack).toEqual([]);
    });
});
