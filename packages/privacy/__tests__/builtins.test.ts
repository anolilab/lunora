import { describe, expect, it } from "vitest";

import { actionCacheDataset, authDataset, documentHistoryDataset, storageObjectsDataset } from "../src/builtins";

describe(authDataset, () => {
    it("covers better-auth's user tables by their default names", () => {
        expect(authDataset().tableNames.toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "account",
            "apikey",
            "member",
            "passkey",
            "session",
            "teamMember",
            "twoFactor",
            "user",
        ]);
    });

    it("uses an app's own table names when it renamed them", () => {
        expect(authDataset({ session: "sessions", user: "people" }).tableNames).toContain("sessions");
    });

    it("keeps the session token and the second-factor secret out of the export", () => {
        const auth = authDataset();

        expect(auth.tables.session?.omit).toContain("token");
        expect(auth.tables.twoFactor?.omit).toContain("secret");
    });

    it("keeps every credential column out of the export, not just one per table", () => {
        const auth = authDataset();

        expect(auth.tables.account?.omit).toStrictEqual(expect.arrayContaining(["password", "accessToken", "refreshToken", "idToken"]));
        expect(auth.tables.twoFactor?.omit).toStrictEqual(expect.arrayContaining(["secret", "backupCodes"]));
    });

    it("keeps credential columns out of the export under renamed tables too", () => {
        const auth = authDataset({ account: "logins" });

        expect(auth.tables.logins?.omit).toContain("password");
    });
});

describe("the other built-in datasets", () => {
    it("names the history table, defaulting to documentHistory", () => {
        expect(documentHistoryDataset().tableNames).toStrictEqual(["documentHistory"]);
    });

    it("marks the action cache as derived data", () => {
        expect(actionCacheDataset()).toMatchObject({ id: "actionCache", origin: "derived" });
    });

    it("describes storage objects as files under a prefix, with no tables", () => {
        const dataset = storageObjectsDataset((subjectId) => `users/${subjectId}/`);

        expect(dataset.tableNames).toStrictEqual([]);
        expect(dataset.files?.prefix("u1")).toBe("users/u1/");
    });
});
