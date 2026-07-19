/* eslint-disable no-secrets/no-secrets -- the entropy scanner trips on repeated identifiers (`verifyStandardWebhook`, etc.) in this file's doc comments, not credentials */

/**
 * Plan 132 spike — feasibility prototype for outbound webhook delivery.
 *
 * See `plans/132-phase0-design.md` for the full design writeup. This file is
 * the "Step 3: feasibility prototype" deliverable — a THROWAWAY proof that
 * today's shipped primitives (unmodified) already carry a forced-failure
 * delivery through retry-with-backoff and into the dead-letter store, and
 * that the existing manual-redrive HTTP surface can resurrect it.
 *
 * Repro:
 *   pnpm --filter "@lunora/playground" exec vitest run __tests__/webhook-delivery-spike.test.ts
 *
 * What this wires together — every piece is a shipped, UNMODIFIED export;
 * `git status` after this spike touches no package `src` directory:
 *
 *  - `@lunora/scheduler`'s `SchedulerDO` — the real retry/backoff/dead-letter
 *    code path (`scheduler-do.ts`: `recordRetry()`, the `dead:` prefix, the
 *    `GET /dead` / `POST /dead/retry` HTTP surface). Driven by overriding
 *    ONLY the `protected dispatch()` hook — the exact seam
 *    `@lunora/scheduler`'s own tests use (see
 *    `packages/scheduler/__tests__/scheduler-do.test.ts`'s `FailingScheduler`)
 *    — so "dispatch" performs a REAL HTTP POST to a local catcher instead of
 *    calling back into `/_lunora/scheduler/dispatch`. In production this
 *    override collapses two hops into one: the SchedulerDO would call the
 *    Worker's dispatch endpoint, which would run a Lunora action, and THAT
 *    action's handler would build+sign+POST to the external endpoint. Here
 *    the override plays the role of "the dispatched action", which is the
 *    faithful unit for this question: does a `dispatch()` `true`/`false`
 *    outcome drive the SAME unmodified retry/dead-letter machinery.
 *  - `@lunora/payment`'s `verifyStandardWebhook` — the already-shipped
 *    Standard Webhooks (svix-style) signature VERIFIER, reused unmodified on
 *    the receiving ("catcher") side to prove a real sign → verify round trip
 *    (the signer is new, ~15 lines, mirroring the wire format
 *    `verifyStandardWebhook` already expects — see `packages/payment/src/webhook.ts`).
 *  - `@lunora/payment`'s `idempotencyKey` — reused to derive a stable
 *    `idempotency-key` header per (event, endpoint) delivery attempt.
 *
 * The in-memory `DurableObjectState` fake below mirrors (does not import —
 * it lives in another package's `__tests__`, not a published export)
 * `@lunora/scheduler`'s own `packages/scheduler/__tests__/fake-state.ts`
 * fixture, trimmed to what `SchedulerDO` actually calls.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { idempotencyKey, verifyStandardWebhook } from "@lunora/payment";
import type { SchedulerDOState, ScheduleRecord, SchedulerEnv } from "@lunora/scheduler";
import { SchedulerDO } from "@lunora/scheduler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Fake DurableObjectState — a plain Map-backed storage, no workers runtime.
// ---------------------------------------------------------------------------

const createFakeSchedulerState = (): SchedulerDOState => {
    const storage = new Map<string, unknown>();
    let alarm: null | number = null;

    return {
        storage: {
            delete: async (keyOrKeys) => {
                const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
                let count = 0;

                for (const key of keys) {
                    if (storage.delete(key)) {
                        count += 1;
                    }
                }

                return count;
            },
            deleteAlarm: async () => {
                alarm = null;
            },
            get: async <T = unknown>(key: string) => storage.get(key) as T | undefined,
            getAlarm: async () => alarm,
            // `end` is intentionally ignored (matching @lunora/scheduler's own
            // fixture) — alarm() re-checks `dueAt <= now` itself, so a wider
            // scan here doesn't break correctness, only the (irrelevant for a
            // test) storage-side pruning optimisation.
            list: async <T = unknown>(options: { limit?: number; prefix?: string } = {}) => {
                const prefix = options.prefix ?? "";
                const byteCompare = (left: string, right: string): number => {
                    if (left < right) {
                        return -1;
                    }

                    return left > right ? 1 : 0;
                };
                const keys = [...storage.keys()].filter((key) => key.startsWith(prefix)).toSorted(byteCompare);
                const result = new Map<string, T>();

                for (const key of keys.slice(0, options.limit ?? keys.length)) {
                    result.set(key, storage.get(key) as T);
                }

                return result;
            },
            put: async (entries, value) => {
                if (typeof entries === "string") {
                    storage.set(entries, value);

                    return;
                }

                for (const [key, value_] of Object.entries(entries)) {
                    storage.set(key, value_);
                }
            },
            setAlarm: async (time) => {
                alarm = time instanceof Date ? time.getTime() : time;
            },
        },
    };
};

// ---------------------------------------------------------------------------
// Standard-Webhooks-style signer — the mirror of the already-shipped verifier
// (`verifyStandardWebhook` in packages/payment/src/webhook.ts): base64(HMAC-
// SHA256(key, "{id}.{timestamp}.{payload}")), key = base64-decoded secret with
// an optional `whsec_` prefix stripped. Only the SIGNING half is new here; the
// VERIFYING half is reused unmodified from @lunora/payment below.
// ---------------------------------------------------------------------------

const SYMMETRIC_PREFIX = "whsec_";

const signStandardWebhook = async (secret: string, webhookId: string, webhookTimestamp: string, payload: string): Promise<string> => {
    const rawSecret = secret.startsWith(SYMMETRIC_PREFIX) ? secret.slice(SYMMETRIC_PREFIX.length) : secret;
    const keyBytes = Uint8Array.from(atob(rawSecret), (character) => character.codePointAt(0) ?? 0);
    const key = await crypto.subtle.importKey("raw", keyBytes, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${webhookId}.${webhookTimestamp}.${payload}`));
    let binary = "";

    for (const byte of new Uint8Array(signature)) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary);
};

// ---------------------------------------------------------------------------
// The "external endpoint" — a real local HTTP server (a genuine POST over the
// loopback interface, not a mocked fetch), forcibly failing on demand.
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = `${SYMMETRIC_PREFIX}${btoa("spike-shared-secret-material")}`;

interface Delivery {
    readonly ok: boolean;
    readonly verified: boolean;
}

interface Catcher {
    readonly close: () => Promise<void>;
    readonly deliveries: Delivery[];
    /** Stop simulating outages — every subsequent request succeeds. */
    readonly forceSuccess: () => void;
    readonly url: string;
}

