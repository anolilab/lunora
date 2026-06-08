import { admin, organization } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

import type { CirrusAuthOptions } from "../src/create-auth.js";
import authTables from "../src/schema.js";

const baseOptions: CirrusAuthOptions = {
    emailAndPassword: { enabled: true },
    secret: "test-secret-test-secret-test-secret",
};

describe("authTables", () => {
    it("generates the four core better-auth tables from a bare config", () => {
        expect.hasAssertions();

        const tables = authTables(baseOptions);

        expect(Object.keys(tables).toSorted((a, b) => a.localeCompare(b))).toEqual(["account", "session", "user", "verification"]);
    });

    it("maps field types to the matching Cirrus validators", () => {
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
});
