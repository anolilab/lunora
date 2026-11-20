import { describe, expect, it } from "vitest";

import { requestOrganizationHalt, runHaltConverges } from "../src/deploy/halt";
import { resumeAlias } from "../src/deploy/halt-converge";
import type { Row } from "./support/halt-world";
import { deployment, haltOf, LIVE_MANIFEST, NOW, ports, release, world } from "./support/halt-world";

/**
 * A resume onto another release writes the target live, then the project's
 * pointer, each committing alone. When the pointer write fails, the retry finds
 * the target already live and must still move the pointer onto it.
 */
describe("resuming onto another release after the pointer write failed", () => {
    it("repairs the project's pointer on the retry", async () => {
        const acme = await world({}, { deployments: [deployment("d_acme_old", { alias: "acme", createdAt: 0, projectId: "p_acme", status: "superseded" })] });
        const { database, deps } = acme;
        const project = (): Row | undefined => database.tables["projects"]?.find((row) => row["_id"] === "p_acme");

        await acme.releases.store.put("d_acme_old", release(LIVE_MANIFEST));
        await database.patch("projects", "p_acme", { activeDeploymentId: "d_acme", activeScriptName: "acme" });
        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });
        await runHaltConverges(database, ports(deps));

        const halt = { ...haltOf(database, "acme"), resumeDeploymentId: "d_acme_old" } as NonNullable<ReturnType<typeof haltOf>>;
        const patch = database.patch.bind(database);
        let failPointer = true;

        database.patch = async (table, id, values) => {
            if (table === "projects" && failPointer) {
                failPointer = false;

                throw new Error("d1 unavailable");
            }

            return patch(table, id, values);
        };

        await expect(resumeAlias(halt, deps, NOW)).rejects.toThrow("d1 unavailable");
        expect(database.tables["deployments"]?.find((row) => row["_id"] === "d_acme_old")?.["status"]).toBe("live");
        expect(project()?.["activeDeploymentId"]).toBe("d_acme");

        await expect(resumeAlias(halt, deps, NOW)).resolves.toStrictEqual({ deploymentId: "d_acme_old" });
        expect(project()).toMatchObject({ activeDeploymentId: "d_acme_old", activeScriptName: "acme" });
    });
});
