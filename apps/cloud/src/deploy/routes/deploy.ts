/**
 * The deploy core wired to the Worker (`./release-core`, `../release`): what
 * `POST /v1/deploy`, both rollback routes and a git build's release run on.
 *
 * - `POST /v1/deploy` — `deployKey`: the CLI's deploy, streamed as NDJSON.
 * - `POST /v1/deployments/rollback` — `deployKey`: the CLI's rollback.
 * - `POST /v1/rollback` — `session`: the studio's rollback.
 *
 * {@link createDeployRoutes} is built once per router, so its {@link CellScheduler}
 * paces every converge of this Worker instance (≈ per cell) against the
 * account's API budget (§2.5).
 */
import { LunoraError } from "@lunora/errors";

import { api, internal } from "../../../lunora/_generated/api.js";
import { captureServerEvent } from "../../analytics/capture";
import { dispatchBuilds, runBuildStage } from "../../builds/control-plane";
import type { BuildJob, BuildStage } from "../../builds/runner-job";
import type { DeployKind } from "../../provision-contract";
import { decryptSecret } from "../../secrets/crypto";
import type { Placement, StoredPlacement } from "../../targets/placement";
import { resolvePlacement, targetOf } from "../../targets/placement";
import { resolveTargetDriver } from "../../targets/registry";
import { resolveTelemetryConfig } from "../../telemetry/ingest-key";
import type { StoredAdminToken } from "../admin-token";
import { resolveAdminToken, sealAdminToken } from "../admin-token";
import { handleDeployRequest } from "../handler";
import type { ReleaseDeps } from "../release";
import { rollbackRelease } from "../release";
import type { DeployBackend, DeployHandlerDeps, DeployTarget } from "../release-core";
import { createReleaseStore } from "../release-store";
import type { CellScheduler } from "../scheduler";
import type { LunoraActionContext, RouterEnv } from "./shared";
import { jsonError, rejected, requireContext, strictBearer } from "./shared";
import { requireAdminToken } from "./tenant-admin";

interface EncryptedSecretRow {
    ciphertext: string;
    iv: string;
    name: string;
}

/** The cell this control-plane deployment runs in — the only thing `LUNORA_CELL` decides (`src/targets/placement.ts`). */
const thisCell = (environment: RouterEnv): string => environment.LUNORA_CELL ?? "default";

/** A project's placement, read per project and checked against this control plane's cell. */
export const placementFor = async (context: LunoraActionContext, environment: RouterEnv, organizationId: string, projectId: string): Promise<Placement> =>
    resolvePlacement(await context.runQuery<StoredPlacement>(internal.projects.placement, { organizationId, projectId }), thisCell(environment));

/**
 * Decrypt the project's stored secrets at the edge for the deploy spec.
 *
 * The rows are read FIRST, then the master key decides. Returning `{}` on a
 * missing key meant a control plane whose key was removed, rotated badly, or
 * never set in one cell shipped tenant Workers with none of their secrets —
 * silently, reported as a successful release. With no secrets stored there is
 * nothing to drop and the deploy is genuinely fine, so only the contradiction fails.
 */
const resolveSecrets =
    (context: LunoraActionContext, environment: RouterEnv): NonNullable<ReleaseDeps["backend"]["resolveSecrets"]> =>
    async ({ key, kind, organizationId, projectId }) => {
        const rows = await context.runQuery<EncryptedSecretRow[]>(api.secrets.listEncrypted, { deployKey: key, environment: kind, organizationId, projectId });
        const masterKey = environment.SECRET_ENCRYPTION_KEY;

        if (!masterKey) {
            if (rows.length > 0) {
                throw new LunoraError(
                    "INTERNAL",
                    `this project has ${String(rows.length)} stored secret(s) but the control plane has no SECRET_ENCRYPTION_KEY to decrypt them — deploying would ship a Worker with none of them`,
                );
            }

            return {};
        }

        const entries = await Promise.all(
            rows.map(async (row): Promise<[string, string]> => [row.name, await decryptSecret(masterKey, { ciphertext: row.ciphertext, iv: row.iv })]),
        );

        return Object.fromEntries(entries);
    };

/**
 * Everything re-provisioning a release needs, wired to this request's
 * control-plane context — shared by the deploy core (its automatic revert) and
 * both rollback routes. `undefined` when the cell has no `RELEASES` bucket:
 * without stored releases there is nothing to roll back to, so a deploy is
 * refused rather than shipped unrecoverable.
 */
