/**
 * The two converges of an emergency stop (`./halt.ts`), store-backed: they run
 * from the scheduled sweep, which has no member session and no deploy key, so
 * everything a deploy would ask a Lunora function for — the deployment row,
 * its admin token, the project's secrets and telemetry — is read off the
 * control-plane store here, exactly as the teardown sweep does.
 *
 * - {@link haltAlias} converges an alias onto its stub (`./halt-stub.ts`),
 *   refused before anything converges unless the stub keeps every class of
 *   every release that may be on the Worker.
 * - {@link resumeAlias} re-converges the alias's live release through
 *   {@link reprovision}, refused unless that release keeps every class the
 *   stub kept.
 */
import { LunoraError } from "@lunora/errors";

import type { ControlPlaneStore } from "../d1-store";
import type { DeployKind, DeployManifest, TargetId } from "../provision-contract";
import { BINDING_SUPPORT, storedTarget } from "../provision-contract";
import type { EncryptedSecret } from "../secrets/select";
import { decryptSecrets, secretsForKind } from "../secrets/select";
import { drainTable } from "../store";
import type { TargetDriver } from "../targets/driver";
import type { Placement, RowReader, StoredPlacement } from "../targets/placement";
import { hostsOf, isCellPlaced, placementOfDeployment, resolvePlacement, targetOf } from "../targets/placement";
import type { StoredAdminToken } from "./admin-token";
import { resolveAdminToken } from "./admin-token";
import type { HaltConvergeOutcome, HaltDeploymentRow, HaltRow, OwnsOrganization } from "./halt";
import { liveByAlias } from "./halt";
import type { BoundClass } from "./halt-stub";
import { assertStubKeepsClasses, buildHaltStub, classesOf, mergeClasses, provisionableClasses } from "./halt-stub";
import type { DeployPacer } from "./pacing";
import type { DeployTelemetry, ReleaseDeps } from "./release";
import { droppedDurableObjectClasses, reprovision } from "./release";
import type { ReleaseStore } from "./release-store";
import { classesOnWorker, recordingDriver, storeRecorder } from "./worker-classes";

/** Everything both converges need. */
export interface HaltConvergeDeps {
    /** The cell this control plane serves (`LUNORA_CELL`): a resume places the project against it, as a deploy does. */
    cell: string;
    database: ControlPlaneStore;
    driverFor: (placement: Placement) => TargetDriver;
    /** `SECRET_ENCRYPTION_KEY`: unseals admin tokens and the project's secrets on resume. */
    masterKey?: string;
    pacer: DeployPacer;
    /** Reads the host rows a deployment names (`storeRowReader`). */
    read: RowReader;
    releases: ReleaseStore;
    /** The telemetry a resumed tenant is wired to (`resolveBoxTelemetryConfig`), when the cell has any. */
    telemetry?: (organizationId: string) => Promise<DeployTelemetry | undefined>;
}

type DeploymentRow = HaltDeploymentRow & StoredAdminToken & { cronSpecs?: null | string[] };

/** The alias's deployment rows and its live release. */
const aliasDeployments = async (database: ControlPlaneStore, row: HaltRow): Promise<{ live: DeploymentRow | undefined; rows: DeploymentRow[] }> => {
    const projectRows = await drainTable<DeploymentRow>(database, "deployments", { where: { projectId: row.projectId } });
    const rows = projectRows.filter((deployment) => (deployment.alias ?? deployment.scriptName) === row.alias);

    return { live: liveByAlias(rows).get(row.alias), rows };
};

/** A stored release's manifest, refusing when it is gone. */
const manifestOf = async (releases: ReleaseStore, deploymentId: string, why: string): Promise<DeployManifest> => {
    const release = await releases.get(deploymentId);

    if (release === null) {
        throw new LunoraError("CONFLICT", `release ${deploymentId} is no longer retained, so ${why}; nothing was converged`);
    }

    return release.manifest;
};

