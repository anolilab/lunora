import { LunoraError } from "@lunora/server";

import type { AssetsUpload, DeployKind, DeployManifest, TargetId, TenantDeploymentSpec } from "../provision-contract";
import { TARGETS } from "../provision-contract";
import type { TargetDriver } from "../targets/driver";
import type { Placement } from "../targets/placement";
import type { DeployPacer } from "./pacing";
import type { ReleaseStore } from "./release-store";

/**
 * Releases on a project's one stable Worker.
 *
 * Every deploy and every rollback converges the same tenant (the alias) on the
 * project's target, so the project's Durable Object data survives both. A release
 * is therefore a stored payload ({@link ReleaseStore}), and "go back to release N"
 * means re-converging N's bundle onto the stable tenant — {@link reprovision}.
 * The deploy handler uses it to undo a release that failed its health check;
 * {@link rollbackRelease} uses it for an operator's rollback.
 */

/** What re-provisioning a stored release needs to know about its deployment row. */
export interface ReleaseTarget {
    /** The deployment's tenant admin token, unsealed at the edge — set as the Worker's `LUNORA_ADMIN_TOKEN`. */
    adminToken: string;
    alias: string;
    /** The deployment's cron expressions (`deployments.cronSpecs`), when it declared any. */
    cronSpecs?: string[];
    kind: DeployKind;
    /** The deployment currently on the Worker (the live one of this alias), when there is one. */
    liveDeploymentId?: string;
    organizationId: string;
    projectId: string;
    /** The target the release was converged on (`deployments.target`). */
    target: TargetId;
}

/** The control-plane operations a re-provision needs. `key` is the deploy key; absent means the caller's member session authorizes. */
export interface ReleaseBackend {
    /**
     * Where the project deploys: its target, after checking that this control
     * plane may converge it (`resolvePlacement`, `src/targets/placement.ts`).
     * Throws — `CONFLICT` for a project placed elsewhere — rather than answer
     * a placement this deployment cannot honour.
     */
    placement: (input: { key?: string; organizationId: string; projectId: string }) => Promise<Placement>; // secret-scanner:allow -- domain field name
    /** Resolve a live or superseded deployment of `organizationId` the caller may re-provision. Throws otherwise. */
    releaseTarget: (input: { deploymentId: string; key?: string; organizationId: string }) => Promise<ReleaseTarget>;
    /** Decrypted tenant env secrets to inject into the deployed Worker (§7). Optional. */
    resolveSecrets?: (input: { key?: string; kind: DeployKind; organizationId: string; projectId: string }) => Promise<Record<string, string>>; // secret-scanner:allow -- domain field name
    /** Record a completed rollback: the target becomes live and the project pointer moves to it. */
    rollbackDeployment: (input: { deploymentId: string; key?: string; organizationId: string }) => Promise<{ scriptName: string; version?: number }>;
}

export interface ReleaseDeps {
    backend: ReleaseBackend;

    /**
     * The driver for a placement, built for this request's env
     * (`resolveTargetDriver` in `src/targets/registry.ts`) when a converge runs.
     * Every converge goes through it; where the tenant lands — a cell's dispatch
     * namespace, a box — is the placement's, not the release's.
     */
    driverFor: (placement: Placement) => TargetDriver;
    /** Paces each converge against the budget its placement spends (§2.5, `src/deploy/pacing.ts`). */
    pacer: DeployPacer;
    /** Where each deployment's payload is kept for rollback. */
    releases: ReleaseStore;

    /**
     * Resolve the telemetry config injected into a tenant Worker: the OTLP ingest
     * endpoint (set as a `LUNORA_OTLP_ENDPOINT` var), a scoped ingest token (set
     * as a `LUNORA_OTLP_TOKEN` secret, so a tenant's `otlpSink` ships to the
     * cloud); a resolved config also wires the driver's log source. Omit — or return undefined —
     * to deploy without telemetry (everything still works). Best-effort: a throw
     * is swallowed and the deploy proceeds untelemetered.
     */
    resolveTelemetry?: (input: { key?: string; organizationId: string }) => Promise<DeployTelemetry | undefined>;
}

/** The telemetry wiring injected into a tenant deploy, when the cell resolved any. */
export interface DeployTelemetry {
    endpoint: string;
    token: string;
}

/** Decode the base64 bundle payload into the ArrayBuffer the driver converges, or `null` if malformed. */
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
 * Assemble the {@link TenantDeploymentSpec} for one release: pure assembly, with
 * every telemetry-conditional field in one place.
 */
const buildDeploymentSpec = (input: {
    adminToken: string;
    alias: string;
    assets: AssetsUpload | undefined;
    bundle: ArrayBuffer;
    cronSpecs?: string[];
    deploymentId: string;
    kind: DeployKind;
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
        ...(telemetry ? { collectLogs: true } : {}),
        ...(input.cronSpecs && input.cronSpecs.length > 0 ? { crons: input.cronSpecs } : {}),
        deploymentId: input.deploymentId,
        kind: input.kind,
        manifest: input.manifest,
        secrets: { ...input.tenantSecrets, LUNORA_ADMIN_TOKEN: input.adminToken, ...(telemetry ? { LUNORA_OTLP_TOKEN: telemetry.token } : {}) },
        tags: [`org:${input.organizationId}`, `project:${input.projectId}`, `env:${input.kind}`],
        ...(telemetry ? { vars: { LUNORA_OTLP_ENDPOINT: telemetry.endpoint } } : {}),
    };
};

