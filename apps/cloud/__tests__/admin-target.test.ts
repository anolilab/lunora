import { describe, expect, it } from "vitest";

import { adminTarget, ejectTarget } from "../lunora/deployments";
import { isDataMovementPath } from "../src/admin/proxy";
import { hashDeployKey } from "../src/deploy/keys";
import { PLAIN_WORKER_NO_ADMIN } from "../src/project-runtime";
import { makeCtx } from "./_helpers/fake-ctx";

const deployment = { _id: "dep_1", adminToken: "sealed", organizationId: "org_1", status: "live", url: "https://acme.example" };

const as = (role: string) => makeCtx({ deployments: [deployment], members: [{ _id: "mem_1", organizationId: "org_1", role, userId: "usr_1" }] }).ctx;

const resolve = (role: string, adminPath: string) =>
    adminTarget.handler(as(role), { adminPath, deploymentId: "dep_1" as never, organizationId: "org_1" as never });

describe("the studio admin proxy's target", () => {
    it("serves a member the ordinary admin surface", async () => {
        await expect(resolve("member", "tables")).resolves.toMatchObject({ url: "https://acme.example" });
    });

    it("refuses a member the export and import, which carry and rewrite every end user's data", async () => {
        await expect(resolve("member", "export")).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(resolve("member", "import")).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(resolve("viewer", "export")).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(resolve("admin", "export")).resolves.toMatchObject({ url: "https://acme.example" });
        await expect(resolve("owner", "export")).resolves.toMatchObject({ url: "https://acme.example" });
    });

    it("refuses a plain Cloudflare Worker's deployment rather than forward to routes it does not have", async () => {
        const { ctx } = makeCtx({
            deployments: [{ ...deployment, runtime: "worker" }],
            members: [{ _id: "mem_1", organizationId: "org_1", role: "owner", userId: "usr_1" }],
        });

        await expect(adminTarget.handler(ctx, { adminPath: "tables", deploymentId: "dep_1" as never, organizationId: "org_1" as never })).rejects.toMatchObject(
            {
                code: "CONFLICT",
                message: PLAIN_WORKER_NO_ADMIN,
            },
        );
    });

    it("refuses to eject a plain Cloudflare Worker, which has no data export", async () => {
        const key = "lk_eject_test";
        const deployKey = { _id: "dk_1", hashedKey: await hashDeployKey(key), organizationId: "org_1", projectId: "prj_1" };
        const tables = (runtime?: string) => {
            return {
                deployKeys: [deployKey],
                deployments: [{ ...deployment, projectId: "prj_1", ...(runtime === undefined ? {} : { runtime }) }],
                projects: [],
            };
        };

        // The same key ejects a Lunora app's deployment: only the runtime differs.
        await expect(ejectTarget.handler(makeCtx(tables()).ctx, { deployKey: key, deploymentId: "dep_1" as never })).resolves.toMatchObject({
            url: "https://acme.example",
        });
        await expect(ejectTarget.handler(makeCtx(tables("worker")).ctx, { deployKey: key, deploymentId: "dep_1" as never })).rejects.toMatchObject({
            code: "CONFLICT",
            message: PLAIN_WORKER_NO_ADMIN,
        });
    });

    it("classifies the data-movement paths, whatever their case", () => {
        expect(["export", "import", "Export", "import/", "export/x"].every((path) => isDataMovementPath(path))).toBe(true);
        expect(["exports", "tables", "export-tap/run", "rows/import"].some((path) => isDataMovementPath(path))).toBe(false);
    });
});
