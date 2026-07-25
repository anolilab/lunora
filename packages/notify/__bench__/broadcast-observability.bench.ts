import type { Provider, PushPayload } from "@visulima/notification";
import { createNotification } from "@visulima/notification";
import { bench, describe } from "vitest";

import { createNotify } from "../src/notify";
import { memorySubscriptionStore } from "../src/subscriptions/memory-store";
import type { NotifyDefinition, SubscriptionStore } from "../src/types";

/**
 * Prices the observability overhead the facade itself adds to a broadcast — the
 * `observeSend` attribute-object construction and the per-recipient call
 * dispatch — by comparing an INSTRUMENTED facade (no-op `log`/`metrics` handles)
 * against a BASELINE with no handles at all. With no handles, `metrics?.count(…)`
 * short-circuits before its argument object is even built, so the delta is
 * exactly the facade's added cost, isolated from what `ctx.metrics`/`ctx.log`
 * spend downstream (see `packages/do/__bench__/metrics-emit.bench.ts` — the
 * durable metric write is ~19µs/call).
 *
 * A broadcast aggregates its `notify.send` counts into one emit per (kind,
 * status) bucket, so it pays that ~19µs downstream cost ≤ kinds×3 times, not
 * once per recipient — the metric attribute-object work measured here is the
 * only per-recipient observability cost that remains.
 *
 * `all-fail` additionally exercises the per-failure `log.warn` path (still
 * O(failures) — the failure log stays per-recipient, since it has no SQLite
 * write and carries the ids for debugging).
 */
const N = 200;

const noopLog = { warn: () => undefined };
const noopMetrics = { count: () => undefined };

/** A non-recording push provider whose outcome is fixed (no per-send array growth to skew the reading). */
const pushProvider = (outcome: "fail" | "ok"): Provider<unknown, PushPayload> => {
    return {
        channel: "push",
        id: "bench-push",
        initialize: () => undefined,
        isAvailable: () => true,
        send: () =>
            outcome === "ok"
                ? { data: { messageId: "m", sent: true, timestamp: new Date() }, success: true }
                : { error: new Error("503 transient upstream error"), success: false },
    };
};

const definition = (store: SubscriptionStore): NotifyDefinition => {
    return {
        isLunoraNotify: true,
        store: () => store,
        webPush: { vapidPrivateKey: "d", vapidPublicKey: "p", vapidSubject: "mailto:a@b.c" },
    };
};

/** Build a facade over a store pre-loaded with N web-push subscriptions. Neither the ok nor the 503 path deletes, so the store stays stable across bench iterations. */
const buildFacade = async (outcome: "fail" | "ok", handles: { log?: typeof noopLog; metrics?: typeof noopMetrics }) => {
    const store = memorySubscriptionStore();
    const engine = createNotification({ push: pushProvider(outcome) });
    const facade = createNotify(definition(store), {}, { engine, silent: true, ...handles });

    for (let index = 0; index < N; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- one-time bench setup, not a hot path
        await facade.push.register({ subscription: { endpoint: `https://push.example/ok-${String(index)}`, keys: { auth: "a", p256dh: "p" } } });
    }

    return facade;
};

const okBaseline = await buildFacade("ok", {});
const okInstrumented = await buildFacade("ok", { log: noopLog, metrics: noopMetrics });
const failBaseline = await buildFacade("fail", {});
const failInstrumented = await buildFacade("fail", { log: noopLog, metrics: noopMetrics });

const payload = { body: "New drop", title: "News" };

describe(`ctx.push.broadcast — observability overhead (${String(N)} subscriptions)`, () => {
    // ok: instrumented − baseline = the metric-emit facade overhead per recipient.
    bench("all-ok, no observability handles (baseline)", async () => {
        await okBaseline.push.broadcast(payload);
    });

    bench("all-ok, instrumented (no-op log + metrics)", async () => {
        await okInstrumented.push.broadcast(payload);
    });

    // fail: instrumented − baseline = the per-failure warn-path facade overhead.
    // (Both fail cases are far slower than ok, but that gap is the ENGINE's error
    // handling — Error construction + receiptError/isGoneError — not observability.)
    bench("all-fail, no observability handles (baseline)", async () => {
        await failBaseline.push.broadcast(payload);
    });

    bench("all-fail, instrumented (per-failure warn path)", async () => {
        await failInstrumented.push.broadcast(payload);
    });
});