/**
 * The classes that may be on the alias's Worker ({@link classesOnWorker}),
 * limited to the types its target provisions at all. An alias no recording
 * converge has confirmed yet (one deployed before the record) falls back to its
 * live release and the newer releases that may have reached the Worker:
 *
 * - one whose converge succeeded (`verifyingAt` set) — refused when its bundle
 *   is gone, since its classes would be unknown;
 * - one that started converging and failed or never settled (`provisioningAt`
 *   without `verifyingAt`) — a job can fail after it uploaded the script, so
 *   its classes are kept while its bundle is retained. A pruned one is skipped
 *   (a halt must not block on it); that gap closes at the alias's first
 *   recorded converge.
 */
const workerClassesOf = async (deps: HaltConvergeDeps, row: HaltRow, aliasRows: { live: DeploymentRow; rows: DeploymentRow[] }): Promise<BoundClass[]> => {
    const target = targetOf(aliasRows.live.target);
    const recorded = await classesOnWorker(deps.database, row.alias);
    let { classes } = recorded;

    if (!recorded.recorded) {
        const newer = aliasRows.rows.filter(
            (deployment) =>
                deployment._id !== aliasRows.live._id &&
                deployment.createdAt > aliasRows.live.createdAt &&
                deployment.provisioningAt != null &&
                deployment.status !== "destroyed",
        );
        const why = "the classes its Worker runs are unknown (the alias predates the class record)";
        const converged = newer.filter((deployment) => deployment.verifyingAt != null);
        const unsettled = newer.filter((deployment) => deployment.verifyingAt == null);
        const manifests = await Promise.all([aliasRows.live, ...converged].map(async (deployment) => manifestOf(deps.releases, deployment._id, why)));
        const maybe = await Promise.all(unsettled.map(async (deployment) => deps.releases.get(deployment._id)));

        manifests.push(...maybe.flatMap((stored) => (stored === null ? [] : [stored.manifest])));
        classes = mergeClasses([...manifests.map((manifest) => classesOf(manifest)), classes]);
    }

    return provisionableClasses(classes, (type) => (BINDING_SUPPORT[target] as Readonly<Record<string, string>>)[type] !== "unsupported");
};

/** Where a deployment's tenant lives, or why this control plane cannot reach it. */
const placementOf = async (deployment: DeploymentRow, read: RowReader): Promise<Placement> => {
    const placed = await placementOfDeployment({ placementRef: deployment.placementRef ?? null, target: targetOf(deployment.target) }, read);

    if ("unplaced" in placed) {
        throw new LunoraError("CONFLICT", `alias ${deployment.alias ?? deployment.scriptName} ${placed.unplaced}`);
    }

    return placed.placement;
};

/** The name of the cell an organization is placed on, or `undefined` for none. */
const organizationCell = async (database: ControlPlaneStore, organizationId: string): Promise<string | undefined> => {
    const organization = (await database.get(organizationId, "organizations")) as null | { cellId?: null | string };
    const cell = organization?.cellId == null ? null : ((await database.get(organization.cellId, "cells")) as null | { name?: null | string });

    return cell?.name ?? undefined;
};

/** The halt sweep's `owns` for a control plane of cell `cell`: the organizations placed on it. */
export const organizationsOnCell =
    (database: ControlPlaneStore, cell: string): OwnsOrganization =>
    async (organizationId) =>
        (await organizationCell(database, organizationId)) === cell;

/**
 * A project's placement exactly as a deploy resolves it (`internal.projects.placement`
 * then `resolvePlacement`): its target and host, refused unless its
 * organization is placed on this control plane's cell.
 */
