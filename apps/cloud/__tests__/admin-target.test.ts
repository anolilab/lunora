import { describe, expect, it } from "vitest";

import { adminTarget, ejectTarget } from "../lunora/deployments";
import { listEncrypted } from "../lunora/secrets";
import { isMemberAdminRead } from "../src/admin/proxy";
import { hashDeployKey } from "../src/deploy/keys";
import { PLAIN_WORKER_NO_ADMIN } from "../src/project-runtime";
import { makeCtx } from "./_helpers/fake-ctx";

const deployment = { _id: "dep_1", adminToken: "sealed", kind: "production", organizationId: "org_1", status: "live", url: "https://acme.example" };

const as = (role: string) => makeCtx({ deployments: [deployment], members: [{ _id: "mem_1", organizationId: "org_1", role, userId: "usr_1" }] }).ctx;

const resolve = (role: string, adminPath: string, adminMethod = "GET") =>
    adminTarget.handler(as(role), { adminMethod, adminPath, deploymentId: "dep_1" as never, organizationId: "org_1" as never });

describe("the studio admin proxy's target", () => {
    it("serves a member the reads the studio browses with", async () => {
        await expect(resolve("member", "functions")).resolves.toMatchObject({ url: "https://acme.example" });
        await expect(resolve("member", "global/table")).resolves.toMatchObject({ url: "https://acme.example" });
        await expect(resolve("member", "shard-traffic", "POST")).resolves.toMatchObject({ url: "https://acme.example" });
    });

    it.each([
        ["POST", "auth/users/impersonate"],
        ["POST", "auth/users/remove"],
        ["GET", "auth/users"],
        ["POST", "apply"],
        ["POST", "export"],
        ["POST", "import"],
        ["GET", "tokens"],
        ["GET", "kv/value"],
        ["POST", "functions"],
        ["GET", "some-route-added-later"],
    ])("refuses a member %s %s, and serves it to an owner and an admin", async (method, path) => {
        await expect(resolve("member", path, method)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(resolve("viewer", path, method)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(resolve("admin", path, method)).resolves.toMatchObject({ url: "https://acme.example" });
        await expect(resolve("owner", path, method)).resolves.toMatchObject({ url: "https://acme.example" });
    });

    it("refuses a plain Cloudflare Worker's deployment rather than forward to routes it does not have", async () => {
        const { ctx } = makeCtx({
            deployments: [{ ...deployment, runtime: "worker" }],
            members: [{ _id: "mem_1", organizationId: "org_1", role: "owner", userId: "usr_1" }],
        });

        await expect(
            adminTarget.handler(ctx, { adminMethod: "GET", adminPath: "functions", deploymentId: "dep_1" as never, organizationId: "org_1" as never }),
        ).rejects.toMatchObject({
            code: "CONFLICT",
            message: PLAIN_WORKER_NO_ADMIN,
        });
    });

    it("refuses to eject a plain Cloudflare Worker, which has no data export", async () => {
        const key = "lk_eject_test";
        const deployKey = { _id: "dk_1", hashedKey: await hashDeployKey(key), organizationId: "org_1", projectId: "prj_1", type: "production" };
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

    it("holds an eject to the key's kind ceiling, so a preview key cannot export production", async () => {
        const key = "lk_eject_kind";
        const eject = async (type: string, kind: string) =>
            ejectTarget.handler(
                makeCtx({
                    deployKeys: [{ _id: "dk_1", hashedKey: await hashDeployKey(key), organizationId: "org_1", projectId: "prj_1", type }],
                    deployments: [{ ...deployment, kind, projectId: "prj_1" }],
                    projects: [],
                }).ctx,
                { deployKey: key, deploymentId: "dep_1" as never },
            );

        await expect(eject("preview", "production")).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(eject("dev", "preview")).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(eject("production", "production")).resolves.toMatchObject({ url: "https://acme.example" });
        await expect(eject("preview", "preview")).resolves.toMatchObject({ url: "https://acme.example" });
    });

    it("holds a deploy key's secret read to its kind ceiling", async () => {
        const key = "lk_secrets_kind";
        const read = async (environment: "preview" | "production") =>
            listEncrypted.handler(
                makeCtx({
                    deployKeys: [{ _id: "dk_1", hashedKey: await hashDeployKey(key), organizationId: "org_1", projectId: "prj_1", type: "preview" }],
                    projects: [{ _id: "prj_1", organizationId: "org_1" }],
                    secrets: [],
                }).ctx,
                { deployKey: key, environment, organizationId: "org_1" as never, projectId: "prj_1" as never },
            );

        await expect(read("production")).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(read("preview")).resolves.toStrictEqual([]);
    });

    it("matches a member read by exact path and verb", () => {
        expect(isMemberAdminRead("GET", "functions")).toBe(true);
        expect(["Functions", "functions/", "functions/x"].some((path) => isMemberAdminRead("GET", path))).toBe(false);
        expect(isMemberAdminRead("get", "functions")).toBe(false);
    });
});