const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];

        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
        request.on("error", reject);
    });

const header = (value: string[] | string | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

/** Spin up a local catcher that fails the first `initialFailures` requests, then succeeds. */
const createCatcher = async (initialFailures: number): Promise<Catcher> => {
    const deliveries: Delivery[] = [];
    let failuresRemaining = initialFailures;

    const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const body = await readBody(request);
        let verified = true;

        try {
            await verifyStandardWebhook({
                payload: body,
                secret: WEBHOOK_SECRET,
                webhookId: header(request.headers["webhook-id"]),
                webhookSignature: header(request.headers["webhook-signature"]),
                webhookTimestamp: header(request.headers["webhook-timestamp"]),
            });
        } catch {
            verified = false;
        }

        if (!verified) {
            deliveries.push({ ok: false, verified: false });
            response.writeHead(401);
            response.end("signature invalid");

            return;
        }

        if (failuresRemaining > 0) {
            failuresRemaining -= 1;
            deliveries.push({ ok: false, verified: true });
            response.writeHead(500);
            response.end("simulated outage");

            return;
        }

        deliveries.push({ ok: true, verified: true });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ received: true }));
    };

    const server: Server = createServer((request, response) => {
        handleRequest(request, response).catch((error: unknown) => {
            response.writeHead(500);
            response.end(`catcher handler crashed: ${String(error)}`);
        });
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;

    return {
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => {
                    resolve();
                });
            }),
        deliveries,
        forceSuccess: () => {
            failuresRemaining = 0;
        },
        url: `http://127.0.0.1:${String(address.port)}/webhook`,
    };
};

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * The SchedulerDO subclass under test. Overrides ONLY the `protected
 * dispatch()` hook — everything else (retry accounting, backoff math,
 * dead-letter parking, the `/dead` HTTP surface) is the real, unmodified
 * `@lunora/scheduler` implementation.
 */
