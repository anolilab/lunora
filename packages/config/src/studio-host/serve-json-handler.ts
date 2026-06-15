/**
 * Shared `node:http` transport glue for the local-dev studio endpoints (schema
 * edit, policy scaffold). Both dev hosts — the `@lunora/vite` `/__lunora`
 * middleware and the `lunora dev` studio server — route their local endpoints
 * through {@link serveJsonHandler} so the "read body → parse JSON → call the
 * transport-agnostic handler → respond" adapter lives in exactly one place
 * instead of being copy-pasted into each host (and drifting per endpoint).
 *
 * The handlers themselves ({@link ./schema-edit-handler}, {@link
 * ./policy-scaffold-handler}) stay transport-agnostic: they take a plain
 * {@link LocalEndpointRequest} and return a {@link LocalEndpointResponse}; this
 * file is the only part that touches `node:http`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** Max request body the local-dev endpoints accept (1 MB) — guards dev against a runaway upload. */
const MAX_BODY_BYTES = 1_000_000;

/** A request adapted from a host transport, passed to a local-dev handler. */
interface LocalEndpointRequest {
    /** Parsed JSON body of the request (`undefined` for `GET` / an empty body). */
    readonly body?: unknown;
    /** HTTP method. */
    readonly method: string;
    /** Project root containing the `lunora/` directory. */
    readonly projectRoot: string;
    /** Override the lunora subdirectory name. Defaults to `"lunora"`. */
    readonly schemaDirectory?: string;
}

/** A response a local-dev handler returns, serialised back as JSON with its status. */
interface LocalEndpointResponse {
    readonly body: unknown;
    readonly status: number;
}

/** A transport-agnostic local-dev handler (schema edit, policy scaffold). */
type LocalEndpointHandler = (request: LocalEndpointRequest) => LocalEndpointResponse;

/** Read a request body to a string, rejecting once it exceeds {@link MAX_BODY_BYTES}. */
const readBody = async (request: IncomingMessage): Promise<string> =>
    await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;

        request.on("data", (chunk: Buffer) => {
            size += chunk.length;

            if (size > MAX_BODY_BYTES) {
                reject(new Error("request body too large"));

                return;
            }

            chunks.push(chunk);
        });
        request.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
        request.on("error", reject);
    });

/** Write a JSON response with the given status. */
const respondJson = (response: ServerResponse, status: number, body: unknown): void => {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
};

/**
 * Adapt a `node:http` request/response pair to a transport-agnostic local-dev
 * handler. `GET` carries no body (the schema editor uses it to read the parsed
 * schema); every other method has its body read + JSON-parsed first. The
 * handler's `{ status, body }` is serialised back as JSON. A malformed body is a
 * `400`; an unexpected throw (e.g. the body-size guard) is a `500`.
 */
const serveJsonHandler = (request: IncomingMessage, response: ServerResponse, handle: LocalEndpointHandler, projectRoot: string): void => {
    const run = async (): Promise<void> => {
        try {
            const raw = request.method === "GET" ? "" : await readBody(request);
            let parsed: unknown;

            try {
                parsed = raw === "" ? undefined : JSON.parse(raw);
            } catch {
                respondJson(response, 400, { error: "invalid-json", ok: false });

                return;
            }

            const result = handle({ body: parsed, method: request.method ?? "POST", projectRoot });

            respondJson(response, result.status, result.body);
        } catch (error: unknown) {
            respondJson(response, 500, { error: error instanceof Error ? error.message : String(error), ok: false });
        }
    };

    run().catch(() => {
        // `run` already responds on every error path; this guards against an
        // unexpected throw so the promise never floats unhandled.
    });
};

export type { LocalEndpointHandler, LocalEndpointRequest, LocalEndpointResponse };
export { serveJsonHandler };
