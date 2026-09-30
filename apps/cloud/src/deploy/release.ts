import { LunoraError } from "@lunora/server";

import type { Provisioner } from "../provision";
import type { AssetsUpload, DeployManifest, TenantDeploymentSpec } from "../provision-contract";
import type { ReleaseStore } from "./release-store";
import type { CellScheduler } from "./scheduler";

/**
 * Releases on a project's one stable Worker.
 *
 * Every deploy and every rollback converges the same dispatch-namespace script
 * (the alias), so the project's Durable Object data survives both. A release is
 * therefore a stored payload ({@link ReleaseStore}), and "go back to release N"
 * means re-provisioning N's bundle onto the stable script — {@link reprovision}.
 * The deploy handler uses it to undo a release that failed its health check;
 * {@link rollbackRelease} uses it for an operator's rollback.
 */

export type DeployKind = "dev" | "preview" | "production";

/** What re-provisioning a stored release needs to know about its deployment row. */
export interface ReleaseTarget {
    /** The deployment's tenant admin token, unsealed at the edge — set as the Worker's `LUNORA_ADMIN_TOKEN`. */
    adminToken: string;
    alias: string;
    kind: DeployKind;
    /** The deployment currently on the Worker (the live one of this alias), when there is one. */
    liveDeploymentId?: string;
    organizationId: string;
    projectId: string;
}

/** The control-plane operations a re-provision needs. `key` is the deploy key; absent means the caller's member session authorizes. */
export interface ReleaseBackend {
    /** Resolve a live or superseded deployment of `organizationId` the caller may re-provision. Throws otherwise. */
    releaseTarget: (input: { deploymentId: string; key?: string; organizationId: string }) => Promise<ReleaseTarget>;
    /** Decrypted tenant env secrets to inject into the deployed Worker (§7). Optional. */
    resolveSecrets?: (input: { key?: string; kind: DeployKind; organizationId: string; projectId: string }) => Promise<Record<string, string>>; // secret-scanner:allow -- domain field name
    /** Record a completed rollback: the target becomes live and the project pointer moves to it. */
    rollbackDeployment: (input: { deploymentId: string; key?: string; organizationId: string }) => Promise<{ scriptName: string; version?: number }>;
}

export interface ReleaseDeps {
    backend: ReleaseBackend;
    /** Cell hosting this deployment (§2.5). */
    cell: string;
    /** Map a deployment kind to the dispatch namespace it deploys into. */
    dispatchNamespace: (kind: DeployKind) => string;
    provisioner: Provisioner;
    /** Where each deployment's payload is kept for rollback. */
    releases: ReleaseStore;

    /**
     * Resolve the telemetry config injected into a tenant Worker: the OTLP ingest
     * endpoint (set as a `LUNORA_OTLP_ENDPOINT` var), a scoped ingest token (set
     * as a `LUNORA_OTLP_TOKEN` secret, so a tenant's `otlpSink` ships to the
     * cloud), and the tail-consumer service to wire. Omit — or return undefined —
     * to deploy without telemetry (everything still works). Best-effort: a throw
     * is swallowed and the deploy proceeds untelemetered.
     */
    resolveTelemetry?: (input: { key?: string; organizationId: string }) => Promise<DeployTelemetry | undefined>;
    scheduler: CellScheduler;
}

/** The telemetry wiring injected into a tenant deploy, when the cell resolved any. */
export interface DeployTelemetry {
    endpoint: string;
    tailConsumer?: string;
    token: string;
}

/** Decode the base64 bundle payload into the ArrayBuffer the provisioner uploads, or `null` if malformed. */
export const decodeBundle = (encoded: string): ArrayBuffer | null => {
    try {
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);

        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.codePointAt(index) ?? 0;
        }

        return bytes.buffer;
    } catch {
        return null;
    }
};

/**
 * Assemble the {@link TenantDeploymentSpec} for one release.
 *
 * Split out of the NDJSON stream body because it is pure assembly — every
 * telemetry-conditional field lives here, so the streaming half reads as the
 * sequence of steps it is.
 */
export const buildDeploymentSpec = (input: {
    adminToken: string;
    alias: string;
    assets: AssetsUpload | undefined;
    bundle: ArrayBuffer;
    cell: string;
    dispatchNamespace: string;
    kind: string;
    manifest: DeployManifest;
    organizationId: string;
    projectId: string; // gitleaks:allow -- a field declaration; the scanner matches the Cypress project-id shape
    telemetry: DeployTelemetry | undefined;
    tenantSecrets: Record<string, string>;
}): TenantDeploymentSpec => {
    const { telemetry } = input;

    return {
        alias: input.alias,
        ...(input.assets ? { assets: input.assets } : {}),
        bundle: input.bundle,
        cell: input.cell,
        dispatchNamespace: input.dispatchNamespace,
        manifest: input.manifest,
        secrets: { ...input.tenantSecrets, LUNORA_ADMIN_TOKEN: input.adminToken, ...(telemetry ? { LUNORA_OTLP_TOKEN: telemetry.token } : {}) },
        ...(telemetry?.tailConsumer ? { tailConsumers: [telemetry.tailConsumer] } : {}),
        tags: [`org:${input.organizationId}`, `project:${input.projectId}`, `env:${input.kind}`],
        ...(telemetry ? { vars: { LUNORA_OTLP_ENDPOINT: telemetry.endpoint } } : {}),
    };
};