const projectPlacement = async (deps: HaltConvergeDeps, organizationId: string, projectId: string): Promise<Placement> => {
    const project = (await deps.database.get(projectId, "projects")) as null | { organizationId: string; placementRef?: null | string; target?: null | string };

    if (project?.organizationId !== organizationId) {
        throw new LunoraError("NOT_FOUND", "project not found in this organization");
    }

    const target = storedTarget(project.target);
    const host =
        target === undefined || project.placementRef == null || isCellPlaced(target) ? null : await hostsOf(target).lookup(deps.read, project.placementRef);
    const stored: StoredPlacement = {
        cellName: (await organizationCell(deps.database, organizationId)) ?? null,
        ...(host?.organizationId === organizationId ? { host: host.host, hostRevoked: host.revoked } : {}),
        ...(project.target == null ? {} : { target: project.target }),
    };

    return resolvePlacement(stored, deps.cell);
};

/**
 * Converge an alias onto its stub: exactly the classes that may be on its
 * Worker ({@link workerClassesOf}), checked before anything converges — a stub
 * that would stop binding one of them is refused, never uploaded — and the
 * converge itself recorded like any other.
 */
export const haltAlias = async (row: HaltRow, deps: HaltConvergeDeps): Promise<HaltConvergeOutcome> => {
    const { live, rows } = await aliasDeployments(deps.database, row);

    if (live === undefined) {
        return { skipped: "the alias has no live release" };
    }

    const classes = await workerClassesOf(deps, row, { live, rows });
    const liveRelease = await deps.releases.get(live._id);
    const stub = buildHaltStub(classes, {
        ...(liveRelease?.manifest.compatibilityDate === undefined ? {} : { compatibilityDate: liveRelease.manifest.compatibilityDate }),
        ...(liveRelease?.manifest.compatibilityFlags === undefined ? {} : { compatibilityFlags: liveRelease.manifest.compatibilityFlags }),
        reason: row.reason,
    });

    assertStubKeepsClasses(stub.manifest, classes, droppedDurableObjectClasses);

    const placement = await placementOf(live, deps.read);
    const driver = recordingDriver(deps.driverFor(placement), storeRecorder(deps.database));

    await deps.pacer.schedulerFor(placement).run(async () =>
        driver.deploy({
            alias: row.alias,
            bundle: stub.bundle,
            deploymentId: live._id,
            kind: live.kind as DeployKind,
            manifest: stub.manifest,
            // None: the stub reads no secret, and a resume resolves them afresh.
            secrets: {},
            tags: [`org:${row.organizationId}`, `project:${row.projectId}`, `env:${live.kind}`, "halted"],
        }),
    );

    return { deploymentId: live._id, stubClasses: classes };
};

/**
 * The release backend a resume converges through: the rows read off the store,
 * authorized by being the sweep. `placement` resolves the project's placement
 * as a deploy does, so `reprovision` refuses a release whose project moved to
 * another target since, exactly as a rollback would.
 */
const storeReleaseDeps = (deps: HaltConvergeDeps, deployment: DeploymentRow, live: DeploymentRow | undefined, target: TargetId): ReleaseDeps => {
    return {
        backend: {
            placement: async ({ organizationId, projectId }) => projectPlacement(deps, organizationId, projectId),
            releaseTarget: async () => {
                const adminToken = await resolveAdminToken(
                    {
                        ...(deployment.adminToken == null ? {} : { adminToken: deployment.adminToken }),
                        ...(deployment.adminTokenCiphertext == null || deployment.adminTokenIv == null
                            ? {}
                            : { adminTokenCiphertext: deployment.adminTokenCiphertext, adminTokenIv: deployment.adminTokenIv }),
                    },
                    deps.masterKey,
                );

                if (!adminToken) {
                    throw new LunoraError("CONFLICT", "the release to resume onto has no usable admin token");
                }

                return {
                    adminToken,
                    alias: deployment.alias ?? deployment.scriptName,
                    ...(deployment.cronSpecs != null && deployment.cronSpecs.length > 0 ? { cronSpecs: deployment.cronSpecs } : {}),
                    kind: deployment.kind as DeployKind,
                    ...(live === undefined ? {} : { liveDeploymentId: live._id }),
                    organizationId: deployment.organizationId,
                    projectId: deployment.projectId,
                    target,
                };
            },
            resolveSecrets: async ({ kind, organizationId, projectId }) => {
                const rows = await drainTable<EncryptedSecret>(deps.database, "secrets", { where: { organizationId, projectId } });

                return decryptSecrets(secretsForKind(rows, kind), deps.masterKey);
            },
            rollbackDeployment: () => {
                throw new LunoraError("INTERNAL", "a resume records its release itself; it records no rollback");
            },
        },
        driverFor: (placement) => recordingDriver(deps.driverFor(placement), storeRecorder(deps.database)),
        pacer: deps.pacer,
        releases: deps.releases,
        ...(deps.telemetry ? { resolveTelemetry: async ({ organizationId }: { organizationId: string }) => deps.telemetry?.(organizationId) } : {}),
    };
};

