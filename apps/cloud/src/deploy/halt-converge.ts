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
import type { EncryptedSecret } from "../secrets/select";
import { decryptSecrets, secretsForKind } from "../secrets/select";
import { drainTable } from "../store";
import type { TargetDriver } from "../targets/driver";
import type { Placement, RowReader } from "../targets/placement";
import { placementOfDeployment, targetOf } from "../targets/placement";
import type { StoredAdminToken } from "./admin-token";
import { resolveAdminToken } from "./admin-token";
import type { HaltConvergeOutcome, HaltDeploymentRow, HaltRow } from "./halt";
import { liveByAlias } from "./halt";
import { assertStubKeepsClasses, buildHaltStub } from "./halt-stub";
import type { DeployPacer } from "./pacing";
import type { DeployTelemetry, ReleaseDeps } from "./release";
import { droppedDurableObjectClasses, reprovision } from "./release";
import type { ReleaseStore } from "./release-store";

/** Everything both converges need. */
export interface HaltConvergeDeps {
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

/** The alias's deployment rows, its live release, and every release that may be on its Worker, newest first. */
const aliasReleases = async (database: ControlPlaneStore, row: HaltRow): Promise<{ live: DeploymentRow; onWorker: DeploymentRow[] } | undefined> => {
    const projectRows = await drainTable<DeploymentRow>(database, "deployments", { where: { projectId: row.projectId } });
    const rows = projectRows.filter((deployment) => (deployment.alias ?? deployment.scriptName) === row.alias);
    const live = liveByAlias(rows).get(row.alias);

    if (live === undefined) {
        return undefined;
    }

    // A release newer than the live one that started converging may be what the
    // Worker runs — a failed health check whose revert failed, or a converge
    // stranded mid-flight. Its classes must survive too.
    const newer = rows.filter(
        (deployment) =>
            deployment._id !== live._id && deployment.createdAt > live.createdAt && deployment.provisioningAt != null && deployment.status !== "destroyed",
    );

    return { live, onWorker: [live, ...newer].toSorted((a, b) => b.createdAt - a.createdAt) };
};

/** The stored manifests of `deployments`, refusing when one is gone: its classes could not be kept. */
const manifestsOf = async (releases: ReleaseStore, deployments: ReadonlyArray<DeploymentRow>): Promise<DeployManifest[]> =>
    Promise.all(
        deployments.map(async (deployment) => {
            const release = await releases.get(deployment._id);

            if (release === null) {
                throw new LunoraError(
                    "CONFLICT",
                    `release ${deployment._id} may be on the Worker but is no longer retained, so the classes a stub must keep are unknown; nothing was converged`,
                );
            }

            return release.manifest;
        }),
    );

/** Where a deployment's tenant lives, or why this control plane cannot reach it. */
const placementOf = async (deployment: DeploymentRow, read: RowReader): Promise<Placement> => {
    const placed = await placementOfDeployment({ placementRef: deployment.placementRef ?? null, target: targetOf(deployment.target) }, read);

    if ("unplaced" in placed) {
        throw new LunoraError("CONFLICT", `alias ${deployment.alias ?? deployment.scriptName} ${placed.unplaced}`);
    }

    return placed.placement;
};

/**
 * Converge an alias onto its stub. The stub binds the classes of the live
 * release and of every newer release that may be on the Worker, and the guard
 * runs before the converge: a stub that would stop binding one of them is
 * refused, never uploaded.
 */
export const haltAlias = async (row: HaltRow, deps: HaltConvergeDeps): Promise<HaltConvergeOutcome> => {
    const releases = await aliasReleases(deps.database, row);

    if (releases === undefined) {
        return { skipped: "the alias has no live release" };
    }

    const { live, onWorker } = releases;
    const manifests = await manifestsOf(deps.releases, onWorker);
    const stub = buildHaltStub(manifests, row.reason);

    assertStubKeepsClasses(stub.manifest, manifests, droppedDurableObjectClasses);

    const placement = await placementOf(live, deps.read);

    await deps.pacer.schedulerFor(placement).run(async () =>
        deps.driverFor(placement).deploy({
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

    return { deploymentId: live._id };
};

/**
 * The release backend a resume converges through: the rows read off the store,
 * authorized by being the sweep. `placement` places the deployment off its own
 * row, as the teardown does, so `reprovision`'s same-target check compares
 * like with like.
 */
const storeReleaseDeps = (deps: HaltConvergeDeps, deployment: DeploymentRow, target: TargetId): ReleaseDeps => {
    return {
        backend: {
            placement: async () => placementOf(deployment, deps.read),
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
                    throw new LunoraError("CONFLICT", "the live release has no usable admin token");
                }

                return {
                    adminToken,
                    alias: deployment.alias ?? deployment.scriptName,
                    ...(deployment.cronSpecs != null && deployment.cronSpecs.length > 0 ? { cronSpecs: deployment.cronSpecs } : {}),
                    kind: deployment.kind as DeployKind,
                    liveDeploymentId: deployment._id,
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
                throw new LunoraError("INTERNAL", "a resume re-converges the live release; it records no rollback");
            },
        },
        driverFor: deps.driverFor,
        pacer: deps.pacer,
        releases: deps.releases,
        ...(deps.telemetry ? { resolveTelemetry: async ({ organizationId }: { organizationId: string }) => deps.telemetry?.(organizationId) } : {}),
    };
};

/**
 * Converge an alias back onto its live release — crons, queue consumers,
 * assets and secrets included, all resolved as a deploy would. Refused before
 * anything converges unless the live release binds every Durable Object class
 * the stub kept (`reprovision`'s own guard is skipped for the live release,
 * which it compares with itself).
 */
export const resumeAlias = async (row: HaltRow, deps: HaltConvergeDeps): Promise<HaltConvergeOutcome> => {
    const releases = await aliasReleases(deps.database, row);

    if (releases === undefined) {
        return { skipped: "the alias has no live release to restore" };
    }

    const { live, onWorker } = releases;
    const [liveManifest, ...newer] = await manifestsOf(deps.releases, [live, ...onWorker.filter((deployment) => deployment._id !== live._id)]);
    const dropped = [...new Set(newer.flatMap((manifest) => droppedDurableObjectClasses(manifest, liveManifest)))];

    if (dropped.length > 0) {
        throw new LunoraError(
            "CONFLICT",
            `resuming onto the live release would delete the data of Durable Object class(es) ${dropped.join(", ")}, which a newer release on the Worker binds; the alias stays halted — see the RUNBOOK`,
        );
    }

    const target = targetOf(live.target);

    await reprovision({ deploymentId: live._id, organizationId: row.organizationId }, storeReleaseDeps(deps, live, target), { keepClasses: true });

    return { deploymentId: live._id };
};
