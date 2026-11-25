/**
 * A local HTTP stand-in for a payment provider's API, for end-to-end tests of a provider adapter.
 *
 * The provider's real SDK is constructed against {@link FakeProvider.url}, so every call the adapter
 * makes crosses an actual socket: the SDK's request building, its response parsing and its error
 * mapping all run for real. Only the provider side is fake. A request with no matching route is
 * answered 404 and still recorded, so a test can assert that nothing unexpected was sent.
 */
import { createHmac } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

interface RecordedRequest {
    readonly body: string;
    readonly headers: IncomingHttpHeaders;
    readonly method: string;
    readonly path: string;
    readonly search: string;
}

interface RouteReply {
    readonly body?: unknown;
    readonly status?: number;
}

type Route = (request: RecordedRequest) => RouteReply | Promise<RouteReply>;

interface FakeProvider {
    /** Forget recorded requests; routes stay. */
    clear: () => void;
    close: () => Promise<void>;
    /** Every request received, in order, including ones no route matched. */
    readonly requests: RecordedRequest[];
    /** Answer `method` requests to `path` (an exact pathname) with what `route` returns. */
    route: (method: string, path: string, route: Route) => void;
    /** Base URL to hand to the provider SDK, with no trailing slash. */
    readonly url: string;
}

const readBody = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString("utf8");
};

const send = (response: ServerResponse, reply: RouteReply): void => {
    const status = reply.status ?? 200;
    const payload = reply.body === undefined ? "" : JSON.stringify(reply.body);

    response.writeHead(status, { "content-type": "application/json" });
    response.end(payload);
};

/** Start a fake provider on an ephemeral loopback port. */
const startFakeProvider = async (): Promise<FakeProvider> => {
    const routes = new Map<string, Route>();
    const requests: RecordedRequest[] = [];

    const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        // A placeholder base, only so the request path can be parsed; no request is ever sent to it.
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- parse-only placeholder base, never fetched
        const url = new URL(request.url ?? "/", "http://fake.provider");
        const recorded: RecordedRequest = {
            body: await readBody(request),
            headers: request.headers,
            method: request.method ?? "GET",
            path: url.pathname,
            search: url.search,
        };

        requests.push(recorded);

        const route = routes.get(`${recorded.method} ${recorded.path}`);

        send(response, route ? await route(recorded) : { body: { error: "no fake route", path: recorded.path }, status: 404 });
    };

    const server = createServer((request, response) => {
        handle(request, response).catch((error: unknown) => {
            send(response, { body: { error: String(error) }, status: 500 });
        });
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve();
        });
    });

    const { port } = server.address() as AddressInfo;

    return {
        clear: () => {
            requests.length = 0;
        },
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    error ? reject(error) : resolve();
                });
            });
        },
        requests,
        route: (method, path, route) => {
            routes.set(`${method} ${path}`, route);
        },
        // The fake is bound to loopback only, so the request never leaves the machine and TLS would add nothing.

        url: `http://127.0.0.1:${String(port)}`,
    };
};

/** Lowercase hex HMAC-SHA256 of `payload` under `secret`: the scheme Creem signs its webhooks with. */
const hmacSha256Hex = (secret: string, payload: string): string => createHmac("sha256", secret).update(payload).digest("hex");

/** A `Request` as the provider would deliver it: the raw body plus the headers the adapter reads. */
const webhookRequest = (body: string, headers: Record<string, string>): Request =>
    new Request("https://app.example.com/billing/webhook", { body, headers, method: "POST" });

export type { FakeProvider, RecordedRequest, Route, RouteReply };
export { hmacSha256Hex, startFakeProvider, webhookRequest };