class WebhookDeliverySchedulerDO extends SchedulerDO {
    public deliveryAttempts = 0;

    public constructor(
        state: SchedulerDOState,
        env: SchedulerEnv,
        private readonly targetUrl: string,
    ) {
        super(state, env);
    }

    protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
        this.deliveryAttempts += 1;

        // Stand-in for a real `webhooks:deliver` action handler's body: build
        // the event envelope, sign it Standard-Webhooks-style, and POST it.
        const payload = JSON.stringify({ data: record.args, event: "order.created" });
        const webhookId = `msg_${record.id}`;
        const webhookTimestamp = String(Math.floor(Date.now() / 1000));
        const signature = await signStandardWebhook(WEBHOOK_SECRET, webhookId, webhookTimestamp, payload);
        // Reused unmodified from @lunora/payment: dedupe key per (event source, endpoint).
        // `functionPath` is optional on ScheduleRecord (a job can target a workflow/agent
        // instead); these spike jobs are always function-targeted, so fall back to "".
        const idempotency = idempotencyKey("webhook.deliver", record.functionPath ?? "", record.id);

        try {
            const response = await fetch(this.targetUrl, {
                body: payload,
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": idempotency,
                    "webhook-id": webhookId,
                    "webhook-signature": `v1,${signature}`,
                    "webhook-timestamp": webhookTimestamp,
                },
                method: "POST",
            });

            return response.ok;
        } catch {
            return false;
        }
    }
}

