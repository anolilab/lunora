/**
 * Managed-cloud deploy client for the `lunora cloud` command group. The one
 * `lunora` binary can ship to the managed platform (Lunora Cloud control plane,
 * `POST /v1/*`) as well as run the self-host wrangler flow. This is the thin
 * HTTP client for that control-plane API: POST the prebuilt bundle + manifest
 * with the org deploy key and consume the NDJSON progress stream; roll back a
 * release. Pure over an injected `fetch`, so it is unit-testable, and it shares
 * the wire contract with the control plane's own `apps/cloud` client.
 */

export type DeployEvent = Record<string, unknown>;

/** The tenant binding manifest a deploy carries (from the app's `wrangler.jsonc`). */
export interface DeployManifestBindings {
    d1?: { binding: string };
    durableObjects?: { binding: string; className: string }[];
    r2?: { binding: string };
}

export interface DeployToCloudOptions {
    apiUrl: string;
    bindings?: DeployManifestBindings;
    branch?: string;
    /** Base64-encoded prebuilt worker module (the app's Vite build output). */
    bundle: string;
    cronSpecs?: string[];
    deployKey: string;
    fetch?: typeof globalThis.fetch;
    kind?: "dev" | "preview" | "production";
    projectId: string; // secret-scanner:allow -- domain field name
    scriptName: string;
}

export interface DeployResult {
    status: string;
}

export interface RollbackOptions {
    apiUrl: string;
    deployKey: string;
    deploymentId: string;
    fetch?: typeof globalThis.fetch;
    organizationId: string;
}

const stripTrailingSlashes = (value: string): string => {
    let result = value;

    while (result.endsWith("/")) {
        result = result.slice(0, -1);
    }

    return result;
};

/** `POST /v1/deployments/rollback` — swap the project's stable URL to a retained release. */
export const rollbackDeployment = async (options: RollbackOptions): Promise<{ scriptName: string; version?: number }> => {
    const fetchImpl = options.fetch ?? globalThis.fetch;

    const response = await fetchImpl(`${stripTrailingSlashes(options.apiUrl)}/v1/deployments/rollback`, {
        body: JSON.stringify({ deploymentId: options.deploymentId, organizationId: options.organizationId }),
        headers: { authorization: `Bearer ${options.deployKey}`, "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => "");

        throw new Error(`rollback failed (${String(response.status)})${detail ? `: ${detail}` : ""}`);
    }

    return (await response.json()) as { scriptName: string; version?: number };
};

/** `POST /v1/deploy` — push a prebuilt bundle and stream NDJSON progress via `onEvent`. */
export const deployToCloud = async (options: DeployToCloudOptions, onEvent: (event: DeployEvent) => void): Promise<DeployResult> => {
    const fetchImpl = options.fetch ?? globalThis.fetch;

    const response = await fetchImpl(`${stripTrailingSlashes(options.apiUrl)}/v1/deploy`, {
        body: JSON.stringify({
            ...(options.bindings ? { bindings: options.bindings } : {}),
            branch: options.branch,
            bundle: options.bundle,
            ...(options.cronSpecs && options.cronSpecs.length > 0 ? { cronSpecs: options.cronSpecs } : {}),
            kind: options.kind,
            projectId: options.projectId, // secret-scanner:allow -- domain field name
            scriptName: options.scriptName,
        }), // secret-scanner:allow -- domain field name
        headers: { authorization: `Bearer ${options.deployKey}`, "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");

        throw new Error(`deploy request failed (${String(response.status)})${detail ? `: ${detail}` : ""}`);
    }

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let status = "unknown";

    const consume = (line: string): void => {
        const trimmed = line.trim();

        if (trimmed === "") {
            return;
        }

        const event = JSON.parse(trimmed) as DeployEvent;

        onEvent(event);

        if (event["done"] === true && typeof event["status"] === "string") {
            status = event["status"];
        }
    };

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- sequential stream reads
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf("\n");

        while (newline !== -1) {
            consume(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
        }
    }

    consume(buffer);

    return { status };
};

/** The subset of a parsed `wrangler.jsonc` the manifest reads — all optional/defensive. */
export interface WranglerConfig {
    d1_databases?: { binding?: unknown }[];
    durable_objects?: { bindings?: { class_name?: unknown; name?: unknown }[] };
    name?: unknown;
    r2_buckets?: { binding?: unknown }[];
    triggers?: { crons?: unknown[] };
}

export interface DeployManifest {
    bindings: DeployManifestBindings;
    cronSpecs: string[];
}

const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/**
 * Extract the deploy manifest (DO/D1/R2 bindings + cron expressions) from a
 * parsed `wrangler.jsonc`. Defensive — malformed entries are dropped. The server
 * floors bindings to ShardDO, so a partial manifest is safe.
 */
export const parseWranglerManifest = (wrangler: WranglerConfig): DeployManifest => {
    const durableObjects = (wrangler.durable_objects?.bindings ?? [])
        .map((entry) => ({ binding: asString(entry.name), className: asString(entry.class_name) }))
        .filter((entry): entry is { binding: string; className: string } => entry.binding !== undefined && entry.className !== undefined);

    const d1Binding = asString(wrangler.d1_databases?.[0]?.binding);
    const r2Binding = asString(wrangler.r2_buckets?.[0]?.binding);
    const cronSpecs = (wrangler.triggers?.crons ?? []).map(asString).filter((cron): cron is string => cron !== undefined);

    return {
        bindings: {
            ...(d1Binding ? { d1: { binding: d1Binding } } : {}),
            ...(r2Binding ? { r2: { binding: r2Binding } } : {}),
            ...(durableObjects.length > 0 ? { durableObjects } : {}),
        },
        cronSpecs,
    };
};
