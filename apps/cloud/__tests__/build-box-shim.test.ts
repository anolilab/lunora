import { describe, expect, it, vi } from "vitest";

import { MAX_QUEUE_BODY_BYTES, wrapEntry } from "../containers/build/shim-runtime.mjs";

/**
 * The plain-Worker entry shim's runtime (`containers/build/shim-runtime.mjs`),
 * which the build box bundles into every `runtime: "worker"` build so the
 * platform's cron and queue fan-out (`POST /_lunora/scheduled`, `POST
 * /_lunora/queue`) reaches a Worker that serves neither route itself. Its
 * contract is `@lunora/runtime`'s `tenant-fanout-routes.ts`; these tests pin
 * the auth gate, both routes, Cloudflare's ack/retry semantics and the
 * passthrough, for both shapes a module Worker's default export takes.
 */

const TOKEN = "admin-token-for-tests";
const ENV = { LUNORA_ADMIN_TOKEN: TOKEN };
const CONTEXT = { passThroughOnException: () => {}, waitUntil: () => {} };

type Wrapped = Record<string, (...args: unknown[]) => unknown>;

/** `authorization: null` sends no header at all (`undefined` would take the default). */
const post = (path: string, body: unknown, authorization: null | string = `Bearer ${TOKEN}`): Request =>
    new Request(`https://tenant.internal${path}`, {
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { "content-type": "application/json", ...(authorization === null ? {} : { authorization }) },
        method: "POST",
    });

const call = async (wrapped: unknown, request: Request, env: unknown = ENV): Promise<Response> =>
    (wrapped as Wrapped).fetch(request, env, CONTEXT) as Promise<Response>;

/** A Worker whose `queue()` runs `onBatch`, recording every batch it saw. */
const queueWorker = (onBatch: (batch: Record<string, unknown> & { messages: Record<string, () => void>[] }) => void) => {
    const batches: unknown[] = [];

    return {
        batches,
        handler: {
            fetch: () => new Response("tenant"),
            async queue(batch: Record<string, unknown> & { messages: Record<string, () => void>[] }) {
                batches.push(batch);
                onBatch(batch);
            },
        },
    };
};

const forward = (ids: string[], queue = "acme--job-queue") =>
    post("/_lunora/queue", {
        messages: ids.map((id) => {
            return { body: { id }, id };
        }),
        queue,
    });