/** Best-effort telemetry: a failure here must never fail a deploy, so the tenant just ships untelemetered. */
const resolveTelemetrySafely = async (deps: ReleaseDeps, input: { key?: string; organizationId: string }): Promise<DeployTelemetry | undefined> => {
    try {
        return await deps.resolveTelemetry?.(input);
    } catch {
        return undefined;
    }
};

/** One release of a deployment row, as {@link resolveReleaseSpec} assembles its spec. */
export interface ReleaseSpecInput {
    adminToken: string;
    alias: string;
    assets: AssetsUpload | undefined;
    bundle: ArrayBuffer;
    cronSpecs?: string[];
    deploymentId: string;
    /** The deploy key every backend call authorizes by; absent for a member session. */
    key?: string;
    kind: DeployKind;
    manifest: DeployManifest;
    organizationId: string;
    projectId: string; // secret-scanner:allow -- domain field name
}

/**
 * The target-neutral spec for one release — a deploy, its automatic revert, or
 * a rollback. Secrets and telemetry are resolved NOW, never replayed: the
 * release store holds no secrets, and every converge should run with the
 * project's current configuration. `LUNORA_ADMIN_TOKEN` is platform-owned and
 * always wins over a same-named tenant secret.
 * @throws when the project's secrets cannot be resolved (a corrupt secret, a missing master key).
 */
export const resolveReleaseSpec = async (input: ReleaseSpecInput, deps: ReleaseDeps): Promise<TenantDeploymentSpec> => {
    const { key, kind, organizationId, projectId } = input;
    const tenantSecrets = (await deps.backend.resolveSecrets?.({ key, kind, organizationId, projectId })) ?? {}; // secret-scanner:allow -- domain field name

    return buildDeploymentSpec({
        adminToken: input.adminToken,
        alias: input.alias,
        assets: input.assets,
        bundle: input.bundle,
        ...(input.cronSpecs ? { cronSpecs: input.cronSpecs } : {}),
        deploymentId: input.deploymentId,
        kind,
        manifest: input.manifest,
        organizationId,
        projectId, // secret-scanner:allow -- domain field name
        telemetry: await resolveTelemetrySafely(deps, { key, organizationId }),
        tenantSecrets,
    });
};

/** Durable Object classes the Worker binds, by class name. */
const durableObjectClasses = (manifest: DeployManifest): Set<string> =>
    new Set(manifest.bindings.flatMap((requirement) => (requirement.type === "durable_object" && requirement.className ? [requirement.className] : [])));

/**
 * Put a stored release back on the project's stable Worker, with its spec
 * resolved by {@link resolveReleaseSpec}. The admin token is the target
 * deployment's own, so its row's sealed token keeps working with the studio proxy.
 * @throws {LunoraError} `CONFLICT` when the release was pruned, or — with `keepClasses`, on a target that drops unbound classes — when it drops a Durable Object class the live release binds.
 */
export const reprovision = async (
    input: { deploymentId: string; key?: string; organizationId: string },
    deps: ReleaseDeps,
    options: {
        /**
         * Refuse a release that stops binding a Durable Object class the live
         * release binds, on a target whose converge would delete that class's
         * data (`TARGETS[target].dropsUnboundClasses`).
         */
        keepClasses?: boolean;
        priority?: number;
    } = {},
): Promise<void> => {
    const { deploymentId, key } = input;
    // Independent reads; `releaseTarget` still authorizes before anything is provisioned.
    const [target, release] = await Promise.all([deps.backend.releaseTarget(input), deps.releases.get(deploymentId)]);

    if (!release) {
        throw new LunoraError("CONFLICT", "this release's bundle is no longer retained; deploy it again instead of rolling back");
    }

    // After `releaseTarget`, which authorized the caller for this organization.
    // The release goes back where it was converged, and only if the project
    // still deploys there from this control plane's cell.
    const placement = await deps.backend.placement({ key, organizationId: target.organizationId, projectId: target.projectId }); // secret-scanner:allow -- domain field name

    if (placement.target !== target.target) {
        throw new LunoraError(
            "CONFLICT",
            `this release was deployed to ${target.target}, but the project now deploys to ${placement.target}; deploy it again instead of rolling back`,
        );
    }

    const live =
        options.keepClasses &&
        TARGETS[placement.target].dropsUnboundClasses &&
        target.liveDeploymentId !== undefined &&
        target.liveDeploymentId !== deploymentId
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

    const spec = await resolveReleaseSpec(
        {
            adminToken: target.adminToken,
            alias: target.alias,
            assets: release.assets,
            bundle,
            ...(target.cronSpecs ? { cronSpecs: target.cronSpecs } : {}),
            deploymentId,
            ...(key === undefined ? {} : { key }),
            kind: target.kind,
            manifest: release.manifest,
            organizationId: target.organizationId,
            projectId: target.projectId, // secret-scanner:allow -- domain field name
        },
        deps,
    );
    const driver = deps.driverFor(placement);

    await deps.pacer.schedulerFor(placement).run(() => driver.deploy(spec), { priority: options.priority });
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