const post = (path: string, body: unknown): Request =>
    new Request(`https://scheduler.internal${path}`, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" });

const get = (path: string): Request => new Request(`https://scheduler.internal${path}`, { method: "GET" });

interface DeadListBody {
    records: ScheduleRecord[];
}

describe("plan 132 spike — outbound webhook delivery on today's primitives", () => {
    let activeCatchers: Catcher[];

    beforeEach(() => {
        activeCatchers = [];
    });

    afterEach(async () => {
        await Promise.all(activeCatchers.map((catcher) => catcher.close()));
    });

    it("a forced-failure delivery retries with backoff, then dead-letters — never silently dropped", async () => {
        expect.assertions(6);

        const catcher = await createCatcher(Number.POSITIVE_INFINITY); // never succeeds
        activeCatchers.push(catcher);

        const state = createFakeSchedulerState();
        const scheduler = new WebhookDeliverySchedulerDO(state, { LUNORA_ORIGIN_URL: "https://example.test" }, catcher.url);

        const scheduleResponse = await scheduler.fetch(
            post("/schedule", {
                args: { orderId: "ord_1", total: 4200 },
                functionPath: "webhooks:deliver",
                retry: { backoff: "linear", baseMs: 20, maxAttempts: 2 },
                scheduledFor: Date.now(),
            }),
        );
        const { id } = await scheduleResponse.json<{ id: string }>();

        // Attempt 1 (fails) → retry scheduled ~20ms out.
        await scheduler.alarm();
        await sleep(50);
        // Attempt 2 (fails) → retry scheduled ~40ms out.
        await scheduler.alarm();
        await sleep(80);
        // Attempt 3 (fails) → attempts(3) > maxAttempts(2) → dead-lettered.
        await scheduler.alarm();

        expect(scheduler.deliveryAttempts).toBe(3);
        expect(catcher.deliveries).toHaveLength(3);
        expect(catcher.deliveries.every((delivery) => delivery.verified)).toBe(true); // signature was valid every time — only the "business" outcome failed
        expect(catcher.deliveries.every((delivery) => !delivery.ok)).toBe(true);

        const deadResponse = await scheduler.fetch(get("/dead"));
        const { records } = await deadResponse.json<DeadListBody>();

        expect(records.map((record) => record.id)).toEqual([id]);
        expect(records[0]?.attempts).toBe(3);
    });

    it("recovers within budget: a transient failure retries once, then succeeds and is never dead-lettered", async () => {
        expect.assertions(4);

        const catcher = await createCatcher(1); // fails exactly once, then succeeds
        activeCatchers.push(catcher);

        const state = createFakeSchedulerState();
        const scheduler = new WebhookDeliverySchedulerDO(state, { LUNORA_ORIGIN_URL: "https://example.test" }, catcher.url);

        await scheduler.fetch(
            post("/schedule", {
                args: { orderId: "ord_2" },
                functionPath: "webhooks:deliver",
                retry: { backoff: "linear", baseMs: 20, maxAttempts: 3 },
                scheduledFor: Date.now(),
            }),
        );

        await scheduler.alarm(); // fails, retry scheduled
        await sleep(50);
        await scheduler.alarm(); // succeeds

        expect(scheduler.deliveryAttempts).toBe(2);
        expect(catcher.deliveries.map((delivery) => delivery.ok)).toEqual([false, true]);

        const deadResponse = await scheduler.fetch(get("/dead"));
        const { records: deadRecords } = await deadResponse.json<DeadListBody>();

        expect(deadRecords).toHaveLength(0);

        const listResponse = await scheduler.fetch(get("/list"));
        const { records: liveRecords } = await listResponse.json<DeadListBody>();

        expect(liveRecords).toHaveLength(0); // delivered — nothing left pending
    });

    it("a dead-lettered delivery can be manually redriven (the Studio dead-letter-jobs panel's `POST /dead/retry`)", async () => {
        expect.assertions(3);

        const catcher = await createCatcher(Number.POSITIVE_INFINITY); // dead-letters fast
        activeCatchers.push(catcher);

        const state = createFakeSchedulerState();
        const scheduler = new WebhookDeliverySchedulerDO(state, { LUNORA_ORIGIN_URL: "https://example.test" }, catcher.url);

        const scheduleResponse = await scheduler.fetch(
            post("/schedule", {
                args: { orderId: "ord_3" },
                functionPath: "webhooks:deliver",
                retry: { backoff: "linear", baseMs: 10, maxAttempts: 1 },
                scheduledFor: Date.now(),
            }),
        );
        const { id } = await scheduleResponse.json<{ id: string }>();

        await scheduler.alarm(); // attempt 1 fails → retry scheduled
        await sleep(40);
        await scheduler.alarm(); // attempt 2 fails → attempts(2) > maxAttempts(1) → dead-lettered

        const deadBeforeResponse = await scheduler.fetch(get("/dead"));
        const deadBefore = await deadBeforeResponse.json<DeadListBody>();

        expect(deadBefore.records.map((record) => record.id)).toEqual([id]);

        // The operator fixes the downstream endpoint, then redrives from Studio.
        catcher.forceSuccess();

        const retryResponse = await scheduler.fetch(post("/dead/retry", { id }));
        const retryBody = await retryResponse.json<{ retried: boolean }>();

        expect(retryBody.retried).toBe(true);

        await scheduler.alarm(); // redriven job is due immediately → succeeds this time

        const deadAfterResponse = await scheduler.fetch(get("/dead"));
        const deadAfter = await deadAfterResponse.json<DeadListBody>();

        expect(deadAfter.records).toHaveLength(0);
    });
});
