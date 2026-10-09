/**
 * The runtime half of a plain Worker's entry shim (`runtime: "worker"`).
 *
 * NOT run by the build box. The box reads this file's text at start-up and
 * writes it beside the generated shim of every worker build, so it is bundled
 * INTO the tenant's Worker by `wrangler deploy --dry-run` (see `worker.mjs`).
 * Zero imports for that reason: whatever it imported would have to resolve from
 * a directory outside the tenant's tree.
 *
 * Why it exists. On `cloudflare-wfp` a Worker sits in a dispatch namespace,
 * where Cloudflare drops `triggers.crons` and a script cannot be a queue
 * consumer. The control plane delivers both over HTTP instead — `POST
 * /_lunora/scheduled` for a cron firing and `POST /_lunora/queue` for a batch
 * its own consumer drained — the contract `@lunora/runtime` serves in
 * `tenant-fanout-routes.ts`. A plain Worker serves neither, so without this its
 * crons would never fire and its queue messages would be acknowledged by the
 * platform consumer and lost. {@link wrapEntry} answers those two routes from
 * the Worker's own `scheduled()` and `queue()` handlers and hands every other
 * request to its `fetch()`.
 *
 * Mirrors the runtime's contract exactly: the same paths, the same admin bearer
 * (`env.LUNORA_ADMIN_TOKEN`, which the platform sets on every deployment)
 * compared in constant time and checked before anything else, the same body
 * caps, the same request and response shapes and error envelope. One deliberate
 * difference, in the Worker's favour: a `queue()` that throws still keeps the
 * messages it acknowledged explicitly — Cloudflare's own consumer semantics —
 * where the runtime's route answers a throw with a 500 that retries the batch.
 */

/** `SCHEDULED_TICK_PATH` in `@lunora/runtime`'s `tenant-fanout-routes.ts`. */
const SCHEDULED_PATH = "/_lunora/scheduled";

/** `QUEUE_DISPATCH_PATH` in the same file. */
const QUEUE_PATH = "/_lunora/queue";

/** `MAX_BODY_BYTES` in `@lunora/runtime`'s `body-readers.ts` — the cap the scheduled tick reads under. */
const MAX_SCHEDULED_BODY_BYTES = 1_048_576;

/** The queue route's own cap in `tenant-fanout-routes.ts`. */
const MAX_QUEUE_BODY_BYTES = 16 * 1_048_576;

/** Handlers a module Worker's default export may carry besides `fetch`, delegated as they are. */
const DELEGATED_HANDLERS = ["email", "queue", "scheduled", "tail", "tailStream", "test", "trace"];

/**
 * `shared/constant-time-equal.ts`, copied: this file is bundled into a tenant
 * Worker and can import nothing. Folds the length difference and every code
 * unit into one accumulator, so neither length nor match progress leaks.
 * @param {string} a One string.
 * @param {string} b The other.
 * @returns {boolean} Whether they are equal.
 */
const constantTimeEqual = (a, b) => {
    const max = Math.max(a.length, b.length);
    // eslint-disable-next-line no-bitwise -- constant-time compare folds length + every code-unit delta into one accumulator
    let diff = a.length ^ b.length;

    for (let index = 0; index < max; index += 1) {
        // eslint-disable-next-line unicorn/prefer-code-point -- per UTF-16 code unit, so timing is independent of surrogate boundaries
        const charA = index < a.length ? a.charCodeAt(index) : 0;
        // eslint-disable-next-line unicorn/prefer-code-point -- see above
        const charB = index < b.length ? b.charCodeAt(index) : 0;

        // eslint-disable-next-line no-bitwise -- accumulate without branching
        diff |= charA ^ charB;
    }

    return diff === 0;
};

/**
 * Whether the request carries the deployment's admin bearer — `checkAdminAuth`
 * in `@lunora/runtime`'s `create-worker.ts`. An unset token admits nobody.
 * @param {Request} request The incoming request.
 * @param {unknown} env The Worker's bindings.
 * @returns {boolean} Whether it is authorized.
 */
