import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import type { LocalEndpointHandler } from "../../src/studio-host/serve-json-handler";
import { serveJsonHandler } from "../../src/studio-host/serve-json-handler";

/** A minimal `IncomingMessage` carrying a method, headers, and an optional body. */
const makeRequest = (method: string, headers: Record<string, string>, body?: string): IncomingMessage => {
    const request = new EventEmitter() as IncomingMessage;

    request.method = method;
    request.headers = headers;

    // Emit the body on the next tick so listeners attach first.
    queueMicrotask(() => {
        if (body !== undefined && body !== "") {
            request.emit("data", Buffer.from(body, "utf8"));
        }

        request.emit("end");
    });

    return request;
};

/** A capturing `ServerResponse`; resolves once `end` is called. */
const makeResponse = (): { done: Promise<{ body: unknown; status: number }>; response: ServerResponse } => {
    let resolve!: (value: { body: unknown; status: number }) => void;
    const done = new Promise<{ body: unknown; status: number }>((r) => {
        resolve = r;
    });

    const response = {
        end: (payload?: string) => {
            resolve({ body: payload === undefined ? undefined : JSON.parse(payload), status: response.statusCode });
        },
        setHeader: () => {},
        statusCode: 200,
    } as unknown as ServerResponse;

    return { done, response };
};

const okHandler: LocalEndpointHandler = () => ({ body: { ok: true }, status: 200 });

const run = async (request: IncomingMessage): Promise<{ body: unknown; status: number }> => {
    const { done, response } = makeResponse();

    serveJsonHandler(request, response, okHandler, "/project");

    return await done;
};

describe("serveJsonHandler CSRF defense", () => {
    it("rejects a state-changing request with a non-json content-type", async () => {
        expect.assertions(1);

        const result = await run(makeRequest("POST", { "content-type": "text/plain" }, '{"kind":"addTable"}'));

        expect(result.status).toBe(403);
    });

    it("rejects a cross-origin request flagged by sec-fetch-site", async () => {
        expect.assertions(1);

        const result = await run(makeRequest("POST", { "content-type": "application/json", "sec-fetch-site": "cross-site" }, "{}"));

        expect(result.status).toBe(403);
    });

    it("rejects when the Origin host does not match the request Host", async () => {
        expect.assertions(1);

        const result = await run(makeRequest("POST", { "content-type": "application/json", host: "127.0.0.1:5173", origin: "http://evil.example" }, "{}"));

        expect(result.status).toBe(403);
    });

    it("allows a same-origin json POST", async () => {
        expect.assertions(1);

        const result = await run(
            makeRequest(
                "POST",
                { "content-type": "application/json", host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-origin" },
                "{}",
            ),
        );

        expect(result.status).toBe(200);
    });

    it("allows a GET (schema read) without a content-type", async () => {
        expect.assertions(1);

        const result = await run(makeRequest("GET", { "sec-fetch-site": "same-origin" }));

        expect(result.status).toBe(200);
    });
});