const releaseDeps = (context: LunoraActionContext, environment: RouterEnv, scheduler: CellScheduler): ReleaseDeps | undefined => {
    if (!environment.RELEASES) {
        return undefined;
    }

    return {
        backend: {
            placement: ({ organizationId, projectId }) => placementFor(context, environment, organizationId, projectId),
            releaseTarget: async ({ deploymentId, key, organizationId }) => {
                const row = await context.runQuery<
                    StoredAdminToken & { alias: string; cronSpecs?: string[]; kind: DeployKind; liveDeploymentId?: string; projectId: string; target?: string }
                >(internal.deployments.releaseTarget, { deployKey: key, id: deploymentId, organizationId });
                // Unsealed here, at the edge, exactly as the studio proxy does.
                const adminToken = await resolveAdminToken(row, environment.SECRET_ENCRYPTION_KEY);

                if (!adminToken) {
                    throw new LunoraError("CONFLICT", "this deployment has no usable admin token");
                }

                return {
                    adminToken,
                    alias: row.alias,
                    ...(row.cronSpecs === undefined ? {} : { cronSpecs: row.cronSpecs }),
                    kind: row.kind,
                    ...(row.liveDeploymentId === undefined ? {} : { liveDeploymentId: row.liveDeploymentId }),
                    organizationId,
                    projectId: row.projectId,
                    target: targetOf(row.target),
                };
            },
            resolveSecrets: resolveSecrets(context, environment),
            rollbackDeployment: ({ deploymentId, key, organizationId }) =>
                context.runMutation<{ scriptName: string; version?: number }>(internal.deployments.rollback, {
                    deployKey: key,
                    id: deploymentId,
                    organizationId,
                }),
        },
        driverFor: (placement) => resolveTargetDriver(placement, environment),
        releases: createReleaseStore(environment.RELEASES),
        // Provision (once per org) the scoped ingest key + hand the tenant its
        // OTLP endpoint/token (src/telemetry/ingest-key).
        resolveTelemetry: (input) => resolveTelemetryConfig(context, environment, input),
        scheduler,
    };
};

/**
 * Probe the project's Worker once the release is on it (GAPS.md A1): any
 * response below 500 counts as healthy (the app may 404 its root route); a
 * network error or 5xx fails the release and reverts to the previous one.
 */
const healthCheck = async (url: string): Promise<boolean> => {
    try {
        const response = await fetch(url, { method: "GET" });

        return response.status < 500;
    } catch {
        return false;
    }
};

/**
 * Everything the deploy core needs, wired to this request's control-plane
 * context — the ONE wiring both callers share: `POST /v1/deploy`, and a git
 * build's release. `undefined` without the `RELEASES` bucket, for the reason
 * {@link releaseDeps} gives.
 */
export const deployDeps = (context: LunoraActionContext, environment: RouterEnv, scheduler: CellScheduler): DeployHandlerDeps | undefined => {
    const release = releaseDeps(context, environment, scheduler);

    if (!release) {
        return undefined;
    }

    const cell = thisCell(environment);

    // Fire-and-forget, on the execution context so it outlives the response
    // rather than being cancelled with it. Keyed on the ORGANIZATION: a
    // platform event is about a tenant, not about a person.
    const analytics = (event: string, properties: Record<string, boolean | number | string>): void => {
        environment.__executionCtx?.waitUntil?.(
            captureServerEvent(environment, event, { cell, organizationId: String(properties.organizationId ?? "") }, properties),
        );
    };

    const backend: DeployBackend = {
        ...release.backend,
        // Record the health-checked release live and supersede the previous
        // live release of its alias (GAPS.md A1).
        activateDeployment: async ({ deploymentId, key }) => {
            await context.runMutation(api.deployments.activate, { deployKey: key, id: deploymentId });
        },
        createDeployment: async ({ adminToken, branch, cronSpecs, key, kind, organizationId, projectId, scriptName }) => {
            // Seal the admin token at the edge — the control-plane D1 stores
            // ciphertext + IV (plaintext only in dev without a master key).
            const sealed = await sealAdminToken(adminToken, environment.SECRET_ENCRYPTION_KEY);

            return context.runMutation<{ deploymentId: string; previousDeploymentId?: string; version: number }>(api.deployments.create, {
                ...sealed,
                branch,
                ...(cronSpecs && cronSpecs.length > 0 ? { cronSpecs } : {}),
                deployKey: key,
                kind,
                organizationId,
                projectId,
                scriptName,
            });
        },
        updateStatus: async ({ bundleHash, deploymentId, key, status, url }) => {
            await context.runMutation(api.deployments.updateStatus, { bundleHash, deployKey: key, id: deploymentId, status, url });
        },
        verifyKey: (key) => context.runMutation<DeployTarget | null>(api.deploy_keys.verify, { key }),
    };

    return { ...release, analytics, backend, healthCheck };
};