const isAdmin = (request, env) => {
    const expected = typeof env === "object" && env !== null ? /** @type {Record<string, unknown>} */ (env).LUNORA_ADMIN_TOKEN : undefined;

    if (typeof expected !== "string" || expected === "") {
        return false;
    }

    const authorization = request.headers.get("authorization");

    if (!authorization) {
        return false;
    }

    const [scheme, ...rest] = authorization.split(" ");

    return scheme?.toLowerCase() === "bearer" && constantTimeEqual(expected, rest.join(" ").trim());
};

/**
 * A refusal in the runtime's error envelope (`{ error: { code, message } }`).
 * @param {number} status HTTP status.
 * @param {string} code The runtime's error code.
 * @param {string} message What went wrong.
 * @returns {Response} The answer.
 */
const refusal = (status, code, message) => Response.json({ error: { code, message } }, { status });

/**
 * Read a body's text under a byte cap, as the bytes arrive —
 * `readBodyTextWithLimit` in `@lunora/runtime`. `Content-Length` is forgeable,
 * so the cap is enforced on the stream.
 * @param {Request} request The incoming request.
 * @param {number} limit The byte cap.
 * @returns {Promise<string | undefined>} The text, or `undefined` past the cap.
 */
const readText = async (request, limit) => {
    if (!request.body) {
        return "";
    }

    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = "";

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- a stream is read in order
        const { done, value } = await reader.read();

        if (done) {
            return text + decoder.decode();
        }

        total += value.byteLength;

        if (total > limit) {
            // eslint-disable-next-line no-await-in-loop -- one-shot cleanup before refusing
            await reader.cancel().catch(() => {});

            return undefined;
        }

        text += decoder.decode(value, { stream: true });
    }
};

/**
 * Read a JSON body under a byte cap — `readLooseJsonBody` in `@lunora/runtime`.
 * An empty body is `{}`.
 * @param {Request} request The incoming request.
 * @param {string} label How the error names the body.
 * @param {number} limit The byte cap.
 * @returns {Promise<{ refused: Response } | { value: unknown }>} The parsed body, or the refusal.
 */
const readJson = async (request, label, limit) => {
    const text = await readText(request, limit);

    if (text === undefined) {
        return { refused: refusal(413, "PAYLOAD_TOO_LARGE", "Body too large") };
    }

    try {
        return { value: text === "" ? {} : JSON.parse(text) };
    } catch {
        return { refused: refusal(400, "BAD_REQUEST", `${label} body must be valid JSON`) };
    }
};

/**
 * The Worker's own name for a queue the platform forwards. The platform's
 * consumer drains the per-project queue `{alias}--{producer binding}` and
 * forwards THAT name, so a Worker that branches on `batch.queue` would match
 * none of its own names; this maps it back through the producer binding. An
 * alias never contains `--`, so the suffix after the first one is the binding.
 * @param {string} name The forwarded queue name.
 * @param {Readonly<Record<string, string>>} queueNames `--<binding>` → the Worker's queue name.
 * @returns {string} The Worker's queue name, or `name` when none matches.
 */
const tenantQueueName = (name, queueNames) => {
    const separator = name.indexOf("--");
    const suffix = separator === -1 ? "" : name.slice(separator);

    return Object.hasOwn(queueNames, suffix) ? queueNames[suffix] : name;
};

/**
 * Run a forwarded batch through the Worker's `queue()` handler and answer which
 * messages to retry, with Cloudflare's own consumer semantics: an explicit
 * `ack()` / `retry()` on a message wins over `ackAll()` / `retryAll()`, the
 * last call of each kind wins, a handler that returns acknowledges everything
 * it did not retry, and a handler that throws retries everything it did not
 * acknowledge explicitly.
 * @param {{ messages: ReadonlyArray<{ body: unknown, id: string }>, queue: string }} forwarded The batch as the platform sent it.
 * @param {(batch: unknown) => Promise<unknown>} invoke Calls the Worker's handler with the batch.
 * @returns {Promise<string[]>} The ids to retry.
 */
