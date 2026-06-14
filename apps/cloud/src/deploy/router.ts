import type { ExecutionContextLike } from "@cirrus/runtime";

import { api } from "../../cirrus/_generated/api.js";
import { proxyAdminRequest } from "../admin/proxy";
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

interface AdminBody {
    body?: unknown;
    deploymentId?: string;
    method?: string;
    organizationId?: string;
    path?: string;
}

const jsonError = (status: number, error: string): Response => Response.json({ error }, { headers: { "content-type": "application/json" }, status });

/** `POST /v1/github/webhook` — verify + resolve the connected project (§2.3). */
const handleWebhookRoute = (request: Request, environment: RouterEnv): Promise<Response> => {
    if (!environment.GITHUB_WEBHOOK_SECRET) {
        return Promise.resolve(jsonError(500, "github webhook secret not configured"));
    }

    const context = environment.__cirrusCtx;

    if (!context) {
        return Promise.resolve(jsonError(500, "cirrus context unavailable"));
    }

    return handleGitHubWebhook(request, {
        resolveProject: (repository) => context.runMutation<null | ProjectResolution>(api.projects.byGithubRepo, { repository }),
        secret: environment.GITHUB_WEBHOOK_SECRET,
    });
};

/** `POST /v1/admin` — hosted-studio admin proxy to a tenant deployment (§3). */
const handleAdminRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__cirrusCtx;

    if (!context) {
        return jsonError(500, "cirrus context unavailable");
    }

    const adminBody = (await request.json().catch(() => null)) as AdminBody | null;

    if (!adminBody?.organizationId || !adminBody.deploymentId || !adminBody.path) {
        return jsonError(400, "organizationId, deploymentId and path are required");
    }

    try {
        return await proxyAdminRequest(
            {
                body: adminBody.body,
                deploymentId: adminBody.deploymentId,
                method: adminBody.method ?? "GET",
                organizationId: adminBody.organizationId,
                path: adminBody.path,
            },
            {
                authorize: () => Promise.resolve(), // membership is asserted by `adminTarget`
                recordAudit: async (entry) => {
                    await context.runMutation(api.audit_log.record, { action: entry.action, organizationId: entry.organizationId });
                },
                resolveTarget: (organizationId, deploymentId) =>
                    context.runMutation<null | { adminToken: string; url: string }>(api.deployments.adminTarget, { deploymentId, organizationId }),
            },
        );
    } catch (error) {
        return jsonError(403, error instanceof Error ? error.message : "admin request denied");
    }
};

/**
 * The control-plane HTTP API, mounted as the worker's `httpRouter` (lowest-
 * priority matcher). Routes `POST /v1/{deploy,github/webhook,admin}` and 404s
 * the rest. The worker injects the per-request Cirrus action context on
 * `env.__cirrusCtx`; handlers reach the control-plane functions through it.
 */
export const createDeployRouter = (): HttpRouterLike => {
    // One scheduler per worker instance (≈ per cell): paces all Cloudflare API
    // work against the account's 1,200-req/5-min budget (§2.5).
    const scheduler = new CellScheduler({ bucket: cloudflareAccountBudget() });

    const handleDeployRoute = (request: Request, environment: RouterEnv): Promise<Response> => {
        const context = environment.__cirrusCtx;

        if (!context) {
            return Promise.resolve(jsonError(500, "cirrus context unavailable"));
        }

        const cell = environment.CIRRUS_CELL ?? "default";
        const appDomain = environment.CIRRUS_APP_DOMAIN ?? "cirrus.app";
        const cloudflareApi = createHttpCloudflareApi({ accountId: environment.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: environment.CLOUDFLARE_API_TOKEN ?? "" });
        const provisioner = createCloudflareProvisioner({ api: cloudflareApi, urlForScript: (scriptName) => `https://${scriptName}.${appDomain}` });

        const backend: DeployBackend = {
            createDeployment: async ({ adminToken, branch, key, kind, organizationId, projectId, scriptName }) => {
                const deploymentId = await context.runMutation<string>(api.deployments.create, {
                    adminToken,
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

        return handleDeployRequest(request, { backend, cell, dispatchNamespace: (kind) => `cirrus-${kind}`, provisioner, scheduler });
    };

    return {
        fetch(request, environment) {
            const url = new URL(request.url);
            const routerEnv = (environment ?? {}) as RouterEnv;

            if (request.method === "POST" && url.pathname === "/v1/github/webhook") {
                return handleWebhookRoute(request, routerEnv);
            }

            if (request.method === "POST" && url.pathname === "/v1/admin") {
                return handleAdminRoute(request, routerEnv);
            }

            if (request.method === "POST" && url.pathname === "/v1/deploy") {
                return handleDeployRoute(request, routerEnv);
            }

            return Promise.resolve(jsonError(404, "not found"));
        },
    };
};
