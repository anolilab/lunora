/**
 * Deploy client (CLOUD-PLAN.md §2.2 / Phase 1) — the core of `lunora deploy`
 * against the managed cloud. POSTs to the deploy API with the deploy key and
 * consumes the NDJSON progress stream, invoking `onEvent` per line. Pure: the
 * `fetch` is injectable, so the streaming consumer is unit-testable.
 */

export type DeployEvent = Record<string, unknown>;

export interface DeployClientOptions {
    apiUrl: string;
    /**
     * The tenant's binding manifest, read from its `wrangler.jsonc` (DO classes,
     * and whether the app provisions a per-tenant D1 / R2). The server floors it
     * to ShardDO, so omitting it still yields a bootable single-DO worker.
     */
    bindings?: {
        d1?: { binding: string };
        durableObjects?: { binding: string; className: string }[];
        r2?: { binding: string };
    };
    branch?: string;
    /** Base64-encoded prebuilt worker module (the app's Vite build output). */
    bundle: string;
    deployKey: string;
    fetch?: typeof globalThis.fetch;
    kind?: "dev" | "preview" | "production";
    projectId: string; // secret-scanner:allow -- domain field name, not a Cypress projectId
    scriptName: string;
}

/** Final deploy outcome reported by the stream's terminal `done` event. */
export interface DeployResult {
    status: string;
}

const stripTrailingSlashes = (value: string): string => {
    let result = value;

    while (result.endsWith("/")) {
        result = result.slice(0, -1);
    }

    return result;
};

export interface RollbackClientOptions {
    apiUrl: string;
    deployKey: string;
    deploymentId: string;
    fetch?: typeof globalThis.fetch;
    organizationId: string;
}

/**
 * `POST /v1/deployments/rollback` — swap the project's stable URL back to a
 * retained release (GAPS.md A1). Returns the script that now serves the alias.
 */
export const rollbackDeployment = async (options: RollbackClientOptions): Promise<{ scriptName: string; version?: number }> => {
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

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Response.json() is `unknown` under workers-types; tsc requires the assertion
    return (await response.json()) as { scriptName: string; version?: number };
};

export const deployToCloud = async (options: DeployClientOptions, onEvent: (event: DeployEvent) => void): Promise<DeployResult> => {
    const fetchImpl = options.fetch ?? globalThis.fetch;

    const response = await fetchImpl(`${stripTrailingSlashes(options.apiUrl)}/v1/deploy`, {
        body: JSON.stringify({
            ...(options.bindings ? { bindings: options.bindings } : {}),
            branch: options.branch,
            bundle: options.bundle,
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
