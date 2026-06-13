/**
 * Deploy client (CLOUD-PLAN.md §2.2 / Phase 1) — the core of `cirrus deploy`
 * against the managed cloud. POSTs to the deploy API with the deploy key and
 * consumes the NDJSON progress stream, invoking `onEvent` per line. Pure: the
 * `fetch` is injectable, so the streaming consumer is unit-testable.
 */

export type DeployEvent = Record<string, unknown>;

export interface DeployClientOptions {
    apiUrl: string;
    branch?: string;
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

export const deployToCloud = async (options: DeployClientOptions, onEvent: (event: DeployEvent) => void): Promise<DeployResult> => {
    const fetchImpl = options.fetch ?? globalThis.fetch;

    const response = await fetchImpl(`${stripTrailingSlashes(options.apiUrl)}/v1/deploy`, {
        body: JSON.stringify({ branch: options.branch, kind: options.kind, projectId: options.projectId, scriptName: options.scriptName }), // secret-scanner:allow -- domain field name
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
