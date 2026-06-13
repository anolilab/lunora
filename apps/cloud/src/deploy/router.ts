import type { ExecutionContextLike } from "@cirrus/runtime";

import { api } from "../../cirrus/_generated/api.js";
import { createAlchemyProvisioner } from "../provision";
import type { DeployBackend, DeployTarget } from "./handler";
import { handleDeployRequest } from "./handler";
import { CellScheduler } from "./scheduler";
import { cloudflareAccountBudget } from "./token-bucket";

/** The Cirrus action context the worker injects on `env.__cirrusCtx`. */
interface CirrusActionContext {
    runMutation: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
}

interface RouterEnv {
    __cirrusCtx?: CirrusActionContext;
    CIRRUS_CELL?: string;
    CLOUDFLARE_API_TOKEN?: string;
}

interface HttpRouterLike {
    fetch: (request: Request, environment?: unknown, context?: ExecutionContextLike) => Promise<Response>;
}

const jsonError = (status: number, error: string): Response => Response.json({ error }, { headers: { "content-type": "application/json" }, status });

/**
 * The control-plane deploy API, mounted as the worker's `httpRouter` (the
 * lowest-priority matcher, after auth + reserved `/_cirrus/*` routes). It owns
 * `POST /v1/deploy` and 404s everything else (the control plane serves no SSR).
 *
 * The worker injects the per-request Cirrus action context on `env.__cirrusCtx`;
 * the deploy backend uses its `runMutation` to reach the control-plane mutations
 * (`deploy_keys:verify`, `deployments:create`/`updateStatus`) — all authorized
 * by the deploy key, so no user session is required (CLOUD-PLAN.md §2.2).
 */
export const createDeployRouter = (): HttpRouterLike => {
    // One scheduler per worker instance (≈ per cell): paces all Cloudflare API
    // work against the account's 1,200-req/5-min budget (§2.5).
    const scheduler = new CellScheduler({ bucket: cloudflareAccountBudget() });

    return {
        async fetch(request, environment) {
            const url = new URL(request.url);

            if (request.method !== "POST" || url.pathname !== "/v1/deploy") {
                return jsonError(404, "not found");
            }

            const routerEnv = (environment ?? {}) as RouterEnv;
            const context = routerEnv.__cirrusCtx;

            if (!context) {
                return jsonError(500, "cirrus context unavailable");
            }

            const cell = routerEnv.CIRRUS_CELL ?? "default";
            const backend: DeployBackend = {
                createDeployment: async ({ branch, key, kind, organizationId, projectId, scriptName }) => {
                    const deploymentId = await context.runMutation<string>(api.deployments.create, {
                        branch,
                        deployKey: key,
                        kind,
                        organizationId,
                        projectId,
                        scriptName,
                    });

                    return { deploymentId };
                },
                updateStatus: async ({ bundleHash, deploymentId, key, status, url: deployedUrl }) => {
                    await context.runMutation(api.deployments.updateStatus, { bundleHash, deployKey: key, id: deploymentId, status, url: deployedUrl });
                },
                verifyKey: (key) => context.runMutation<DeployTarget | null>(api.deploy_keys.verify, { key }),
            };

            return handleDeployRequest(request, {
                backend,
                cell,
                dispatchNamespace: (kind) => `cirrus-${kind}`,
                provisioner: createAlchemyProvisioner({ cell, cloudflareApiToken: routerEnv.CLOUDFLARE_API_TOKEN ?? "" }),
                scheduler,
            });
        },
    };
};
