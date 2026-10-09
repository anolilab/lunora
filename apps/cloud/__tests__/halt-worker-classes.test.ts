import { describe, expect, it } from "vitest";

import { requestOrganizationHalt, requestOrganizationResume, runHaltConverges } from "../src/deploy/halt";
import type { DeployManifest, TenantDeploymentSpec } from "../src/provision-contract";
import type { Row } from "./support/halt-world";
import { deployment, haltOf, LIVE_MANIFEST, NOW, ports, release, sourceOf, world } from "./support/halt-world";

/**
 * Which Durable Object classes an emergency stop keeps. They are the classes of
 * the script actually on the alias's Worker — recorded per alias by every
 * converge (`aliasOwnership.workerClasses`, plus `pendingClasses` for a
 * converge whose outcome is unknown) — not a guess from deployment rows and
 * whatever bundles happen to be retained. A failed release that never reached
 * the Worker, or whose revert succeeded, must neither block a halt nor make
 * its resume impossible; one that may have reached it must never lose a class.
 */

const COUNTER = { binding: "COUNTER", className: "Counter", sqlite: true, type: "durable_object" };
const PRESENCE = { binding: "PRESENCE", className: "Presence", sqlite: true, type: "durable_object" };

const WITH_PRESENCE: DeployManifest = { ...LIVE_MANIFEST, bindings: [...LIVE_MANIFEST.bindings, { ...PRESENCE, type: "durable_object" as const }] };

/** `acme`'s ownership row, with what its Worker is recorded to run. */
const acmeOwnership = (record: Row): Row[] => [
    { _id: "ao_acme", alias: "acme", organizationId: "org_1", projectId: "p_acme", ...record },
    { _id: "ao_shop", alias: "shop", organizationId: "org_1", projectId: "p_shop" },
];

/** A newer release of `acme` that converged, then failed its health check. */
const failedNewer = (overrides: Row = {}): Row =>
    deployment("d_acme2", {
        alias: "acme",
        createdAt: 5,
        failedAt: 8,
        projectId: "p_acme",
        provisioningAt: 6,
        status: "failed",
        target: "cloudflare-wfp",
        verifyingAt: 7,
        ...overrides,
    });

const acmeSpec = (converged: TenantDeploymentSpec[]): TenantDeploymentSpec | undefined => converged.findLast((spec) => spec.alias === "acme");

const classNames = (spec: TenantDeploymentSpec | undefined): string[] =>
    (spec?.manifest.bindings ?? []).flatMap((binding) => (binding.className === undefined ? [] : [binding.className])).toSorted((a, b) => a.localeCompare(b));

const halt = async (database: Awaited<ReturnType<typeof world>>["database"]): Promise<void> => {
    await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });
};