type RouteHandler = (request: Request, environment: RouterEnv) => Promise<Response>;

/** The deploy, rollback and build-dispatch routes over one scheduler. */
export const createDeployRoutes = (
    scheduler: CellScheduler,
): {
    handleBuildDispatchRoute: RouteHandler;
    handleBuildRunRoute: RouteHandler;
    handleDeployRoute: RouteHandler;
    handleRollbackRoute: RouteHandler;
    handleSessionRollbackRoute: RouteHandler;
} => {
    const handleDeployRoute: RouteHandler = async (request, environment) => {
        const deps = deployDeps(requireContext(environment), environment, scheduler);

        if (!deps) {
            return jsonError(500, "the RELEASES bucket is not configured; a deploy without a stored release could never be rolled back");
        }

        return handleDeployRequest(request, deps);
    };

    /**
     * Roll a project back to a retained release: re-provision its stored bundle
     * onto the alias's Worker, then record it live (GAPS.md A1). `key` is the
     * deploy key, or `undefined` for the studio, whose member session authorizes.
     */
    const rollback = async (request: Request, environment: RouterEnv, key: string | undefined): Promise<Response> => {
        const release = releaseDeps(requireContext(environment), environment, scheduler);

        if (!release) {
            return jsonError(500, "the RELEASES bucket is not configured");
        }

        let body: { deploymentId?: string; organizationId?: string };

        try {
            body = await request.json();
        } catch {
            return jsonError(400, "invalid JSON body");
        }

        if (!body.deploymentId || !body.organizationId) {
            return jsonError(400, "deploymentId and organizationId are required");
        }

        try {
            const result = await rollbackRelease({ deploymentId: body.deploymentId, key, organizationId: body.organizationId }, release);

            return Response.json({ ok: true, ...result });
        } catch (error) {
            return rejected(error, "rollback failed");
        }
    };

    return {
        /**
         * `POST /v1/builds/dispatch` — claim queued git builds and hand each to
         * its build runner (GAPS.md A3). Called in-process by the Worker's own
         * every-minute `scheduled()` (`drainBuildQueue` in
         * `src/sweeps/scheduled.ts`), which is what hands it the request-scoped
         * Lunora context every route runs on. Admin-token gated like every other
         * platform-internal route.
         */
        handleBuildDispatchRoute: async (request, environment) => {
            const unauthorized = requireAdminToken(request, environment);

            if (unauthorized) {
                return unauthorized;
            }

            return Response.json(await dispatchBuilds({ context: requireContext(environment), environment }));
        },

        /**
         * `POST /v1/builds/run` — run one half of a build (`{ job, stage }`),
         * called in-process by its build runner's alarm (`src/builds/runner-do.ts`).
         * A route, and not code in the runner, because a build's mutations and
         * its release need the Lunora context and this Worker's bindings, which
         * a route is handed. Admin-token gated; the body is the runner's own.
         */
        handleBuildRunRoute: async (request, environment) => {
            const unauthorized = requireAdminToken(request, environment);

            if (unauthorized) {
                return unauthorized;
            }

            const body = (await request.json().catch(() => null)) as null | { job?: BuildJob; stage?: BuildStage };

            if (!body?.job || (body.stage !== "build" && body.stage !== "release" && body.stage !== "interrupted")) {
                return jsonError(400, "job and stage are required");
            }

            const context = requireContext(environment);

            return Response.json(await runBuildStage({ context, deploy: deployDeps(context, environment, scheduler), environment }, body.job, body.stage));
        },
        handleDeployRoute,
        // POST /v1/deployments/rollback — the CLI's rollback, deploy-key authorized.
        handleRollbackRoute: async (request, environment) => {
            const key = strictBearer(request);

            return key ? rollback(request, environment, key) : jsonError(401, "missing bearer deploy key");
        },
        // POST /v1/rollback — the studio's rollback, under the caller's member session.
        handleSessionRollbackRoute: (request, environment) => rollback(request, environment, undefined),
    };
};
