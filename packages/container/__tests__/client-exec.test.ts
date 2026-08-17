import { describe, expect, it } from "vitest";

import type { ContainerNamespaceLike } from "../src/index";
import { createContainerContext, createContainerTestContext } from "../src/index";

const SPEC = [{ binding: "CONTAINER_RUNNER", exportName: "runner" }];

/**
 * A fake DO namespace whose container answers `respond`, recording every request
 * it was sent so the exec wire format can be asserted rather than assumed.
 */
const execNamespace = (respond: (request: Request) => Response | Promise<Response>): { namespace: ContainerNamespaceLike; requests: Request[] } => {
    const requests: Request[] = [];

    return {
        namespace: {
            get: () => {
                return {
                    fetch: async (request: Request) => {
                        requests.push(request.clone() as Request);

                        return respond(request);
                    },
                };
            },
            idFromName: (name: string) => name,
        },
        requests,
    };
};

const jsonResponse = (body: unknown, status = 200): Response => Response.json(body, { status });

/**
 * A container handler that models a slow container: it answers only after
 * `answerAfterMs`, and rejects early if the request is aborted first.
 *
 * Two details are load-bearing, both learned the hard way.
 *
 * The `signal.aborted` check comes first because an abort that has ALREADY
 * fired when the handler runs dispatches no `abort` event — listening alone
 * would leave the promise pending forever.
 *
 * The pending `answerAfterMs` timer is not decoration. A handler that merely
 * awaits an abort leaves the Vitest worker's event loop with the deadline timer
 * as its only pending work, and in that state the timer is sometimes never
 * delivered: the `timeoutMs` test hung for its full budget in 3 runs out of 10,
 * unchanged at a 20s budget, while passing every time in isolation or with any
 * other timer pending. Modelling the container as slow-but-answering keeps the
 * loop alive and makes the deadline deterministic — and is a fairer model of a
 * real container anyway, which does eventually reply.
 */
const slowContainer =
    (answerAfterMs: number) =>
    async (request: Request): Promise<Response> =>
        new Promise<Response>((resolve, reject) => {
            if (request.signal.aborted) {
                reject(request.signal.reason as Error);

                return;
            }

            const timer = setTimeout(() => {
                resolve(jsonResponse({ code: 0, stderr: "", stdout: "too late" }));
            }, answerAfterMs);

            request.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(request.signal.reason as Error);
            });
        });

/**
 * A container that answers `200 application/json` immediately and then stalls
 * mid-body for `answerAfterMs` — the shape `slowContainer` deliberately does NOT
 * model. `fetch` resolves on HEADERS, so this is the half of the call a deadline
 * scoped to the request alone stops covering: the status line lands instantly,
 * the deadline is disposed, and the body read waits forever.
 *
 * It is also the natural shape of a streaming runner, which answers with headers
 * as soon as the command starts, and what any wedged container degrades into.
 *
 * The eventual enqueue is load-bearing for the same reason `slowContainer`'s is
 * — a stream that never resolves at all leaves the deadline timer as the event
 * loop's only pending work, a state in which it is sometimes never delivered.
 */
const stallingBodyContainer = (answerAfterMs: number) => (): Response => {
    let timer: ReturnType<typeof setTimeout>;

    const stream = new ReadableStream<Uint8Array>({
        cancel() {
            clearTimeout(timer);
        },
        start(controller) {
            timer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode(String.raw`{"code":0,"stdout":"too late","stderr":""}`));
                controller.close();
            }, answerAfterMs);
        },
    });

    return new Response(stream, { headers: { "content-type": "application/json" }, status: 200 });
};