describe("the classes a halt keeps", () => {
    it("h1(1): halts although a failed newer release's bundle was already pruned — the record says what is on the Worker", async () => {
        const { converged, database, deps } = await world({}, { aliasOwnership: acmeOwnership({ workerClasses: [COUNTER] }), deployments: [failedNewer()] });

        await halt(database);
        await runHaltConverges(database, ports(deps));

        expect(haltOf(database, "acme")?.state).toBe("halted");
        expect(classNames(acmeSpec(converged))).toStrictEqual(["Counter"]);
    });

    it("h1(2): a failed release whose revert succeeded adds no class, so the resume onto the live release goes through", async () => {
        const { converged, database, deps, releases } = await world(
            {},
            { aliasOwnership: acmeOwnership({ workerClasses: [COUNTER] }), deployments: [failedNewer()] },
        );

        await releases.store.put("d_acme2", release(WITH_PRESENCE));
        await halt(database);
        await runHaltConverges(database, ports(deps));

        expect(classNames(acmeSpec(converged))).toStrictEqual(["Counter"]);

        await requestOrganizationResume(database, { actor: "usr_1", now: NOW, organizationId: "org_1" });
        await runHaltConverges(database, ports(deps, NOW + 60_000));

        expect(sourceOf(acmeSpec(converged) as TenantDeploymentSpec)).toContain("new Response('real')");
        expect(haltOf(database, "acme")).toBeUndefined();
    });

    it("h1(3): a failed release that bound the same name to another class does not make every halt throw", async () => {
        const renamed = { binding: "COUNTER", className: "CounterV2", sqlite: true, type: "durable_object" };
        const { converged, database, deps, releases } = await world(
            {},
            {
                aliasOwnership: acmeOwnership({ pendingClasses: [{ classes: [renamed], endedAt: 7, startedAt: 6, token: "t1" }], workerClasses: [COUNTER] }),
                deployments: [failedNewer()],
            },
        );

        await releases.store.put("d_acme2", release({ bindings: [{ ...renamed, type: "durable_object" }] }));
        await halt(database);
        await runHaltConverges(database, ports(deps));

        const stub = acmeSpec(converged);

        expect(haltOf(database, "acme")?.state).toBe("halted");
        expect(classNames(stub)).toStrictEqual(["Counter", "CounterV2"]);
        // One binding per name: the second class is bound under a name of its own.
        expect(new Set(stub?.manifest.bindings.map((binding) => binding.binding)).size).toBe(2);
    });

    it("h1(4): a class type the target cannot provision never reaches the stub", async () => {
        const workflow = { binding: "SIGNUP", className: "SignupFlow", type: "workflow" };
        const { converged, database, deps, releases } = await world(
            {},
            {
                aliasOwnership: acmeOwnership({
                    pendingClasses: [{ classes: [COUNTER, workflow], endedAt: 7, startedAt: 6, token: "t1" }],
                    workerClasses: [COUNTER],
                }),
                deployments: [failedNewer()],
            },
        );

        await releases.store.put(
            "d_acme2",
            release({
                bindings: [
                    { ...COUNTER, type: "durable_object" },
                    { ...workflow, resource: "signup", type: "workflow" },
                ],
            }),
        );
        await halt(database);
        await runHaltConverges(database, ports(deps));

        expect(acmeSpec(converged)?.manifest.bindings.map((binding) => binding.type)).toStrictEqual(["durable_object"]);
    });

    it("keeps a class a converge of unknown outcome may have put on the Worker, and refuses a resume that would drop it", async () => {
        const { converged, database, deps, releases } = await world(
            {},
            {
                aliasOwnership: acmeOwnership({
                    pendingClasses: [{ classes: [COUNTER, PRESENCE], endedAt: 7, startedAt: 6, token: "t1" }],
                    workerClasses: [COUNTER],
                }),
                deployments: [failedNewer()],
            },
        );

        await releases.store.put("d_acme2", release(WITH_PRESENCE));
        await halt(database);
        await runHaltConverges(database, ports(deps));

        expect(classNames(acmeSpec(converged))).toStrictEqual(["Counter", "Presence"]);

        await requestOrganizationResume(database, { actor: "usr_1", now: NOW, organizationId: "org_1" });
        await runHaltConverges(database, ports(deps, NOW + 60_000));

        expect(haltOf(database, "acme")?.lastError).toMatch(/Presence/u);
        expect(classNames(acmeSpec(converged))).toStrictEqual(["Counter", "Presence"]);
    });

    it("m1: the old remedy — marking the newer release destroyed — still cannot make a resume drop a class the stub kept", async () => {
        const { converged, database, deps, releases } = await world(
            {},
            {
                aliasOwnership: acmeOwnership({
                    pendingClasses: [{ classes: [COUNTER, PRESENCE], endedAt: 7, startedAt: 6, token: "t1" }],
                    workerClasses: [COUNTER],
                }),
                deployments: [failedNewer()],
            },
        );

        await releases.store.put("d_acme2", release(WITH_PRESENCE));
        await halt(database);
        await runHaltConverges(database, ports(deps));
        await database.patch("d_acme2", { status: "destroyed" });
        await requestOrganizationResume(database, { actor: "usr_1", now: NOW, organizationId: "org_1" });
        await runHaltConverges(database, ports(deps, NOW + 60_000));

        expect(classNames(acmeSpec(converged))).toStrictEqual(["Counter", "Presence"]);
        expect(haltOf(database, "acme")?.state).toBe("resuming");
        expect(haltOf(database, "acme")?.lastError).toMatch(/Presence/u);
    });

    it("m1: support's supported way out — resuming onto a release that binds every class — goes through and records it live", async () => {
        const { converged, database, deps, releases } = await world(
            {},
            {
                aliasOwnership: acmeOwnership({
                    pendingClasses: [{ classes: [COUNTER, PRESENCE], endedAt: 7, startedAt: 6, token: "t1" }],
                    workerClasses: [COUNTER],
                }),
                deployments: [failedNewer({ status: "superseded" })],
            },
        );

        await releases.store.put("d_acme2", release(WITH_PRESENCE));
        await halt(database);
        await runHaltConverges(database, ports(deps));

        const row = haltOf(database, "acme");

        await database.patch(row?._id as string, { resumeDeploymentId: "d_acme2", state: "resuming" });
        await runHaltConverges(database, ports(deps, NOW + 60_000));

        expect(classNames(acmeSpec(converged))).toStrictEqual(["Counter", "Presence"]);
        expect(sourceOf(acmeSpec(converged) as TenantDeploymentSpec)).toContain("new Response('real')");
        expect(haltOf(database, "acme")).toBeUndefined();
        expect((database.tables["deployments"] ?? []).find((entry) => entry["_id"] === "d_acme2")?.["status"]).toBe("live");
        expect((database.tables["deployments"] ?? []).find((entry) => entry["_id"] === "d_acme")?.["status"]).toBe("superseded");
    });

    it("m1: refuses support's resume onto a release that drops a class just the same", async () => {
        const older = deployment("d_acme0", { alias: "acme", createdAt: 0, projectId: "p_acme", status: "superseded", target: "cloudflare-wfp" });
        const { database, deps, releases } = await world({}, { aliasOwnership: acmeOwnership({ workerClasses: [COUNTER, PRESENCE] }), deployments: [older] });

        await releases.store.put("d_acme", release(WITH_PRESENCE));
        await releases.store.put("d_acme0", release({ bindings: [] }));
        await halt(database);
        await runHaltConverges(database, ports(deps));
        await database.patch(haltOf(database, "acme")?._id as string, { resumeDeploymentId: "d_acme0", state: "resuming" });
        await runHaltConverges(database, ports(deps, NOW + 60_000));

        expect(haltOf(database, "acme")?.lastError).toMatch(/release d_acme0 would delete the data of class\(es\) Counter, Presence/u);
    });
});
