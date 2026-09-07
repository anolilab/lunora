import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import type { LocalEndpointHandler } from "../../src/studio-host/serve-json-handler";
import { serveJsonHandler } from "../../src/studio-host/serve-json-handler";

/** A minimal `IncomingMessage` carrying a method, headers, and an optional body. */
const makeRequest = (method: string, headers: Record<string, string>, body?: string): IncomingMessage => {
    // `IncomingMessage` IS a Node stream (an EventEmitter); the handler consumes it
    // via `.on("data"/"end"/"error")`, so the mock must mirror that surface — an
    // `EventTarget` would not satisfy the type or the data/end event protocol.
    // eslint-disable-next-line unicorn/prefer-event-target -- mocking Node's IncomingMessage stream API
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
    // eslint-disable-next-line promise/param-names -- captured to settle from the response.end callback below
    const done = new Promise<{ body: unknown; status: number }>((resolveFn) => {
        resolve = resolveFn;
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

const okHandler: LocalEndpointHandler = () => {
    return { body: { ok: true }, status: 200 };
};

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

    it("forwards projectRoot and the host's schemaDirectory + apiSpec to the handler", async () => {
        expect.assertions(3);

        let seen: { apiSpec?: string; projectRoot: string; schemaDirectory?: string } | undefined;
        const capturingHandler: LocalEndpointHandler = (request) => {
            seen = { apiSpec: request.apiSpec, projectRoot: request.projectRoot, schemaDirectory: request.schemaDirectory };

            return { body: { ok: true }, status: 200 };
        };

        const { done, response } = makeResponse();

        serveJsonHandler(makeRequest("GET", { "sec-fetch-site": "same-origin" }), response, capturingHandler, "/project", {
            apiSpec: "openrpc",
            schemaDirectory: "custom-schema-dir",
        });

        await done;

        expect(seen?.projectRoot).toBe("/project");
        expect(seen?.schemaDirectory).toBe("custom-schema-dir");
        expect(seen?.apiSpec).toBe("openrpc");
    });
});
