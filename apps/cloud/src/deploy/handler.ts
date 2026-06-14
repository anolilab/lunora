import type { Provisioner, TenantDeploymentSpec } from "../provision";
import { randomSecret } from "./keys";
import type { DeployProgress } from "./orchestrator";
import { runDeployment } from "./orchestrator";
import type { CellScheduler } from "./scheduler";

/**
 * The deploy API request handler (CLOUD-PLAN.md §2.2). `POST /v1/deploy`:
 * authenticate the bearer deploy key, record a queued deployment, then drive the
 * orchestrator while streaming NDJSON progress (one JSON object per line). The
 * Cloudflare-touching work runs through the cell scheduler + the Alchemy
 * provisioner — both injected, so the whole flow is unit-testable with fakes.
 *
 * Pure: all I/O is behind {@link DeployBackend} + the injected provisioner/
 * scheduler. The Worker mount in `src/server.ts` wires the backend to the
 * control-plane mutations via the Cirrus action context.
 */

export type DeployKind = "dev" | "preview" | "production";

export interface DeployTarget {
    organizationId: string;
    projectId?: string;
    type: DeployKind;
}

/**
 * The control-plane operations the deploy flow needs. Every call carries the
 * presented deploy key so the underlying mutations can authorize by key (the
 * deploy request has no user session — see CLOUD-PLAN.md §2.2).
 */
export interface DeployBackend {
    createDeployment: (input: {
        adminToken: string;
        branch?: string;
        key: string;
        kind: DeployKind;
        organizationId: string;
        projectId: string; // secret-scanner:allow -- domain field name
        scriptName: string;
    }) => Promise<{ deploymentId: string }>;
    updateStatus: (input: {
        bundleHash?: string;
        deploymentId: string;
        key: string;
        status: "failed" | "live" | "provisioning";
        url?: string;
    }) => Promise<void>;
    verifyKey: (key: string) => Promise<DeployTarget | null>;
}

export interface DeployHandlerDeps {
    backend: DeployBackend;
    /** Cell hosting this deployment (§2.5). */
    cell: string;
    /** Map a deployment kind to the dispatch namespace it deploys into. */
    dispatchNamespace: (kind: DeployKind) => string;
    provisioner: Provisioner;
    scheduler: CellScheduler;
}

interface DeployBody {
    branch?: string;
    kind?: DeployKind;
    projectId?: string;
    scriptName?: string;
}

const json = (status: number, data: unknown): Response => Response.json(data, { headers: { "content-type": "application/json" }, status });

const bearerKey = (request: Request): null | string => {
    const header = request.headers.get("authorization") ?? "";
    const [scheme, ...rest] = header.split(" ");

    if (scheme?.toLowerCase() !== "bearer") {
        return null;
    }

    const key = rest.join(" ").trim();

    return key === "" ? null : key;
};

export const handleDeployRequest = async (request: Request, deps: DeployHandlerDeps): Promise<Response> => {
    const key = bearerKey(request);

    if (!key) {
        return json(401, { error: "missing bearer deploy key" });
    }

    const target = await deps.backend.verifyKey(key);

    if (!target) {
        return json(403, { error: "invalid or revoked deploy key" });
    }

    let body: DeployBody;

    try {
        body = await request.json();
    } catch {
        return json(400, { error: "invalid JSON body" });
    }

    if (!body.projectId || !body.scriptName) {
        return json(400, { error: "projectId and scriptName are required" });
    }

    const kind = body.kind ?? target.type;
    const { branch, projectId, scriptName } = body;

    // The platform-minted tenant admin token: recorded on the deployment (for the
    // admin proxy) and set as the worker's CIRRUS_ADMIN_TOKEN secret.
    const adminToken = randomSecret();

    let deploymentId: string;

    try {
        ({ deploymentId } = await deps.backend.createDeployment({
            adminToken,
            branch,
            key,
            kind,
            organizationId: target.organizationId,
            projectId,
            scriptName,
        }));
    } catch (error) {
        return json(403, { error: error instanceof Error ? error.message : "failed to record deployment" });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const write = (line: Record<string, unknown>): void => {
                controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
            };

            write({ deploymentId, event: "accepted" });

            const spec: TenantDeploymentSpec = {
                bindings: {},
                bundle: new ArrayBuffer(0),
                cell: deps.cell,
                dispatchNamespace: deps.dispatchNamespace(kind),
                scriptName,
                secrets: { CIRRUS_ADMIN_TOKEN: adminToken },
                tags: [`org:${target.organizationId}`, `project:${projectId}`, `env:${kind}`],
            };

            const outcome = await runDeployment(spec, {
                onProgress: async (progress: DeployProgress) => {
                    write({ ...progress, deploymentId });

                    if (progress.phase === "provisioning" || progress.phase === "live" || progress.phase === "failed") {
                        await deps.backend.updateStatus({ bundleHash: progress.bundleHash, deploymentId, key, status: progress.phase, url: progress.url });
                    }
                },
                provisioner: deps.provisioner,
                scheduler: deps.scheduler,
            });

            write({ deploymentId, done: true, status: outcome.status });
            controller.close();
        },
    });

    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "x-accel-buffering": "no" }, status: 200 });
};
