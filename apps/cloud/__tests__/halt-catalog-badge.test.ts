import { describe, expect, it } from "vitest";

import { requestOrganizationHalt, requestOrganizationResume, runHaltConverges } from "../src/deploy/halt";
import type { Row } from "./support/halt-world";
import { deployment, haltOf, LIVE_MANIFEST, NOW, ports, release, world } from "./support/halt-world";

/**
 * An emergency stop leaves a catalog install's badge alone. A resume onto another
 * release does move it: it supersedes the live release, and restores the target's badge
 * when the target is a catalog release (`src/catalog/install-badge.ts`).
 */

const COUNTER = { binding: "COUNTER", className: "Counter", sqlite: true, type: "durable_object" };

const installsOf = (tables: Record<string, Row[]>): Row[] => tables["catalogInstalls"] ?? [];

/** `acme`'s live release `d_acme` is a catalog install; `resumeTarget` is a superseded release resumed onto. */
const catalogAcme = async (resumeTarget: Row) => {
    const acme = await world(
        {},
        {
            aliasOwnership: [{ _id: "ao_acme", alias: "acme", organizationId: "org_1", projectId: "p_acme", workerClasses: [COUNTER] }],
            deployments: [
                deployment(String(resumeTarget["_id"]), {
                    alias: "acme",
                    createdAt: 0,
                    projectId: "p_acme",
                    status: "superseded",
                    target: "cloudflare-wfp",
                    ...resumeTarget,
                }),
            ],
        },
    );

    acme.database.tables["catalogInstalls"] = [
        {
            _id: "install_acme",
            activeKey: "live:install_acme",
            createdAt: 1,
            deploymentId: "d_acme",
            installedBy: "user_owner",
            organizationId: "org_1",
            projectId: "p_acme",
            slug: "counter",
            status: "live",
            version: "1.1.0",
        },
    ];
    await acme.releases.store.put(String(resumeTarget["_id"]), release(LIVE_MANIFEST));

    return acme;
};

/** Halt `acme`, then resume it onto `target`, the way support does. */
const haltThenResume = async (
    database: Awaited<ReturnType<typeof catalogAcme>>["database"],
    deps: Awaited<ReturnType<typeof catalogAcme>>["deps"],
    target: string,
) => {
    await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });
    await runHaltConverges(database, ports(deps));
    await requestOrganizationResume(database, { actor: "usr_1", now: NOW, organizationId: "org_1" });
    await database.patch(haltOf(database, "acme")?._id as string, { resumeDeploymentId: target, state: "resuming" });
    await runHaltConverges(database, ports(deps, NOW + 60_000));
};

describe("a catalog install's badge through an emergency stop", () => {
    it("leaves the install row alone when the alias is halted", async () => {
        const { database, deps } = await catalogAcme({ _id: "d_acme_cat", catalogInstalledBy: "user_owner", catalogSlug: "counter", catalogVersion: "1.0.0" });
        const before = structuredClone(installsOf(database.tables));

        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });
        await runHaltConverges(database, ports(deps));

        expect(haltOf(database, "acme")?.state).toBe("halted");
        expect(installsOf(database.tables)).toStrictEqual(before);
    });

    it("resuming onto a superseded catalog release removes the old live row and restores the target's", async () => {
        const { database, deps } = await catalogAcme({ _id: "d_acme_cat", catalogInstalledBy: "user_owner", catalogSlug: "counter", catalogVersion: "1.0.0" });

        await haltThenResume(database, deps, "d_acme_cat");

        const rows = installsOf(database.tables);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            deploymentId: "d_acme_cat",
            installedBy: "user_owner",
            projectId: "p_acme",
            slug: "counter",
            status: "live",
            version: "1.0.0",
        });
        expect(rows[0]?.["activeKey"]).toBe(`live:${String(rows[0]?.["_id"])}`);
    });

    it("resuming onto a release with no catalog provenance touches only the row that named the superseded release", async () => {
        const { database, deps } = await catalogAcme({ _id: "d_acme_plain" });
        const otherInstall = {
            _id: "install_shop",
            activeKey: "live:install_shop",
            createdAt: 1,
            deploymentId: "d_shop",
            installedBy: "user_owner",
            organizationId: "org_1",
            projectId: "p_shop",
            slug: "shop",
            status: "live",
            version: "2.0.0",
        };

        database.tables["catalogInstalls"] = [...installsOf(database.tables), otherInstall];

        await haltThenResume(database, deps, "d_acme_plain");

        expect(haltOf(database, "acme")).toBeUndefined();
        expect(installsOf(database.tables)).toStrictEqual([otherInstall]);
    });
});
