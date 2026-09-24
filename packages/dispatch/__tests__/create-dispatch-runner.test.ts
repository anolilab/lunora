import { LunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import { createDispatchLogger } from "../src/create-dispatch-logger";
import { createDispatchRunner, isDeterministicDispatchFailure } from "../src/create-dispatch-runner";

const ENV = { LUNORA_ADMIN_TOKEN: "tok", LUNORA_ORIGIN_URL: "https://app.example.com/" };
const REF = { __lunoraRef: "messages:send" };

describe("createDispatchRunner", () => {
    it("pOSTs to /_lunora/scheduler/dispatch with the bearer + envelope and resolves the decoded result", async () => {
        expect.assertions(5);

        const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ result: { ok: 1 } }, { status: 200 }));
        const run = createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" });

        await expect(run(REF, { to: "a" }, { shardKey: "s1" })).resolves.toEqual({ ok: 1 });

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

        expect(url).toBe("https://app.example.com/_lunora/scheduler/dispatch");
        expect(init.method).toBe("POST");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
        expect(JSON.parse(init.body as string)).toEqual({ args: { to: "a" }, functionPath: "messages:send", shardKey: "s1" });
    });

    it("forwards a caller `traceparent` so the callee joins the trace, and omits it when unset", async () => {
        expect.assertions(2);

        const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ result: { ok: 1 } }, { status: 200 }));
        const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

        await createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue", traceparent })(REF, { to: "a" });
        await createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" })(REF, { to: "a" });

        const headersOf = (index: number): Record<string, string> =>
            (fetchImpl.mock.calls[index] as unknown as [string, RequestInit])[1].headers as Record<string, string>;

        // A queue batch or cron fire opens its own trace; without this header every
        // function the handler invokes became a separate root trace.
        expect(headersOf(0).traceparent).toBe(traceparent);
        expect(headersOf(1).traceparent).toBeUndefined();
    });

    it("forwards dedupId as the body's `id` (the receiver's dedup key) and omits the key when unset", async () => {
        expect.assertions(3);

        const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ result: { ok: 1 } }, { status: 200 }));
        const run = createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" });

        await run(REF, { to: "a" }, { dedupId: "msg-1#1" });
        await run(REF, { to: "a" });
        // messageId is attribution-only: it must NEVER become the dedup key, or
        // a handler's second call collides with its first on (identity, id).
        await run(REF, { to: "a" }, { messageId: "msg-1" });

        const bodyOf = (index: number): unknown => JSON.parse((fetchImpl.mock.calls[index] as unknown as [string, RequestInit])[1].body as string);

        expect(bodyOf(0)).toEqual({ args: { to: "a" }, functionPath: "messages:send", id: "msg-1#1" });
        // `toEqual` fails on any extra defined property, so this also proves `id` is absent.
        expect(bodyOf(1)).toEqual({ args: { to: "a" }, functionPath: "messages:send" });
        expect(bodyOf(2)).toEqual({ args: { to: "a" }, functionPath: "messages:send" });
    });

    it("resolves undefined for an empty body", async () => {
        expect.assertions(1);

        const run = createDispatchRunner({ env: ENV, fetchImpl: async () => new Response("", { status: 200 }), label: "@lunora/queue" });

        await expect(run(REF)).resolves.toBeUndefined();
    });

    it("throws a label-prefixed error on a non-ok response", async () => {
        expect.assertions(1);

        const run = createDispatchRunner({ env: ENV, fetchImpl: async () => new Response("boom", { status: 500 }), label: "@lunora/workflow" });

        await expect(run(REF)).rejects.toThrow(/@lunora\/workflow: function dispatch failed \(500\): boom/);
    });

    it("preserves the dispatch endpoint's structured code/status/data on a non-ok response", async () => {
        expect.assertions(4);

        const fetchImpl = (async () =>
            Response.json({ error: { code: "BAD_REQUEST", data: { field: "to" }, message: "missing `to`" } }, { status: 400 })) as unknown as typeof fetch;
        const run = createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" });

        const error = (await run(REF).then(
            () => undefined,
            (error_: unknown) => error_,
        )) as { code?: unknown; data?: unknown; message?: unknown; status?: unknown };

        expect(error.code).toBe("BAD_REQUEST");
        expect(error.status).toBe(400);
        expect(error.data).toEqual({ field: "to" });
        expect(error.message).toBe("missing `to`");
    });

    it("falls back to INTERNAL when a non-ok error body is unparseable", async () => {
        expect.assertions(2);

        const run = createDispatchRunner({ env: ENV, fetchImpl: async () => new Response("<html>502</html>", { status: 502 }), label: "@lunora/queue" });

        const error = (await run(REF).then(
            () => undefined,
            (error_: unknown) => error_,
        )) as { code?: unknown; status?: unknown };

        expect(error.code).toBe("INTERNAL");
        expect(error.status).toBe(502);
    });

    it("throws INTERNAL for a non-JSON 200 body instead of resolving the raw text", async () => {
        expect.assertions(2);

        const run = createDispatchRunner({ env: ENV, fetchImpl: async () => new Response("<html>oops</html>", { status: 200 }), label: "@lunora/workflow" });

        const error = (await run(REF).then(
            () => undefined,
            (error_: unknown) => error_,
        )) as { code?: unknown; message?: unknown };

        expect(error.code).toBe("INTERNAL");
        expect(error.message).toMatch(/@lunora\/workflow: function dispatch returned a non-JSON body \(200\):/);
    });

    it("requires LUNORA_ORIGIN_URL and LUNORA_ADMIN_TOKEN", async () => {
        expect.assertions(2);

        const fetchImpl = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;

        await expect(createDispatchRunner({ env: { LUNORA_ADMIN_TOKEN: "t" }, fetchImpl, label: "@lunora/queue" })(REF)).rejects.toThrow(/LUNORA_ORIGIN_URL/);
        await expect(createDispatchRunner({ env: { LUNORA_ORIGIN_URL: "https://x" }, fetchImpl, label: "@lunora/queue" })(REF)).rejects.toThrow(
            /LUNORA_ADMIN_TOKEN/,
        );
    });

    // The runner's deadline is a JS-land `setTimeout` (shared/abort-deadline.ts),
    // so `vi.useFakeTimers()` drives it directly: advancing past the deadline
    // fires the abort, deterministic and instant, and the advance distance
    // proves the runner armed the right duration.

    // A fetchImpl that hangs until its signal aborts, rejecting with the
    // signal's `reason` — the same contract real `fetch` follows for a
    // signal-bound request (rejects with the signal's reason, not a
    // hardcoded generic error).
    const hangingFetchImpl = (): ReturnType<typeof vi.fn<typeof fetch>> =>
        vi.fn<typeof fetch>(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        reject(init.signal!.reason as Error);
                    });
                }),
        );

    // A Response double whose headers "arrive" immediately (the outer fetch
    // resolves), but whose `.text()` hangs until `signal` aborts — the
    // real-`fetch` contract for a body stream that stalls AFTER headers land
    // (the deadline is still bound to the same signal the initial fetch used).
    // Checks `signal.aborted` synchronously, not just the future event, since
    // `.text()` is only called a microtask after the fetch resolves — by then
    // the test's `abort()` call (issued right after kicking off the run, with
    // no intervening `await`) may already have fired.
    const responseWithHangingBody = (init: { ok: boolean; status: number }, signal: AbortSignal | null | undefined): Response =>
        ({
            ok: init.ok,
            status: init.status,
            text: async () =>
                new Promise<string>((_resolve, reject) => {
                    if (signal?.aborted === true) {
                        reject(signal.reason as Error);

                        return;
                    }

                    signal?.addEventListener("abort", () => {
                        reject(signal.reason as Error);
                    });
                }),
        }) as unknown as Response;

    it("rejects within the default timeout when the dispatch never settles, with a status outside the deterministic set", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        try {
            const fetchImpl = hangingFetchImpl();
            const pending = createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" })(REF).catch((error: unknown) => error);

            // One ms short of the default deadline: the timer is still armed,
            // proving the runner asked for the full 30s window.
            await vi.advanceTimersByTimeAsync(29_999);

            expect(vi.getTimerCount()).toBe(1);

            await vi.advanceTimersByTimeAsync(1);

            const error = (await pending) as { status?: unknown };

            expect(error).toBeInstanceOf(Error);
            expect(error.status).toBe(503);
            expect((error as Error).message).toMatch(/timed out after 30000ms/);
        } finally {
            vi.useRealTimers();
        }
    });

    it("rethrows a non-timeout abort/network failure unchanged", async () => {
        expect.assertions(1);

        // Not a timeout — e.g. a DNS failure surfaced straight from the fetch
        // implementation.
        const fetchImpl = vi.fn<typeof fetch>(async () => {
            throw new TypeError("fetch failed");
        });

        await expect(createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" })(REF)).rejects.toThrow("fetch failed");
    });

    it("overrides the default timeout with RunFunctionOptions.timeoutMs", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        try {
            const fetchImpl = hangingFetchImpl();
            const pending = createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" })(REF, undefined, { timeoutMs: 1000 }).catch(
                (error: unknown) => error,
            );

            await vi.advanceTimersByTimeAsync(1000);

            const error = (await pending) as { message?: unknown };

            expect(error.message).toMatch(/timed out after 1000ms/);
        } finally {
            vi.useRealTimers();
        }
    });

    it("leaves no pending deadline timer once a fast dispatch settles", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        try {
            const run = createDispatchRunner({
                env: ENV,
                fetchImpl: async () => Response.json({ result: { ok: 1 } }, { status: 200 }),
                label: "@lunora/queue",
            });

            await expect(run(REF)).resolves.toEqual({ ok: 1 });
            // `dispose()` in the runner's `finally` cleared the deadline timer.
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("maps a deadline that fires DURING a successful response's stalled body read to the same retryable 503 (PR review)", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        try {
            const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => responseWithHangingBody({ ok: true, status: 200 }, init?.signal));
            const pending = createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" })(REF).catch((error: unknown) => error);

            // Headers already "arrived" (fetchImpl resolved) by the time the
            // deadline fires; the pending `response.text()` read must still see it.
            await vi.advanceTimersByTimeAsync(30_000);

            const error = (await pending) as { status?: unknown };

            expect(error.status).toBe(503);
            expect((error as Error).message).toMatch(/timed out after 30000ms/);
        } finally {
            vi.useRealTimers();
        }
    });

    it("maps a deadline that fires DURING a non-ok response's stalled error-body read to the same retryable 503 (PR review)", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        try {
            const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => responseWithHangingBody({ ok: false, status: 500 }, init?.signal));
            const pending = createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" })(REF).catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(30_000);

            const error = (await pending) as { status?: unknown };

            // Must be the runner's own retryable timeout error, NOT toDispatchError's
            // 500-status classification — the abort during the body read must win.
            expect(error.status).toBe(503);
            expect((error as Error).message).toMatch(/timed out after 30000ms/);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("isDeterministicDispatchFailure", () => {
    it("is true for the deterministic allowlist and false for 408/429/5xx and non-LunoraErrors", async () => {
        expect.assertions(8);

        // A real dispatch failure: the endpoint's `{ error: { code, … } }` envelope.
        const errorWithStatus = async (status: number): Promise<unknown> =>
            createDispatchRunner({
                env: ENV,
                fetchImpl: async () => Response.json({ error: { code: "BAD_REQUEST", message: "boom" } }, { status }),
                label: "@lunora/queue",
            })(REF).then(
                () => undefined,
                (error: unknown) => error,
            );

        expect(isDeterministicDispatchFailure(await errorWithStatus(400))).toBe(true);
        expect(isDeterministicDispatchFailure(await errorWithStatus(403))).toBe(true);
        expect(isDeterministicDispatchFailure(await errorWithStatus(404))).toBe(true);
        expect(isDeterministicDispatchFailure(await errorWithStatus(422))).toBe(true);
        expect(isDeterministicDispatchFailure(await errorWithStatus(408))).toBe(false);
        expect(isDeterministicDispatchFailure(await errorWithStatus(429))).toBe(false);
        expect(isDeterministicDispatchFailure(await errorWithStatus(500))).toBe(false);
        expect(isDeterministicDispatchFailure(new Error("plain"))).toBe(false);
    });

    it("is false for an allowlisted status whose body carries no dispatch envelope (edge challenge / WAF block)", async () => {
        expect.assertions(3);

        // Cloudflare answers a blocked request with an HTML challenge page, not
        // the dispatch endpoint's JSON envelope — the 403 says nothing about the
        // function call, and clears once the rule or the route is fixed. Treating
        // it as deterministic dead-letters the whole queue batch / burns the
        // workflow step permanently, so it must stay retryable.
        const htmlBody = async (status: number): Promise<unknown> =>
            createDispatchRunner({
                env: ENV,
                fetchImpl: async () => new Response("<!DOCTYPE html><html><body>Attention Required! | Cloudflare</body></html>", { status }),
                label: "@lunora/queue",
            })(REF).then(
                () => undefined,
                (error: unknown) => error,
            );

        expect(isDeterministicDispatchFailure(await htmlBody(403))).toBe(false);
        expect(isDeterministicDispatchFailure(await htmlBody(404))).toBe(false);
        // The status still rides along for diagnostics — only the classification changes.
        expect((await htmlBody(403)) as { status?: unknown }).toMatchObject({ status: 403 });
    });

    it("is false for a LunoraError that merely shares an allowlisted status but did not come from a dispatch response", () => {
        expect.assertions(1);

        // Same shape (structural code/status/type) as a real dispatch failure,
        // but built directly by unrelated code (e.g. a storage lookup) rather
        // than by `toDispatchError` — must not be misclassified as a
        // dispatch failure just because its status is in the allowlist.
        const unrelated = new LunoraError("STORAGE_OBJECT_NOT_FOUND", "not found", { status: 404 });

        expect(isDeterministicDispatchFailure(unrelated)).toBe(false);
    });
});

describe("createDispatchRunner wire bracketing", () => {
    // The shard answers `jsonResponse({ result: encodeWire(result) })`
    // (`ShardDO.buildDispatchResponse`), so a realistic mock is an ENVELOPE
    // carrying an ENCODED result — not the bare object the older mocks used,
    // which is precisely why an unbracketed hop stayed green here.
    const shardEnvelope = async (result: unknown, extra: Record<string, unknown> = {}): Promise<Response> =>
        Response.json({ ...extra, result: encodeWire(result) }, { status: 200 });

    it("resolves the DECODED result off the `{ result }` envelope, not the envelope itself", async () => {
        expect.assertions(1);

        const value = { status: "cancelled", total: 5n, when: new Date(0) };
        const run = createDispatchRunner({ env: ENV, fetchImpl: async () => shardEnvelope(value), label: "@lunora/workflow" });

        // The documented workflow guard — `if (order.status === "cancelled")` —
        // reads `undefined` off the raw envelope.
        await expect(run(REF)).resolves.toStrictEqual(value);
    });

    it("round-trips bigint, bytes, Date and NaN through the result", async () => {
        expect.assertions(4);

        const value = { blob: new Uint8Array([1, 2, 3]), missed: Number.NaN, total: 9_007_199_254_740_993n, when: new Date("2024-03-04T05:06:07.008Z") };
        const run = createDispatchRunner({ env: ENV, fetchImpl: async () => shardEnvelope(value), label: "@lunora/queue" });
        const resolved = (await run(REF)) as typeof value;

        expect(resolved.total).toBe(9_007_199_254_740_993n);
        expect(resolved.blob).toStrictEqual(new Uint8Array([1, 2, 3]));
        expect(resolved.when).toStrictEqual(new Date("2024-03-04T05:06:07.008Z"));
        expect(resolved.missed).toBeNaN();
    });

    it("unwraps the mutation envelope variants (`commitCursor`, `lastMutationId`) the same way", async () => {
        expect.assertions(2);

        const withCursor = createDispatchRunner({ env: ENV, fetchImpl: async () => shardEnvelope({ id: 1n }, { commitCursor: 42 }), label: "@lunora/queue" });
        const withSeq = createDispatchRunner({ env: ENV, fetchImpl: async () => shardEnvelope({ id: 2n }, { lastMutationId: 7 }), label: "@lunora/queue" });

        await expect(withCursor(REF)).resolves.toStrictEqual({ id: 1n });
        await expect(withSeq(REF)).resolves.toStrictEqual({ id: 2n });
    });

    it("wire-encodes args so a bigint/bytes/Date ARGUMENT survives instead of throwing on JSON.stringify", async () => {
        expect.assertions(2);

        const fetchImpl = vi.fn<typeof fetch>(async () => shardEnvelope(undefined));
        const run = createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" });
        const args = { amount: 5n, blob: new Uint8Array([1, 2]), when: new Date(0) };

        await expect(run(REF, args)).resolves.toBeUndefined();

        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

        // The shard `decodeWire`s `payload.args`, so the encoded tagged form is
        // exactly what makes it back to a `bigint`/`Uint8Array`/`Date` there.
        expect(JSON.parse(init.body as string)).toStrictEqual({ args: encodeWire(args), functionPath: "messages:send" });
    });

    it("throws INTERNAL for a 200 JSON body that is not an envelope object", async () => {
        expect.assertions(2);

        // `JSON.parse("null")` is `null`, on which reading `.result` throws a bare
        // TypeError that escapes as neither a dispatch failure nor a timeout.
        const run = createDispatchRunner({ env: ENV, fetchImpl: async () => new Response("null", { status: 200 }), label: "@lunora/workflow" });

        const error = (await run(REF).then(
            () => undefined,
            (error_: unknown) => error_,
        )) as { code?: unknown; message?: unknown };

        expect(error.code).toBe("INTERNAL");
        expect(error.message).toMatch(/@lunora\/workflow: function dispatch returned a JSON body that is not a \{ result \} envelope \(200\)/);
    });

    // `typeof [] === "object"`, so the object guard alone let a bare JSON array
    // and an `{}` through to `decodeWire(undefined)` — resolving `undefined` as
    // "the function returned nothing" for a body that is not a shard envelope at
    // all. The shard emits `{"result":["$lunora.wire$","undefined"]}` for a
    // genuine `undefined` return, never an absent key, so requiring the key is
    // free.
    it.each([
        ["a JSON array", "[1,2,3]"],
        ["an object with no `result` key", '{"commitCursor":42}'],
    ])("throws INTERNAL for %s rather than resolving undefined", async (_label: string, body: string) => {
        expect.assertions(2);

        const run = createDispatchRunner({ env: ENV, fetchImpl: async () => new Response(body, { status: 200 }), label: "@lunora/workflow" });

        const error = (await run(REF).then(
            () => undefined,
            (error_: unknown) => error_,
        )) as { code?: unknown; message?: unknown };

        expect(error.code).toBe("INTERNAL");
        expect(error.message).toMatch(/@lunora\/workflow: function dispatch returned a JSON body that is not a \{ result \} envelope \(200\)/);
    });

    // A genuine `undefined` return still resolves — the key is present, tagged.
    it("resolves undefined for the shard's tagged-undefined envelope", async () => {
        expect.assertions(1);

        const run = createDispatchRunner({ env: ENV, fetchImpl: async () => shardEnvelope(undefined), label: "@lunora/queue" });

        await expect(run(REF)).resolves.toBeUndefined();
    });

    // `encodeWire` rejects any non-plain object, where `JSON.stringify` swallowed
    // it into `{}`. The bare codec TypeError names only the offending type, so an
    // operator reading a failed dispatch's log line cannot tell which call carried
    // it — the label and the function path are the whole point.
    it("labels an unencodable argument with the package and the function path", async () => {
        expect.assertions(1);

        const run = createDispatchRunner({ env: ENV, fetchImpl: async () => shardEnvelope(undefined), label: "@lunora/queue" });

        await expect(run(REF, { pattern: /nope/u })).rejects.toThrow(/@lunora\/queue: cannot encode args for 'messages:send' — /);
    });
});

describe("createDispatchLogger", () => {
    it("prefixes every level", () => {
        expect.assertions(1);

        const spy = vi.spyOn(console, "info").mockImplementation(() => {});
        createDispatchLogger("[queue:email]").info("hello", 1);

        expect(spy).toHaveBeenCalledWith("[queue:email]", "hello", 1);

        spy.mockRestore();
    });
});