/** Best-effort telemetry: a failure here must never fail a deploy, so the tenant just ships untelemetered. */
export const resolveTelemetrySafely = async (deps: ReleaseDeps, input: { key?: string; organizationId: string }): Promise<DeployTelemetry | undefined> => {
    try {
        return await deps.resolveTelemetry?.(input);
    } catch {
        return undefined;
    }
};

/** Durable Object classes the Worker binds, by class name. */
const durableObjectClasses = (manifest: DeployManifest): Set<string> =>
    new Set(manifest.bindings.flatMap((requirement) => (requirement.type === "durable_object" && requirement.className ? [requirement.className] : [])));

/**
 * Put a stored release back on the project's stable Worker.
 *
 * Secrets and telemetry are resolved NOW, not replayed from the release: the
 * store never holds secrets, and a rolled-back Worker should run with the
 * project's current configuration exactly as a fresh deploy would. The admin
 * token is the target deployment's own, so its row's sealed token keeps working
 * with the studio proxy.
 * @throws {LunoraError} `CONFLICT` when the release was pruned, or — with `keepClasses` — when it drops a Durable Object class the live release binds.
 */
export const reprovision = async (
    input: { deploymentId: string; key?: string; organizationId: string },
    deps: ReleaseDeps,
    options: {
        /**
         * Refuse a release that stops binding a Durable Object class the live
         * release binds. Alchemy emits `deleted_classes` for a class a
         * dispatch-namespace Worker stops binding, so re-provisioning a release
         * that predates a class would delete that class's data.
         */
        keepClasses?: boolean;
        priority?: number;
    } = {},
): Promise<void> => {
    const { deploymentId, key } = input;
    const target = await deps.backend.releaseTarget(input);
    const release = await deps.releases.get(deploymentId);

    if (!release) {
        throw new LunoraError("CONFLICT", "this release's bundle is no longer retained; deploy it again instead of rolling back");
    }

    const live =
        options.keepClasses && target.liveDeploymentId !== undefined && target.liveDeploymentId !== deploymentId
            ? await deps.releases.get(target.liveDeploymentId)
            : null;

    if (live) {
        const kept = durableObjectClasses(release.manifest);
        const dropped = [...durableObjectClasses(live.manifest)].filter((className) => !kept.has(className));

        if (dropped.length > 0) {
            throw new LunoraError(
                "CONFLICT",
                `rolling back would delete the data of Durable Object class(es) ${dropped.join(", ")}, which the target release does not bind; deploy a fix forward instead`,
            );
        }
    }

    const bundle = decodeBundle(release.bundle);

    if (!bundle) {
        throw new LunoraError("INTERNAL", "the stored release bundle is corrupt");
    }

    const tenantSecrets =
        (await deps.backend.resolveSecrets?.({ key, kind: target.kind, organizationId: target.organizationId, projectId: target.projectId })) ?? {}; // secret-scanner:allow -- domain field name
    const telemetry = await resolveTelemetrySafely(deps, { key, organizationId: target.organizationId });
    const spec = buildDeploymentSpec({
        adminToken: target.adminToken,
        alias: target.alias,
        assets: release.assets,
        bundle,
        cell: deps.cell,
        dispatchNamespace: deps.dispatchNamespace(target.kind),
        kind: target.kind,
        manifest: release.manifest,
        organizationId: target.organizationId,
        projectId: target.projectId, // secret-scanner:allow -- domain field name
        telemetry,
        tenantSecrets,
    });

    await deps.scheduler.run(() => deps.provisioner.deploy(spec), { priority: options.priority });
};

/**
 * Roll a project back to a retained release: re-provision its stored bundle onto
 * the stable Worker, then record it live.
 *
 * The pointer moves only after the provision succeeds, so a failed rollback
 * leaves both the Worker and the record on the current release. No health check
 * follows — the target already passed one when it first went live, and there is
 * nothing safer to fall back to than the release the operator chose.
 */
export const rollbackRelease = async (
    input: { deploymentId: string; key?: string; organizationId: string },
    deps: ReleaseDeps,
): Promise<{ scriptName: string; version?: number }> => {
    await reprovision(input, deps, { keepClasses: true });

    return deps.backend.rollbackDeployment(input);
};