const runBatch = async (forwarded, invoke) => {
    /** @type {Map<string, "ack" | "retry">} */
    const explicit = new Map();
    /** @type {"ack" | "retry" | undefined} */
    let whole;
    const timestamp = new Date();
    const messages = forwarded.messages.map((message) =>
        Object.freeze({
            ack: () => {
                explicit.set(message.id, "ack");
            },
            attempts: 1,
            body: message.body,
            id: message.id,
            retry: () => {
                explicit.set(message.id, "retry");
            },
            timestamp,
        }),
    );
    const batch = Object.freeze({
        ackAll: () => {
            whole = "ack";
        },
        messages: Object.freeze(messages),
        queue: forwarded.queue,
        retryAll: () => {
            whole = "retry";
        },
    });

    try {
        await invoke(batch);
    } catch {
        return forwarded.messages.filter((message) => explicit.get(message.id) !== "ack").map((message) => message.id);
    }

    return forwarded.messages.filter((message) => (explicit.get(message.id) ?? whole) === "retry").map((message) => message.id);
};

/**
 * `POST /_lunora/scheduled`, past the auth gate: `{ "cron": "<expr>" }` →
 * `{ cron, ok: true }`, once the Worker's `scheduled()` has run.
 * @param {Request} request The incoming request.
 * @param {((controller: unknown) => Promise<unknown>) | undefined} scheduled The Worker's handler, bound.
 * @returns {Promise<Response>} The answer.
 */
const scheduledRoute = async (request, scheduled) => {
    if (request.method !== "POST") {
        return refusal(405, "METHOD_NOT_ALLOWED", "scheduled tick endpoint requires POST");
    }

    const body = await readJson(request, "Scheduled tick", MAX_SCHEDULED_BODY_BYTES);

    if ("refused" in body) {
        return body.refused;
    }

    const cron = typeof body.value?.cron === "string" ? body.value.cron : "";

    if (cron === "") {
        return refusal(400, "BAD_REQUEST", "scheduled tick requires a `cron` expression");
    }

    if (scheduled === undefined) {
        return refusal(400, "BAD_REQUEST", "this Worker exports no scheduled() handler");
    }

    await scheduled(Object.freeze({ cron, noRetry: () => {}, scheduledTime: Date.now(), type: "scheduled" }));

    return Response.json({ cron, ok: true });
};

/**
 * `POST /_lunora/queue`, past the auth gate: `{ "queue", "messages": [{ "id",
 * "body" }] }` → `{ "retry": [ids] }`.
 * @param {Request} request The incoming request.
 * @param {((batch: unknown) => Promise<unknown>) | undefined} queue The Worker's handler, bound.
 * @param {Readonly<Record<string, string>>} queueNames `--<binding>` → the Worker's queue name.
 * @returns {Promise<Response>} The answer.
 */
const queueRoute = async (request, queue, queueNames) => {
    if (request.method !== "POST") {
        return refusal(405, "METHOD_NOT_ALLOWED", "queue dispatch endpoint requires POST");
    }

    if (queue === undefined) {
        return refusal(400, "BAD_REQUEST", "this Worker exports no queue() handler");
    }

    const body = await readJson(request, "Queue dispatch", MAX_QUEUE_BODY_BYTES);

    if ("refused" in body) {
        return body.refused;
    }

    // A body this route could not read must never answer `{"retry": []}`,
    // which tells the platform consumer to acknowledge — and discard — the batch.
    if (!Array.isArray(body.value?.messages)) {
        return refusal(400, "BAD_REQUEST", "queue dispatch requires a `messages` array");
    }

    const messages = body.value.messages
        .filter((message) => typeof message === "object" && message !== null && typeof message.id === "string")
        .map((message) => {
            return { body: message.body, id: message.id };
        });
    const name = tenantQueueName(typeof body.value.queue === "string" ? body.value.queue : "", queueNames);

    return Response.json({ retry: await runBatch({ messages, queue: name }, queue) });
};

/**
 * Answer one of the two platform routes, or `undefined` for any other request.
 * The bearer is checked first, before the method or the body, as the runtime does.
 * @param {Request} request The incoming request.
 * @param {unknown} env The Worker's bindings.
 * @param {{ queue?: (batch: unknown) => Promise<unknown>, queueNames: Readonly<Record<string, string>>, scheduled?: (controller: unknown) => Promise<unknown> }} handlers The Worker's own handlers, bound.
 * @returns {Promise<Response | undefined>} The answer.
 */