describe("plain-Worker entry shim", () => {
    describe("auth", () => {
        it.each([
            ["no authorization header", null, ENV],
            ["a wrong token", "Bearer nope", ENV],
            ["another scheme", `Basic ${TOKEN}`, ENV],
            ["no token on the deployment", `Bearer ${TOKEN}`, {}],
            ["an empty token on the deployment", "Bearer ", { LUNORA_ADMIN_TOKEN: "" }],
        ])("refuses %s with the runtime's 403, before running anything", async (_label, authorization, env) => {
            expect.assertions(3);

            const scheduled = vi.fn<(...args: unknown[]) => void>();
            const wrapped = wrapEntry({ fetch: () => new Response("tenant"), scheduled }, {});
            const response = await call(wrapped, post("/_lunora/scheduled", { cron: "* * * * *" }, authorization), env);

            expect(response.status).toBe(403);
            await expect(response.json()).resolves.toStrictEqual({
                error: { code: "ADMIN_FORBIDDEN", message: "admin endpoint requires a valid admin bearer" },
            });
            expect(scheduled).not.toHaveBeenCalled();
        });

        it("checks the bearer before the method, as the runtime does", async () => {
            expect.assertions(2);

            const wrapped = wrapEntry({ fetch: () => new Response("tenant"), scheduled: vi.fn<(...args: unknown[]) => void>() }, {});
            const anonymous = await call(wrapped, new Request("https://tenant.internal/_lunora/scheduled"));
            const admin = await call(wrapped, new Request("https://tenant.internal/_lunora/scheduled", { headers: { authorization: `Bearer ${TOKEN}` } }));

            expect(anonymous.status).toBe(403);
            expect(admin.status).toBe(405);
        });
    });

    describe("pOST /_lunora/scheduled", () => {
        it("runs the Worker's scheduled() with a controller, its env and its context", async () => {
            expect.assertions(4);

            const scheduled = vi.fn<(...args: unknown[]) => void>();
            const handler = { fetch: () => new Response("tenant"), scheduled };
            const wrapped = wrapEntry(handler, {});
            const response = await call(wrapped, post("/_lunora/scheduled", { cron: "*/5 * * * *" }));

            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toStrictEqual({ cron: "*/5 * * * *", ok: true });
            expect(scheduled).toHaveBeenCalledWith(
                expect.objectContaining({ cron: "*/5 * * * *", noRetry: expect.any(Function), scheduledTime: expect.any(Number) }),
                ENV,
                CONTEXT,
            );
            // Called on the Worker's own object, never on the wrapper.
            expect(scheduled.mock.contexts[0]).toBe(handler);
        });

        it("calls scheduled() on the Worker's own object, so `this` still reaches its methods", async () => {
            expect.assertions(1);

            const handler = {
                fetch: () => new Response("tenant"),
                ran: [] as string[],
                async scheduled(controller: { cron: string }) {
                    this.record(controller.cron);
                },
                record(cron: string) {
                    this.ran.push(cron);
                },
            };

            await call(wrapEntry(handler, {}), post("/_lunora/scheduled", { cron: "0 * * * *" }));

            expect(handler.ran).toStrictEqual(["0 * * * *"]);
        });

        it.each([
            ["no cron", {}, 400, "scheduled tick requires a `cron` expression"],
            ["a non-string cron", { cron: 5 }, 400, "scheduled tick requires a `cron` expression"],
            ["a body that is not JSON", "{nope", 400, "Scheduled tick body must be valid JSON"],
        ])("answers %s with a 400", async (_label, body, status, message) => {
            expect.assertions(1);

            const response = await call(
                wrapEntry({ fetch: () => new Response(""), scheduled: vi.fn<(...args: unknown[]) => void>() }, {}),
                post("/_lunora/scheduled", body),
            );

            await expect(response.json().then((json) => [response.status, json])).resolves.toStrictEqual([status, { error: { code: "BAD_REQUEST", message } }]);
        });

        it("refuses a tick for a Worker with no scheduled() handler", async () => {
            expect.assertions(1);

            const response = await call(wrapEntry({ fetch: () => new Response("") }, {}), post("/_lunora/scheduled", { cron: "* * * * *" }));

            await expect(response.json()).resolves.toStrictEqual({ error: { code: "BAD_REQUEST", message: "this Worker exports no scheduled() handler" } });
        });

        it("answers a scheduled() that throws with the runtime's redacted 500, so the fan-out counts it failed", async () => {
            expect.assertions(2);

            const errors = vi.spyOn(console, "error").mockImplementation(() => {});
            const response = await call(
                wrapEntry(
                    {
                        fetch: () => new Response(""),
                        scheduled: () => {
                            throw new Error("db down");
                        },
                    },
                    {},
                ),
                post("/_lunora/scheduled", { cron: "* * * * *" }),
            );
            const logged = errors.mock.calls.length;

            errors.mockRestore();

            await expect(response.json().then((json) => [response.status, json])).resolves.toStrictEqual([
                500,
                { error: { code: "INTERNAL", message: "Internal error" } },
            ]);
            expect(logged).toBe(1);
        });
    });

    describe("pOST /_lunora/queue", () => {
        it("retries exactly the messages the Worker retried, and acknowledges the rest", async () => {
            expect.assertions(1);

            const { handler } = queueWorker((batch) => {
                batch.messages[0]["retry"]();
                batch.messages[1]["ack"]();
            });
            const response = await call(wrapEntry(handler, {}), forward(["a", "b", "c"]));

            await expect(response.json()).resolves.toStrictEqual({ retry: ["a"] });
        });

        it("applies retryAll() to every message without an explicit ack()", async () => {
            expect.assertions(1);

            const { handler } = queueWorker((batch) => {
                (batch["retryAll"] as () => void)();
                batch.messages[1]["ack"]();
            });
            const response = await call(wrapEntry(handler, {}), forward(["a", "b", "c"]));

            await expect(response.json()).resolves.toStrictEqual({ retry: ["a", "c"] });
        });

        it("lets an explicit retry() win over ackAll()", async () => {
            expect.assertions(1);

            const { handler } = queueWorker((batch) => {
                batch.messages[2]["retry"]();
                (batch["ackAll"] as () => void)();
            });
            const response = await call(wrapEntry(handler, {}), forward(["a", "b", "c"]));

            await expect(response.json()).resolves.toStrictEqual({ retry: ["c"] });
        });

        it("retries everything not explicitly acknowledged when the Worker throws", async () => {
            expect.assertions(1);

            const { handler } = queueWorker((batch) => {
                batch.messages[0]["ack"]();
                batch.messages[1]["retry"]();

                throw new Error("handler failed");
            });
            const response = await call(wrapEntry(handler, {}), forward(["a", "b", "c"]));

            await expect(response.json()).resolves.toStrictEqual({ retry: ["b", "c"] });
        });

        it("hands the Worker a MessageBatch under its own queue name, with its env and context", async () => {
            expect.assertions(3);

            const queue = vi.fn<(...args: unknown[]) => void>();
            const wrapped = wrapEntry({ fetch: () => new Response(""), queue }, { "--job-queue": "jobs" });

            await call(wrapped, forward(["a"], "acme-pr-feat-x--job-queue"));
            await call(wrapped, forward(["b"], "acme--other"));

            expect(queue.mock.calls[0]).toStrictEqual([
                expect.objectContaining({
                    messages: [expect.objectContaining({ attempts: 1, body: { id: "a" }, id: "a", timestamp: expect.any(Date) })],
                    queue: "jobs",
                }),
                ENV,
                CONTEXT,
            ]);
            // A queue the map does not know keeps the name it was forwarded under.
            expect((queue.mock.calls[1]?.[0] as { queue: string }).queue).toBe("acme--other");
            expect(Object.isFrozen(queue.mock.calls[0]?.[0])).toBe(true);
        });

        it("drops forwarded entries without a string id, as the runtime does", async () => {
            expect.assertions(1);

            const queue = vi.fn<(...args: unknown[]) => void>();

            await call(
                wrapEntry({ fetch: () => new Response(""), queue }, {}),
                post("/_lunora/queue", { messages: [{ body: 1 }, { body: 2, id: "x" }, null], queue: "q" }),
            );

            expect((queue.mock.calls[0]?.[0] as { messages: { id: string }[] }).messages.map((message) => message.id)).toStrictEqual(["x"]);
        });

        it.each([
            ["no body", ""],
            ["a body without messages", { queue: "q" }],
            ["messages that are not an array", { messages: {}, queue: "q" }],
            ["a JSON null", "null"],
        ])("400s %s rather than acknowledge — and lose — the batch", async (_label, body) => {
            expect.assertions(2);

            const queue = vi.fn<(...args: unknown[]) => void>();
            const response = await call(wrapEntry({ fetch: () => new Response(""), queue }, {}), post("/_lunora/queue", body));

            expect(response.status).toBe(400);
            expect(queue).not.toHaveBeenCalled();
        });

        it("refuses a batch for a Worker with no queue() handler", async () => {
            expect.assertions(2);

            const response = await call(wrapEntry({ fetch: () => new Response("") }, {}), forward(["a"]));

            expect(response.status).toBe(400);
            await expect(response.json()).resolves.toStrictEqual({ error: { code: "BAD_REQUEST", message: "this Worker exports no queue() handler" } });
        });

        it("413s a body over the runtime's queue cap", async () => {
            expect.assertions(2);

            const queue = vi.fn<(...args: unknown[]) => void>();
            const response = await call(wrapEntry({ fetch: () => new Response(""), queue }, {}), post("/_lunora/queue", "x".repeat(MAX_QUEUE_BODY_BYTES + 1)));

            expect(response.status).toBe(413);
            expect(queue).not.toHaveBeenCalled();
        });
    });

    describe("everything else", () => {
        it("passes every other request to the Worker's fetch(), on its own object", async () => {
            expect.assertions(3);

            const handler = {
                async fetch(request: Request, env: unknown, context: unknown) {
                    return new Response(`${this.prefix}${new URL(request.url).pathname}`, { headers: { seen: String(env === ENV && context === CONTEXT) } });
                },
                prefix: "tenant:",
            };
            const response = await call(wrapEntry(handler, {}), new Request("https://app.example/_lunora/rpc", { method: "POST" }));

            expect(response.status).toBe(200);
            await expect(response.text()).resolves.toBe("tenant:/_lunora/rpc");
            expect(response.headers.get("seen")).toBe("true");
        });

        it("keeps the Worker's other handlers, and adds none it lacks", async () => {
            expect.assertions(2);

            const email = vi.fn<(...args: unknown[]) => void>();
            const wrapped = wrapEntry({ email, fetch: () => new Response("") }, {}) as Wrapped;

            await wrapped.email?.("message", ENV, CONTEXT);

            expect(email).toHaveBeenCalledWith("message", ENV, CONTEXT);
            expect(Object.keys(wrapped).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["email", "fetch"]);
        });

        it("reads handlers off a prototype, as a framework app instance carries them", async () => {
            expect.assertions(1);

            const app = Object.create({ fetch: () => new Response("from the prototype") }) as Record<string, unknown>;
            const response = await call(wrapEntry(app, {}), new Request("https://app.example/"));

            await expect(response.text()).resolves.toBe("from the prototype");
        });

        it("refuses a service-worker script, which has no default export", () => {
            expect.assertions(1);

            expect(() => wrapEntry(undefined, {})).toThrow(/service-worker format is not supported/u);
        });
    });
});
