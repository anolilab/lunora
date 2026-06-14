import type { ExecutionContextLike } from "@cirrus/runtime";

import { api } from "../../cirrus/_generated/api.js";
import { createHttpCloudflareApi } from "../cloudflare/api";
import { handleGitHubWebhook } from "../github/webhook";
import { createCloudflareProvisioner } from "../provision";
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
    CIRRUS_APP_DOMAIN?: string;
    CIRRUS_CELL?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
    GITHUB_WEBHOOK_SECRET?: string;
}

interface HttpRouterLike {
    fetch: (request: Request, environment?: unknown, context?: ExecutionContextLike) => Promise<Response>;
}

type ProjectResolution = { organizationId: string; projectId: string; slug: string }; // secret-scanner:allow -- domain field name

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
            const routerEnv = (environment ?? {}) as RouterEnv;

            // GitHub webhook → preview automation (§2.3). Self-authenticating via
            // its HMAC signature; resolves the connected project via the Cirrus ctx.
            if (request.method === "POST" && url.pathname === "/v1/github/webhook") {
                if (!routerEnv.GITHUB_WEBHOOK_SECRET) {
                    return jsonError(500, "github webhook secret not configured");
                }

                const webhookContext = routerEnv.__cirrusCtx;

                if (!webhookContext) {
                    return jsonError(500, "cirrus context unavailable");
                }

                return handleGitHubWebhook(request, {
                    resolveProject: (repository) => webhookContext.runMutation<null | ProjectResolution>(api.projects.byGithubRepo, { repository }),
                    secret: routerEnv.GITHUB_WEBHOOK_SECRET,
                });
            }

            if (request.method !== "POST" || url.pathname !== "/v1/deploy") {
                return jsonError(404, "not found");
            }

            const context = routerEnv.__cirrusCtx;

            if (!context) {
                return jsonError(500, "cirrus context unavailable");
            }

            const cell = routerEnv.CIRRUS_CELL ?? "default";
            const appDomain = routerEnv.CIRRUS_APP_DOMAIN ?? "cirrus.app";
            const cloudflareApi = createHttpCloudflareApi({
                accountId: routerEnv.CLOUDFLARE_ACCOUNT_ID ?? "",
                apiToken: routerEnv.CLOUDFLARE_API_TOKEN ?? "",
            });
            const provisioner = createCloudflareProvisioner({ api: cloudflareApi, urlForScript: (scriptName) => `https://${scriptName}.${appDomain}` });
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
                provisioner,
                scheduler,
            });
        },
    };
};