const platformRoute = async (request, env, handlers) => {
    const { pathname } = new URL(request.url);

    if (pathname !== SCHEDULED_PATH && pathname !== QUEUE_PATH) {
        return undefined;
    }

    if (!isAdmin(request, env)) {
        return refusal(403, "ADMIN_FORBIDDEN", "admin endpoint requires a valid admin bearer");
    }

    try {
        return pathname === SCHEDULED_PATH ? await scheduledRoute(request, handlers.scheduled) : await queueRoute(request, handlers.queue, handlers.queueNames);
    } catch (error) {
        // Redacted in the answer, as the runtime does, and logged for the
        // Worker's own logs — a cron that throws is the Worker's failure.
        // eslint-disable-next-line no-console -- the Worker's log is the only place this failure can be read
        console.error(`[lunora-cloud] ${pathname === SCHEDULED_PATH ? "scheduled()" : "queue()"} failed:`, error);

        return refusal(500, "INTERNAL", "Internal error");
    }
};

/**
 * What a Worker with no `fetch()` answers an ordinary request.
 * @returns {Response} A 501.
 */
const noFetchHandler = () => new Response("This Worker exports no fetch() handler", { status: 501 });

/**
 * A module Worker's default export, wrapped. An object handler becomes an
 * object with the same handlers — each called on the ORIGINAL object, so `this`
 * and prototype methods (a Hono app, say) behave as before — and a
 * `WorkerEntrypoint` class becomes a subclass overriding `fetch`.
 * @param {unknown} handler The Worker's default export.
 * @param {Readonly<Record<string, string>>} queueNames `--<binding>` → the Worker's queue name.
 * @returns {unknown} The default export to deploy.
 */
const wrapEntry = (handler, queueNames) => {
    if (typeof handler === "function") {
        const Base = /** @type {new (...args: unknown[]) => Record<string, unknown>} */ (handler);

        return class LunoraCloudEntry extends Base {
            async fetch(request) {
                const answered = await platformRoute(request, this.env, {
                    queueNames,
                    ...(typeof this.queue === "function" ? { queue: (batch) => this.queue(batch) } : {}),
                    ...(typeof this.scheduled === "function" ? { scheduled: (controller) => this.scheduled(controller) } : {}),
                });

                if (answered !== undefined) {
                    return answered;
                }

                return typeof super.fetch === "function" ? super.fetch(request) : noFetchHandler();
            }
        };
    }

    if (typeof handler !== "object" || handler === null) {
        // A service-worker script (`addEventListener("fetch", …)`) has no
        // default export. Thrown at module load, so the upload fails saying so
        // instead of deploying a Worker that answers nothing.
        throw new TypeError(
            "Lunora Cloud deploys module Workers: this Worker's entry has no default export (service-worker format is not supported). Export a default handler object or WorkerEntrypoint class.",
        );
    }

    const target = /** @type {Record<string, unknown>} */ (handler);
    const call = (name, ...args) => /** @type {(...args: unknown[]) => unknown} */ (target[name]).apply(target, args);
    const wrapped = {};

    for (const name of DELEGATED_HANDLERS) {
        if (typeof target[name] === "function") {
            wrapped[name] = (...args) => call(name, ...args);
        }
    }

    wrapped.fetch = async (request, env, context) => {
        const answered = await platformRoute(request, env, {
            queueNames,
            ...(typeof target.queue === "function" ? { queue: async (batch) => call("queue", batch, env, context) } : {}),
            ...(typeof target.scheduled === "function" ? { scheduled: async (controller) => call("scheduled", controller, env, context) } : {}),
        });

        if (answered !== undefined) {
            return answered;
        }

        return typeof target.fetch === "function" ? call("fetch", request, env, context) : noFetchHandler();
    };

    return wrapped;
};

export { MAX_QUEUE_BODY_BYTES, QUEUE_PATH, SCHEDULED_PATH, wrapEntry };