/** The release a resume converges: support's choice (`resumeDeploymentId`) when it made one, else the alias's live release. */
const resumeTarget = (row: HaltRow, aliasRows: { live: DeploymentRow | undefined; rows: DeploymentRow[] }): DeploymentRow | undefined => {
    if (row.resumeDeploymentId == null) {
        return aliasRows.live;
    }

    const chosen = aliasRows.rows.find((deployment) => deployment._id === row.resumeDeploymentId);

    if (chosen === undefined || (chosen.status !== "live" && chosen.status !== "superseded")) {
        throw new LunoraError("CONFLICT", `release ${row.resumeDeploymentId} is not a live or retained release of ${row.alias}`);
    }

    return chosen;
};

/** Record a resume onto a release other than the live one, as a rollback records it: it becomes live and the project points at it. */
const recordResumedOnto = async (deps: HaltConvergeDeps, target: DeploymentRow, live: DeploymentRow | undefined, now: number): Promise<void> => {
    if (live !== undefined && live._id !== target._id) {
        await deps.database.patch(live._id, { status: "superseded", supersededAt: now, updatedAt: now }, "deployments");
    }

    if (live?._id !== target._id) {
        await deps.database.patch(target._id, { liveAt: now, status: "live", updatedAt: now }, "deployments");

        if (target.kind === "production") {
            await deps.database.patch(target.projectId, { activeDeploymentId: target._id, activeScriptName: target.scriptName }, "projects");
        }
    }
};

/**
 * Converge an alias back onto its live release — or the release support chose
 * — with crons, queue consumers, assets and secrets resolved as a deploy would.
 * Refused before anything converges unless that release binds every class that
 * may be on the Worker: the record of the Worker decides, never the deployment
 * rows, so no row an operator edits can make a resume drop a class.
 */
export const resumeAlias = async (row: HaltRow, deps: HaltConvergeDeps, now: number = Date.now()): Promise<HaltConvergeOutcome> => {
    const aliasRows = await aliasDeployments(deps.database, row);
    const target = resumeTarget(row, aliasRows);

    if (target === undefined) {
        return { skipped: "the alias has no live release to restore" };
    }

    const onWorker = await workerClassesOf(deps, row, { live: aliasRows.live ?? target, rows: aliasRows.rows });
    const kept = new Set(classesOf(await manifestOf(deps.releases, target._id, "what it binds is unknown")).map((bound) => bound.className));
    const dropped = onWorker.filter((bound) => !kept.has(bound.className)).map((bound) => bound.className);

    if (dropped.length > 0) {
        throw new LunoraError(
            "CONFLICT",
            `resuming onto release ${target._id} would delete the data of class(es) ${dropped.join(", ")}, which may be on the Worker; the alias stays halted — resume onto a release that binds them (RUNBOOK § 6c)`,
        );
    }

    await reprovision(
        { deploymentId: target._id, organizationId: row.organizationId },
        storeReleaseDeps(deps, target, aliasRows.live, targetOf(target.target)),
        { keepClasses: true },
    );
    await recordResumedOnto(deps, target, aliasRows.live, now);

    return { deploymentId: target._id };
};
