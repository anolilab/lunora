import { describe, expect, it } from "vitest";

import { adminTarget } from "../lunora/deployments";
import { isDataMovementPath } from "../src/admin/proxy";
import { makeCtx } from "./_helpers/fake-ctx";

const deployment = { _id: "dep_1", adminToken: "sealed", organizationId: "org_1", status: "live", url: "https://acme.example" };

const as = (role: string) => makeCtx({ deployments: [deployment], members: [{ _id: "mem_1", organizationId: "org_1", role, userId: "usr_1" }] }).ctx;

const resolve = (role: string, dataMovement?: boolean) =>
    adminTarget.handler(as(role), {
        deploymentId: "dep_1" as never,
        organizationId: "org_1" as never,
        ...(dataMovement === undefined ? {} : { dataMovement }),
    });

describe("the studio admin proxy's target", () => {
    it("serves a member the ordinary admin surface", async () => {
        await expect(resolve("member")).resolves.toMatchObject({ url: "https://acme.example" });
    });

    it("refuses a member the export and import, which carry and rewrite every end user's data", async () => {
        await expect(resolve("member", true)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(resolve("viewer", true)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(resolve("admin", true)).resolves.toMatchObject({ url: "https://acme.example" });
        await expect(resolve("owner", true)).resolves.toMatchObject({ url: "https://acme.example" });
    });

    it("classifies the data-movement paths, whatever their case", () => {
        expect(["export", "import", "Export", "import/", "export/x"].every((path) => isDataMovementPath(path))).toBe(true);
        expect(["exports", "tables", "export-tap/run", "rows/import"].some((path) => isDataMovementPath(path))).toBe(false);
    });
});
