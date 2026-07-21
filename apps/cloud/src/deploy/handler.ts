import type { Provisioner, TenantBindingSpec, TenantDeploymentSpec } from "../provision";
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
 * control-plane mutations via the Lunora action context.
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
    // Swap the project's stable-URL pointer to this now-healthy deployment and
    // supersede the previous live release (GAPS.md A1). Omit to skip pointer
    // management (legacy single-script mode).
    activateDeployment?: (input: { deploymentId: string; key: string }) => Promise<void>;
    createDeployment: (input: {
        adminToken: string;
        branch?: string;
        /** The tenant's compiled cron expressions for the WfP cron fan-out (§2.4). */
        cronSpecs?: string[];
        key: string;
        kind: DeployKind;
        organizationId: string;
        projectId: string; // secret-scanner:allow -- domain field name
        scriptName: string;
    }) => Promise<{ deploymentId: string; scriptName?: string; version?: number }>;
    /** Decrypted tenant env secrets to inject into the deployed Worker (§7). Optional. */
    resolveSecrets?: (input: { key: string; kind: DeployKind; organizationId: string; projectId: string }) => Promise<Record<string, string>>; // secret-scanner:allow -- domain field name
    updateStatus: (input: {
        bundleHash?: string;
        deploymentId: string;
        key: string;
        status: "failed" | "live" | "provisioning" | "verifying";
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
    /** Probe the uploaded script's URL before release (GAPS.md A1); `false` fails the deployment without touching the active pointer. Omit to skip health gating. */
    healthCheck?: (url: string) => Promise<boolean>;
    provisioner: Provisioner;
    scheduler: CellScheduler;
}

interface DeployBody {
    /**
     * Per-tenant binding manifest (DO classes / D1 / R2), as declared by the
     * deploy request — the CLI reads it from the app's `wrangler.jsonc`. The
     * canonical {@link TenantBindingSpec} shape; {@link normalizeBindings} floors
     * it to ShardDO before provisioning.
     */
    bindings?: TenantBindingSpec;
    branch?: string;
    /** The tenant's cron expressions (wrangler `triggers.crons`) for the fan-out (§2.4). */
    cronSpecs?: string[];
    /** Base64-encoded prebuilt worker module (the app's Vite build output — never built here). */
    bundle?: string;
    kind?: DeployKind;
    projectId?: string;
    scriptName?: string;
}

/**
 * Every Lunora tenant worker exports `ShardDO` (binding `SHARD`); without its
 * binding and the matching `new_sqlite_classes` migration tag the uploaded
 * dispatch script cannot boot (`putDispatchScript` omits the DO migration and
 * the worker's `ShardDO` export has nowhere to bind). This is the floor the
 * whole deploy path was missing — the spec was previously built with an empty
 * binding set, so a real tenant could never come up.
 */
const SHARD_DO_BINDING = { binding: "SHARD", className: "ShardDO" } as const;

/** Cap the declared DO classes so a malformed/abusive manifest can't balloon the upload metadata. */
const MAX_DURABLE_OBJECTS = 25;

const isBindingRef = (value: unknown): value is { binding: string } =>
    typeof value === "object" && value !== null && typeof (value as { binding?: unknown }).binding === "string";

/**
 * Resolve the request's binding manifest into the provisioner spec, guaranteeing
 * the ShardDO floor even when the caller under-declares (or omits `bindings`
 * entirely). Malformed entries are dropped rather than trusted, and the DO list
 * is capped.
 */
const normalizeBindings = (requested: TenantBindingSpec | undefined): TenantBindingSpec => {
    const declared = Array.isArray(requested?.durableObjects) ? requested.durableObjects : [];
    const durableObjects = declared
        .filter((entry): entry is { binding: string; className: string } => isBindingRef(entry) && typeof (entry as { className?: unknown }).className === "string")
        .slice(0, MAX_DURABLE_OBJECTS)
        .map((entry) => ({ binding: entry.binding, className: entry.className }));

    if (!durableObjects.some((entry) => entry.className === SHARD_DO_BINDING.className)) {
        durableObjects.unshift({ ...SHARD_DO_BINDING });
    }

    return {
        ...(isBindingRef(requested?.d1) ? { d1: { binding: requested.d1.binding } } : {}),
        ...(isBindingRef(requested?.r2) ? { r2: { binding: requested.r2.binding } } : {}),
        durableObjects,
    };
};

const json = (status: number, data: unknown): Response => Response.json(data, { headers: { "content-type": "application/json" }, status });

/** Decode the base64 bundle payload into the ArrayBuffer the provisioner uploads, or `null` if malformed. */
const decodeBundle = (encoded: string): ArrayBuffer | null => {
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

    // The worker bundle is prebuilt client-side (the app's Vite pipeline);
    // deploying without one would provision an empty module, so fail fast.
    if (!body.bundle) {
        return json(400, { error: "bundle is required (base64-encoded worker module)" });
    }

    const bundle = decodeBundle(body.bundle);

    if (!bundle) {
        return json(400, { error: "bundle is not valid base64" });
    }

    const kind = body.kind ?? target.type;
    const { branch, projectId, scriptName } = body;
    // Tenant cron expressions to fan out (§2.4). Defensive: only strings, capped.
    const cronSpecs = Array.isArray(body.cronSpecs) ? body.cronSpecs.filter((cron): cron is string => typeof cron === "string").slice(0, 50) : undefined;

    // The platform-minted tenant admin token: recorded on the deployment (for the
    // admin proxy) and set as the worker's LUNORA_ADMIN_TOKEN secret.
    const adminToken = randomSecret();

    let deploymentId: string;
    // The backend mints a versioned, immutable script name per release
    // (`{alias}-v{n}`, GAPS.md A1); fall back to the requested name when the
    // backend doesn't version (legacy single-script mode).
    let releaseScriptName = scriptName;

    try {
        const created = await deps.backend.createDeployment({
            adminToken,
            branch,
            ...(cronSpecs && cronSpecs.length > 0 ? { cronSpecs } : {}),
            key,
            kind,
            organizationId: target.organizationId,
            projectId,
            scriptName,
        });

        deploymentId = created.deploymentId;
        releaseScriptName = created.scriptName ?? scriptName;
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

            // Tenant env secrets are decrypted and merged in; LUNORA_ADMIN_TOKEN
            // is platform-owned and always wins over a same-named tenant secret.
            // A decrypt failure (e.g. a corrupt secret or a rotated master key)
            // must surface as a failed deployment, not leave the row stuck in
            // `accepted` — so transition to `failed` and close the stream.
            let tenantSecrets: Record<string, string>;

            try {
                tenantSecrets = (await deps.backend.resolveSecrets?.({ key, kind, organizationId: target.organizationId, projectId })) ?? {};
            } catch (error) {
                const message = error instanceof Error ? error.message : "failed to resolve tenant secrets";

                write({ deploymentId, error: message, phase: "failed" });
                await deps.backend.updateStatus({ deploymentId, key, status: "failed" });
                write({ deploymentId, done: true, status: "failed" });
                controller.close();

                return;
            }

            const spec: TenantDeploymentSpec = {
                // The stable project label (pre-versioning) keys per-tenant D1/R2,
                // so data persists across deploys; the versioned releaseScriptName
                // is the immutable per-deployment worker script id.
                alias: scriptName,
                bindings: normalizeBindings(body.bindings),
                bundle,
                cell: deps.cell,
                dispatchNamespace: deps.dispatchNamespace(kind),
                scriptName: releaseScriptName,
                secrets: { ...tenantSecrets, LUNORA_ADMIN_TOKEN: adminToken },
                tags: [`org:${target.organizationId}`, `project:${projectId}`, `env:${kind}`],
            };

            const { healthCheck } = deps;
            const outcome = await runDeployment(spec, {
                onProgress: async (progress: DeployProgress) => {
                    write({ ...progress, deploymentId });

                    if (progress.phase === "provisioning" || progress.phase === "verifying" || progress.phase === "live" || progress.phase === "failed") {
                        await deps.backend.updateStatus({ bundleHash: progress.bundleHash, deploymentId, key, status: progress.phase, url: progress.url });
                    }
                },
                provisioner: deps.provisioner,
                scheduler: deps.scheduler,
                ...(healthCheck ? { verify: (result) => healthCheck(result.url) } : {}),
            });

            // Health-checked release: swap the project's stable-URL pointer to
            // this deployment and supersede the previous one (GAPS.md A1). An
            // activation failure downgrades the release to failed — the old
            // version keeps serving.
            if (outcome.status === "live" && deps.backend.activateDeployment) {
                try {
                    await deps.backend.activateDeployment({ deploymentId, key });
                    write({ deploymentId, event: "released" });
                } catch (error) {
                    const message = error instanceof Error ? error.message : "activation failed";

                    write({ deploymentId, error: message, phase: "failed" });
                    await deps.backend.updateStatus({ deploymentId, key, status: "failed" });
                    write({ deploymentId, done: true, status: "failed" });
                    controller.close();

                    return;
                }
            }

            write({ deploymentId, done: true, status: outcome.status });
            controller.close();
        },
    });

    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "x-accel-buffering": "no" }, status: 200 });
};