describe("containerHandle.exec", () => {
    it("posts the command to /__lunora/exec and returns the runner's result", async () => {
        expect.assertions(5);

        const { namespace, requests } = execNamespace(() => jsonResponse({ code: 0, stderr: "", stdout: "hello\n" }));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        const result = await containers.runner!.get("session-1").exec("echo", { args: ["hello"] });

        expect(result).toStrictEqual({ code: 0, stderr: "", stdout: "hello\n" });
        expect(requests[0]!.method).toBe("POST");
        expect(new URL(requests[0]!.url).pathname).toBe("/__lunora/exec");
        await expect(requests[0]!.json()).resolves.toStrictEqual({ args: ["hello"], command: "echo" });
        expect(requests[0]!.headers.get("content-type")).toBe("application/json");
    });

    it("forwards cwd, env and timeoutMs only when set", async () => {
        expect.assertions(2);

        const { namespace, requests } = execNamespace(() => jsonResponse({ code: 0, stderr: "", stdout: "" }));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        await containers.runner!.get("s").exec("pnpm", { args: ["install"], cwd: "/app", env: { CI: "1" }, timeoutMs: 5000 });
        await containers.runner!.get("s").exec("node", {});

        await expect(requests[0]!.json()).resolves.toStrictEqual({
            args: ["install"],
            command: "pnpm",
            cwd: "/app",
            env: { CI: "1" },
            timeoutMs: 5000,
        });
        // No `cwd`/`env`/`timeoutMs` keys at all, rather than explicit undefineds
        // a runner would have to special-case.
        await expect(requests[1]!.json()).resolves.toStrictEqual({ args: [], command: "node" });
    });

    it("returns a non-zero exit code as a result rather than throwing", async () => {
        expect.assertions(1);

        const { namespace } = execNamespace(() => jsonResponse({ code: 1, stderr: "boom\n", stdout: "" }));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        // A command that ran and failed is data. Only a failure to *run* throws.
        await expect(containers.runner!.get("s").exec("false")).resolves.toStrictEqual({ code: 1, stderr: "boom\n", stdout: "" });
    });

    it("throws when the container has no exec route, quoting the status and body", async () => {
        expect.assertions(1);

        const { namespace } = execNamespace(() => new Response("no route here", { status: 404 }));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        // This is the regression the contract exists for: the old convention read
        // the raw body back as output, so a 404/500 looked like a successful run.
        await expect(containers.runner!.get("s").exec("ls")).rejects.toThrow(
            /ctx\.containers\.runner: exec failed — the container answered 404.*no route here/su,
        );
    });

    it("throws when the runner answers something that is not JSON", async () => {
        expect.assertions(1);

        const { namespace } = execNamespace(() => new Response("plain text", { status: 200 }));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        await expect(containers.runner!.get("s").exec("ls")).rejects.toThrow(/exec response was not JSON/u);
    });

    it("throws when the runner omits a numeric exit code", async () => {
        expect.assertions(1);

        const { namespace } = execNamespace(() => jsonResponse({ stdout: "output but no code" }));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        // A missing code is the ambiguity the contract exists to remove — it must
        // not be defaulted to 0, which would report a failure as a success.
        await expect(containers.runner!.get("s").exec("ls")).rejects.toThrow(/missing a numeric `code`/u);
    });

    it("defaults absent stdout/stderr to empty strings", async () => {
        expect.assertions(1);

        const { namespace } = execNamespace(() => jsonResponse({ code: 0 }));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        await expect(containers.runner!.get("s").exec("true")).resolves.toStrictEqual({ code: 0, stderr: "", stdout: "" });
    });

    it("rejects an empty command before touching the container", async () => {
        expect.assertions(2);

        const { namespace, requests } = execNamespace(() => jsonResponse({ code: 0 }));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        await expect(containers.runner!.get("s").exec("")).rejects.toThrow(/exec requires a non-empty `command`/u);
        expect(requests).toHaveLength(0);
    });

    it("is available on .any() and .pool() handles, and through .port()", async () => {
        expect.assertions(3);

        const { namespace, requests } = execNamespace(() => jsonResponse({ code: 0, stderr: "", stdout: "ok" }));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        await expect(containers.runner!.any().exec("ls")).resolves.toStrictEqual({ code: 0, stderr: "", stdout: "ok" });
        await expect(containers.runner!.pool().exec("ls")).resolves.toStrictEqual({ code: 0, stderr: "", stdout: "ok" });

        await containers.runner!.get("s").port(9090).exec("ls");

        // `.port()` re-binds the same send, so exec inherits the port header.
        expect(requests.at(-1)!.headers.get("cf-container-target-port")).toBe("9090");
    });

    // 250ms, not 10ms: the deadline is a real timer competing with a loaded event
    // loop, and at 10ms it lost that race often enough to fail ~3 runs in 10 while
    // passing in isolation. The behaviour under test is "the deadline fires and
    // says so", not "a timer is punctual to the millisecond".
    it("aborts the call when timeoutMs elapses", async () => {
        expect.assertions(1);

        const { namespace } = execNamespace(slowContainer(5000));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        // The directed message, not a loose /abort|timeout/ — a caller reading
        // "exec timed out after 10ms" knows which deadline fired and how long it
        // was, which a generic AbortError does not tell them.
        await expect(containers.runner!.get("s").exec("sleep", { args: ["60"], timeoutMs: 250 })).rejects.toThrow("ctx.containers: exec timed out after 250ms");
    });

    it("keeps the timeoutMs deadline over the body, not just the headers", async () => {
        expect.assertions(1);

        const { namespace } = execNamespace(stallingBodyContainer(5000));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        // The response is `200 application/json` within a millisecond; only the
        // body stalls. A deadline disposed once `fetch` resolves is already gone
        // by this point, so the read would sit unbounded inside the shard DO.
        await expect(containers.runner!.get("s").exec("sleep", { args: ["60"], timeoutMs: 250 })).rejects.toThrow("ctx.containers: exec timed out after 250ms");
    });

    it("aborts a stalled body on the caller's own signal too", async () => {
        expect.assertions(1);

        const controller = new AbortController();
        const { namespace } = execNamespace(stallingBodyContainer(5000));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        const pending = containers.runner!.get("s").exec("sleep", { signal: controller.signal });

        // Give the headers a turn to land, so the abort hits the body read
        // rather than the request.
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });
        controller.abort(new Error("caller gave up mid-body"));

        await expect(pending).rejects.toThrow(/caller gave up mid-body/u);
    });

    it("refuses a response body past maxOutputBytes instead of buffering it", async () => {
        expect.assertions(2);

        const { namespace } = execNamespace(() => jsonResponse({ code: 0, stderr: "", stdout: "x".repeat(4096) }));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        // The whole document has to be held in memory to be parsed, so the cap
        // has to apply while reading — `text()`-then-slice has already allocated
        // everything it was supposed to protect against.
        await expect(containers.runner!.get("s").exec("cat", { maxOutputBytes: 512 })).rejects.toThrow(/exec response exceeded 512 bytes and was abandoned/u);
        await expect(containers.runner!.get("s").exec("cat", { maxOutputBytes: 65_536 })).resolves.toMatchObject({ code: 0 });
    });

    it("caps the response body by default, with no maxOutputBytes given", async () => {
        expect.assertions(1);

        // 1.5MB of stdout — a plausible `pnpm install` transcript, and enough to
        // matter repeated across the requests sharing a 128MB isolate.
        const { namespace } = execNamespace(() => jsonResponse({ code: 0, stderr: "", stdout: "x".repeat(1_500_000) }));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        await expect(containers.runner!.get("s").exec("pnpm", { args: ["install"] })).rejects.toThrow(/exec response exceeded 1000000 bytes/u);
    });

    it("redacts per-call env values out of a quoted error body", async () => {
        expect.assertions(2);

        // A runner whose error handler echoes the payload it received — the
        // default shape of an Express/Fastify 400 — puts the caller's secrets in
        // its response body, which is then quoted into a logged error.
        const { namespace } = execNamespace(async (request) => new Response(`bad request: ${await request.text()}`, { status: 400 }));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        const failure = containers.runner!.get("s").exec("deploy", { env: { NPM_TOKEN: "npm_s3cr3t_value" } });

        await expect(failure).rejects.toThrow(/<redacted>/u);
        await expect(failure).rejects.not.toThrow(/npm_s3cr3t_value/u);
    });

    it("aborts the call when the caller's own signal fires", async () => {
        expect.assertions(1);

        const controller = new AbortController();
        const { namespace } = execNamespace(slowContainer(5000));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        const pending = containers.runner!.get("s").exec("sleep", { args: ["60"], signal: controller.signal });

        controller.abort(new Error("caller gave up"));

        await expect(pending).rejects.toThrow(/caller gave up/u);
    });

    it("honours whichever of signal and timeoutMs fires first", async () => {
        expect.assertions(1);

        const controller = new AbortController();
        const { namespace } = execNamespace(slowContainer(5000));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        // Both set: the caller aborts immediately, well inside the 60s deadline,
        // so the caller's reason must win rather than being swallowed by the
        // timeout signal the two are combined into.
        const pending = containers.runner!.get("s").exec("sleep", { signal: controller.signal, timeoutMs: 60_000 });

        controller.abort(new Error("caller won the race"));

        await expect(pending).rejects.toThrow(/caller won the race/u);
    });

    it("does not re-run a pooled command when the runner 500s after executing it", async () => {
        expect.assertions(3);

        const { namespace, requests } = execNamespace(() => new Response("crashed while serialising the result", { status: 500 }));
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        // The command may already have run — `pool().exec("pnpm", { args: ["publish"] })`
        // under the any-5xx pool default publishes three times. `exec` retries
        // only the cold-start transients, which mean the request never arrived.
        await expect(containers.runner!.pool().exec("pnpm", { args: ["publish"] })).rejects.toThrow(/exec failed — the container answered 500/u);
        expect(requests).toHaveLength(1);

        // A pooled `fetch` still retries any 5xx: its caller chose the method
        // and can reason about replaying it.
        await containers.runner!.pool({ backoffMs: 0 }).fetch("/health");

        expect(requests).toHaveLength(4);
    });

    it("still retries a pooled exec on a cold-start transient", async () => {
        expect.assertions(2);

        let seen = 0;
        const { namespace, requests } = execNamespace(() => {
            seen += 1;

            return seen === 1 ? new Response("no Container instance available", { status: 503 }) : jsonResponse({ code: 0, stderr: "", stdout: "ok" });
        });
        const containers = createContainerContext({ CONTAINER_RUNNER: namespace }, SPEC);

        await expect(containers.runner!.pool({ backoffMs: 0 }).exec("ls")).resolves.toStrictEqual({ code: 0, stderr: "", stdout: "ok" });
        expect(requests).toHaveLength(2);
    });

    it("names the accessor and the pool in an error from the test double", async () => {
        expect.assertions(1);

        const containers = createContainerTestContext({ runner: () => new Response("nope", { status: 404 }) });

        // Not the bare `ctx.containers:` fallback — a failure has to say which
        // accessor, and which handle on it, produced it.
        await expect(containers.runner!.pool().exec("ls")).rejects.toThrow(/^ctx\.containers\.runner\.pool\(\): exec failed/u);
    });

    it("works against the Docker-free test double", async () => {
        expect.assertions(1);

        const containers = createContainerTestContext({
            runner: async (request) => {
                const body = await request.json<{ command: string }>();

                return jsonResponse({ code: 0, stderr: "", stdout: `ran ${body.command}` });
            },
        });

        await expect(containers.runner!.get("s").exec("pnpm")).resolves.toStrictEqual({ code: 0, stderr: "", stdout: "ran pnpm" });
    });
});
