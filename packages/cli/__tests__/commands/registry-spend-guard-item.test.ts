/**
 * The shipped `registry/spend-guard` item, EXECUTED against an in-memory R2 bucket.
 *
 * The receiver is the only thing standing between a stranger on the internet and
 * a paused production app, so each refusal is asserted, and the pause and the
 * scheduled-job skip are asserted against the same flag the receiver writes.
 * `registry/tsconfig.json` checks the types; this file checks the behaviour.
 */
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registryRoot = resolve(fileURLToPath(new URL("../../../../registry", import.meta.url)));

type Fetch = (request: Request, env: unknown, context: unknown) => Promise<Response>;
type Scheduled = (controller: unknown, env: unknown, context: unknown) => Promise<void>;

interface SpendGuardModule {
    SPEND_ALERT_PATH: string;
    SPEND_PAUSED_KEY: string;
    withSpendGuard: <W extends { fetch: unknown; scheduled: unknown }>(worker: W) => W;
}

interface StoredObject {
    body: string;
}

/** An R2 bucket reduced to what the guard uses: head and put, with the stored objects visible to the test. */
const makeBucket = () => {
    const objects = new Map<string, StoredObject>();

    return {
        head: async (key: string): Promise<StoredObject | null> => objects.get(key) ?? null,
        objects,
        put: async (key: string, body: string): Promise<void> => {
            objects.set(key, { body });
        },
    };
};

type Bucket = ReturnType<typeof makeBucket>;

const SECRET = "test-secret-0123456789abcdef";
const USAGE_ALERT = JSON.stringify({ alert_type: "billing_usage_alert", name: "Lunora usage: Workers requests", policy_id: "p1" });
const SCHEDULE = { cron: "0 * * * *" };
/** The guard trusts its last read of the pause flag for 30 s; a test that flips the flag steps past it. */
const CACHE_WINDOW_MS = 30_000;

/** Build an env with the given bucket and secret. Both are explicit: `undefined` means "unset". */
const envWith = (bucket: Bucket | undefined, secret: string | undefined) => {
    return {
        SPEND_GUARD: bucket,
        SPEND_GUARD_SECRET: secret,
    };
};

