import { describe, expect, it } from "vitest";

import { create as createDeployment } from "../lunora/deployments";
import { create as createProject, toProjectView } from "../lunora/projects";
import { productionAliasCandidates, RANDOM_ATTEMPTS } from "../src/deploy/production-alias";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * A project's production alias is claimed when the project is created, so its
 * first production release never collides with an alias another
 * organization's project already owns.
 */

const ALIAS = /^[a-z\d]+(?:-[a-z\d]+)*$/u;
const ORG = "0f9a1c2e-7b44-4d0e-9a51-2b6c8d1e3f40";

describe(productionAliasCandidates, () => {
    it("tries the slug, then the slug with the organization's id, then random suffixes on that", () => {
        const candidates = productionAliasCandidates("web", ORG, () => "zz99");

        expect(candidates).toStrictEqual(["web", "web-0f9a1c2e", ...Array.from<string>({ length: RANDOM_ATTEMPTS }).fill("web-0f9a1c2e-zz99")]);
    });

    it("makes every candidate one DNS label, whatever the slug holds", () => {
        const long = productionAliasCandidates("a".repeat(70), ORG);
        const messy = productionAliasCandidates("  My App!! v2 ", ORG);

        for (const candidate of [...long, ...messy, ...productionAliasCandidates("---", ORG)]) {
            expect(candidate).toMatch(ALIAS);
            expect(candidate.length).toBeLessThanOrEqual(63);
        }

        expect(messy[0]).toBe("my-app-v2");
        expect(productionAliasCandidates("---", ORG)[0]).toBe("app");
    });
});

describe("projects.create", () => {
    const world = (aliasOwnership: Row[] = []): Record<string, Row[]> => {
        return { aliasOwnership, members: [owner("org_1")], projects: [], subscriptions: [] };
    };

    it("claims the slug as the production alias when it is free", async () => {
        const { ctx, ops } = makeCtx(world());

        await expect(createProject.handler(ctx, { name: "Web", organizationId: "org_1" as never, slug: "web" })).resolves.toBe("projects_new");
        expect(ops).toContainEqual(
            expect.objectContaining({ document: expect.objectContaining({ alias: "web", projectId: "projects_new" }) as unknown, table: "aliasOwnership" }), // secret-scanner:allow -- domain field name
        );
        expect(ops).toContainEqual({ id: "projects_new", kind: "patch", patch: { productionAlias: "web" } });
    });

    it("falls back to the slug with the organization's id when another organization owns the slug", async () => {
        const { ctx, ops } = makeCtx(world([{ _id: "ao_1", alias: "web", organizationId: "org_2", projectId: "proj_theirs" }]));

        await createProject.handler(ctx, { name: "Web", organizationId: "org_1" as never, slug: "web" });

        expect(ops).toContainEqual({ id: "projects_new", kind: "patch", patch: { productionAlias: "web-org1" } });
    });
});

describe("the project view's production alias", () => {
    const row = { _id: "proj_1", createdAt: 1, name: "Web", organizationId: "org_1", slug: "web" } as const;

    it("is the alias production serves on once it has, else the reserved one, else absent", () => {
        expect(toProjectView({ ...row, activeScriptName: "legacy-web", productionAlias: "web" } as never).productionAlias).toBe("legacy-web");
        expect(toProjectView({ ...row, productionAlias: "web-org1" } as never).productionAlias).toBe("web-org1");
        expect(toProjectView(row as never)).not.toHaveProperty("productionAlias");
    });
});

describe("deployments.create", () => {
    it("names the project's reserved alias when its wrangler name is another project's", async () => {
        const { ctx } = makeCtx({
            aliasOwnership: [{ _id: "ao_1", alias: "taken", organizationId: "org_2", projectId: "proj_theirs" }],
            deployments: [],
            members: [owner("org_1")],
            projects: [{ _id: "proj_1", organizationId: "org_1", productionAlias: "web-org1", slug: "web" }],
        });

        await expect(
            createDeployment.handler(ctx, { kind: "production", organizationId: "org_1", projectId: "proj_1", scriptName: "taken" } as never),
        ).rejects.toMatchObject({
            code: "FORBIDDEN",
            message: expect.stringContaining('this project\'s production alias is "web-org1" — deploy as it: lunora cloud deploy --name web-org1') as unknown,
        });
    });
});
