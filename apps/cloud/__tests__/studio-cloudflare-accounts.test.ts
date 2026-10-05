import { describe, expect, it } from "vitest";

import { accountTitle, describeConnectError, missingPermissions, permissionLabel, TOKEN_PERMISSIONS } from "../src/client/cloudflare-accounts";

/** The Cloudflare accounts tab's pure helpers (MULTIPLATFORM.md Phase 3). */

describe("token permissions", () => {
    it("lists the one required permission first, then the rest by name", () => {
        expect(TOKEN_PERMISSIONS[0]).toMatchObject({ id: "workersScripts", label: "Workers Scripts: Edit", required: true });
        expect(TOKEN_PERMISSIONS.filter((permission) => permission.required)).toHaveLength(1);
    });

    it("names a recorded permission as the token editor does, and keeps an unknown id as is", () => {
        expect(permissionLabel("d1")).toBe("D1: Edit");
        expect(permissionLabel("somethingNew")).toBe("somethingNew");
    });

    it("lists what a token was not seen to hold", () => {
        expect(missingPermissions(["workersScripts", "d1", "kv", "r2", "queues"])).toStrictEqual(["Account Analytics: Read", "Billing: Read"]);
    });
});

describe(accountTitle, () => {
    it("adds the account's own name when it differs from the label", () => {
        expect(accountTitle({ displayName: "Acme Inc", label: "production" })).toBe("production (Acme Inc)");
        expect(accountTitle({ displayName: "production", label: "production" })).toBe("production");
        expect(accountTitle({ label: "production" })).toBe("production");
    });
});

describe(describeConnectError, () => {
    it("rewords the plan limit and passes anything else through", () => {
        expect(describeConnectError("cloudflareAccounts quota reached for this plan (limit 1)")).toContain("limit of connected Cloudflare accounts");
        expect(describeConnectError("the token was not accepted: the token is expired")).toBe("the token was not accepted: the token is expired");
    });
});