describe("registry/spend-guard", () => {
    let guard: SpendGuardModule;
    let innerFetch: ReturnType<typeof vi.fn<Fetch>>;
    let innerScheduled: ReturnType<typeof vi.fn<Scheduled>>;
    let innerQueue: ReturnType<typeof vi.fn<Fetch>>;
    let app: {
        fetch: Fetch;
        queue: Fetch;
        scheduled: Scheduled;
    };

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.spyOn(console, "warn").mockImplementation(() => {});
        guard = (await import(pathToFileURL(join(registryRoot, "spend-guard", "spend-guard.ts")).href)) as SpendGuardModule;
        innerFetch = vi.fn<Fetch>(async () => new Response("app", { status: 200 }));
        innerScheduled = vi.fn<Scheduled>(async () => {});
        innerQueue = vi.fn<Fetch>(async () => new Response("queue", { status: 200 }));
        app = guard.withSpendGuard({ fetch: innerFetch, queue: innerQueue, scheduled: innerScheduled });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const alert = (body: string, headers: Record<string, string>): Request =>
        new Request(`https://app.example${guard.SPEND_ALERT_PATH}`, { body, headers, method: "POST" });

    const authed = (body: string): Request => alert(body, { "cf-webhook-auth": SECRET });

    const get = (path: string): Request => new Request(`https://app.example${path}`);

    it("refuses every alert when no secret is configured, and pauses nothing", async () => {
        expect.assertions(2);

        const bucket = makeBucket();
        const response = await app.fetch(authed(USAGE_ALERT), envWith(bucket, undefined), {});

        expect(response.status).toBe(403);
        expect(bucket.objects.size).toBe(0);
    });

    it("refuses an empty configured secret, even when the header is empty too", async () => {
        expect.assertions(2);

        const bucket = makeBucket();
        const response = await app.fetch(alert(USAGE_ALERT, {}), envWith(bucket, ""), {});

        expect(response.status).toBe(403);
        expect(bucket.objects.size).toBe(0);
    });

    it("refuses a missing or wrong cf-webhook-auth header, and a secret that differs only in length", async () => {
        expect.assertions(2);

        const bucket = makeBucket();
        const env = envWith(bucket, SECRET);
        const missing = await app.fetch(alert(USAGE_ALERT, {}), env, {});
        const wrong = await app.fetch(alert(USAGE_ALERT, { "cf-webhook-auth": "wrong" }), env, {});
        const longer = await app.fetch(alert(USAGE_ALERT, { "cf-webhook-auth": `${SECRET}x` }), env, {});
        const shorter = await app.fetch(alert(USAGE_ALERT, { "cf-webhook-auth": SECRET.slice(1) }), env, {});

        expect([missing.status, wrong.status, longer.status, shorter.status]).toStrictEqual([403, 403, 403, 403]);
        expect(bucket.objects.size).toBe(0);
    });

    it("answers a GET on the receiver with 405, not a pause", async () => {
        expect.assertions(2);

        const bucket = makeBucket();
        const response = await app.fetch(get(guard.SPEND_ALERT_PATH), envWith(bucket, SECRET), {});

        expect(response.status).toBe(405);
        expect(bucket.objects.size).toBe(0);
    });

    it("acknowledges an authenticated delivery that is not a usage alert, and pauses nothing", async () => {
        expect.assertions(3);

        const bucket = makeBucket();
        const env = envWith(bucket, SECRET);
        const response = await app.fetch(authed(JSON.stringify({ alert_type: "dedicated_ssl_certificate_event_type" })), env, {});

        expect(response.status).toBe(202);
        expect(bucket.objects.size).toBe(0);

        const posts = await app.fetch(get("/posts"), env, {});

        expect(posts.status).toBe(200);
    });

    it("treats an authenticated body that is not JSON as not a usage alert", async () => {
        expect.assertions(2);

        const bucket = makeBucket();
        const response = await app.fetch(authed("not json"), envWith(bucket, SECRET), {});

        expect(response.status).toBe(202);
        expect(bucket.objects.size).toBe(0);
    });

    it("refuses an oversized alert body, and pauses nothing", async () => {
        expect.assertions(2);

        const bucket = makeBucket();
        const oversized = JSON.stringify({ alert_type: "billing_usage_alert", padding: "x".repeat(20 * 1024) });
        const response = await app.fetch(authed(oversized), envWith(bucket, SECRET), {});

        expect(response.status).toBe(413);
        expect(bucket.objects.size).toBe(0);
    });

    it("pauses on a verified usage alert: user traffic gets 503 and the flag is written", async () => {
        expect.assertions(4);

        const bucket = makeBucket();
        const env = envWith(bucket, SECRET);
        const accepted = await app.fetch(authed(USAGE_ALERT), env, {});

        expect(accepted.status).toBe(200);
        expect(bucket.objects.has(guard.SPEND_PAUSED_KEY)).toBe(true);

        const paused = await app.fetch(get("/posts"), env, {});

        expect(paused.status).toBe(503);
        expect(innerFetch).not.toHaveBeenCalled();
    });

    it("keeps health probes up while paused", async () => {
        expect.assertions(2);

        const bucket = makeBucket();
        const env = envWith(bucket, SECRET);

        await app.fetch(authed(USAGE_ALERT), env, {});

        const health = await app.fetch(get("/_lunora/health"), env, {});
        const ready = await app.fetch(get("/_lunora/health/ready"), env, {});

        expect([health.status, ready.status]).toStrictEqual([200, 200]);
        expect(innerFetch).toHaveBeenCalledTimes(2);
    });

    it("leaves the internal scheduler and queue dispatch paths running while paused", async () => {
        expect.assertions(1);

        const bucket = makeBucket();
        const env = envWith(bucket, SECRET);

        await app.fetch(authed(USAGE_ALERT), env, {});

        const scheduler = await app.fetch(get("/_lunora/scheduler/dispatch"), env, {});
        const queue = await app.fetch(get("/_lunora/queue"), env, {});

        expect([scheduler.status, queue.status]).toStrictEqual([200, 200]);
    });

    it("skips cron jobs while paused, and runs them again after the flag is removed", async () => {
        expect.assertions(3);

        const bucket = makeBucket();
        const env = envWith(bucket, SECRET);

        await app.scheduled(SCHEDULE, env, {});

        expect(innerScheduled).toHaveBeenCalledTimes(1);

        await app.fetch(authed(USAGE_ALERT), env, {});
        await app.scheduled(SCHEDULE, env, {});

        expect(innerScheduled).toHaveBeenCalledTimes(1);

        bucket.objects.delete(guard.SPEND_PAUSED_KEY);
        vi.setSystemTime(Date.now() + CACHE_WINDOW_MS);
        await app.scheduled(SCHEDULE, env, {});

        expect(innerScheduled).toHaveBeenCalledTimes(2);
    });

    it("resumes user traffic once the operator removes the flag", async () => {
        expect.assertions(2);

        const bucket = makeBucket();
        const env = envWith(bucket, SECRET);

        await app.fetch(authed(USAGE_ALERT), env, {});

        const paused = await app.fetch(get("/posts"), env, {});

        expect(paused.status).toBe(503);

        bucket.objects.delete(guard.SPEND_PAUSED_KEY);
        vi.setSystemTime(Date.now() + CACHE_WINDOW_MS);

        const resumed = await app.fetch(get("/posts"), env, {});

        expect(resumed.status).toBe(200);
    });

    it("reads the pause flag once per cache window, not once per request", async () => {
        expect.assertions(2);

        const bucket = makeBucket();
        const head = vi.spyOn(bucket, "head");
        const env = envWith(bucket, SECRET);

        for (let request = 0; request < 20; request += 1) {
            // eslint-disable-next-line no-await-in-loop -- requests are sequential on purpose
            await app.fetch(get("/posts"), env, {});
        }

        expect(head).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + CACHE_WINDOW_MS);
        await app.fetch(get("/posts"), env, {});

        expect(head).toHaveBeenCalledTimes(2);
    });

    it("keeps the first pause time when a second usage alert arrives while already paused", async () => {
        expect.assertions(2);

        const bucket = makeBucket();
        const env = envWith(bucket, SECRET);

        await app.fetch(authed(USAGE_ALERT), env, {});
        const first = bucket.objects.get(guard.SPEND_PAUSED_KEY)?.body;

        await app.fetch(authed(USAGE_ALERT), env, {});

        expect(first).toBeDefined();
        expect(bucket.objects.get(guard.SPEND_PAUSED_KEY)?.body).toBe(first);
    });

    it("passes an unpaused app through untouched, and keeps the other Worker entries", async () => {
        expect.assertions(3);

        const bucket = makeBucket();
        const response = await app.fetch(get("/posts"), envWith(bucket, SECRET), {});

        expect(response.status).toBe(200);
        expect(innerFetch).toHaveBeenCalledTimes(1);
        expect(app.queue).toBe(innerQueue);
    });
});
