import { describe, expect, it } from "vitest";

import { actionCacheDataset, authDataset, documentHistoryDataset, storageObjectsDataset } from "../src/index";

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
});

describe("the other built-in datasets", () => {
    it("names the history table, defaulting to documentHistory", () => {
        expect(documentHistoryDataset().tableNames).toStrictEqual(["documentHistory"]);
    });

    it("marks the action cache as derived data", () => {
        expect(actionCacheDataset()).toMatchObject({ id: "actionCache", origin: "derived" });
    });

    it("describes storage objects as files under a prefix, with no tables", () => {
        expect(storageObjectsDataset("users/u1/")).toMatchObject({ files: { prefix: "users/u1/" }, tableNames: [] });
    });
});
