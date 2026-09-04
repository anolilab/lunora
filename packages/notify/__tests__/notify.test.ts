import type { Notification, Receipt } from "@visulima/notification";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNotify } from "../src/notify";
import { routingPushProvider } from "../src/providers";
import { d1SubscriptionStore } from "../src/subscriptions/d1-store";
import { memorySubscriptionStore } from "../src/subscriptions/memory-store";
import { legacyWebPushId } from "../src/subscriptions/normalize";
import type { NotifyDefinition, SubscriptionStore } from "../src/types";
import { fakeD1, FCM_DEAD_TOKEN_ERROR, mockChatProvider, mockEngine, mockPushProvider, mockThrowingPushProvider } from "./helpers";

const baseDefinition = (store: SubscriptionStore, chat = false): NotifyDefinition => {
    return {
        isLunoraNotify: true,
        store: () => store,
        webPush: { vapidPrivateKey: "d", vapidPublicKey: "p", vapidSubject: "mailto:a@b.c" },
        ...(chat ? { chat: () => mockChatProvider() } : {}),
    };
};

const setup = (options?: { chat?: boolean; concurrency?: number }) => {
    const store = memorySubscriptionStore();
    const push = mockPushProvider();
    const engine = mockEngine({ chat: options?.chat === true ? mockChatProvider() : undefined, push: push.provider });
    const facade = createNotify(baseDefinition(store, options?.chat), {}, { concurrency: options?.concurrency, engine, silent: true });

    return { ...facade, engine, sends: push.sends, store };
};

const okSub = { endpoint: "https://push.example/ok", keys: { auth: "a", p256dh: "p" } };
const goneSub = { endpoint: "https://push.example/gone", keys: { auth: "a", p256dh: "p" } };
const failSub = { endpoint: "https://push.example/fail", keys: { auth: "a", p256dh: "p" } };

describe("ctx.push lifecycle", () => {
    it("registers and lists subscriptions", async () => {
        expect.hasAssertions();

        const { push } = setup();
        const stored = await push.register({ subscription: okSub, userId: "u1" });

        expect(stored.kind).toBe("web-push");
        await expect(push.list()).resolves.toHaveLength(1);
        await expect(push.list({ userId: "u1" })).resolves.toHaveLength(1);
    });

    it("list strips the delivery secrets (keys / token)", async () => {
        expect.hasAssertions();

        const { push, store } = setup();

        await push.register({ subscription: okSub, userId: "u1" });
        await push.register({ kind: "fcm", token: "device-token-xyz", userId: "u2" });

        for (const surface of [await push.list()]) {
            expect(surface).toHaveLength(2);

            for (const device of surface) {
                // The register() call stored keys/token; the facade must never surface them.
                expect(device).not.toHaveProperty("keys");
                expect(device).not.toHaveProperty("token");
            }

            // The non-secret fields the admin page renders survive the projection.
            expect(surface.find((device) => device.kind === "web-push")).toMatchObject({ endpoint: okSub.endpoint, userId: "u1" });
            expect(surface.find((device) => device.kind === "fcm")).toMatchObject({ kind: "fcm", userId: "u2" });
        }

        // The projection is a facade concern: the raw store row still carries the
        // secrets (only the internal SubscriptionStore, which handlers don't hold,
        // can read them — the broadcast path uses it directly).
        const raw = await store.list();

        expect(raw.find((row) => row.kind === "web-push")?.keys).toStrictEqual({ auth: "a", p256dh: "p" });
        expect(raw.find((row) => row.kind === "fcm")?.token).toBe("device-token-xyz");
    });

    it("send to a registered subscription marks it ok", async () => {
        expect.hasAssertions();

        const { push, sends, store } = setup();
        const stored = await push.register({ subscription: okSub });
        const receipt = await push.send(stored.id, { body: "hi", title: "t" });

        expect(receipt.successful).toBe(true);
        expect(sends).toHaveLength(1);
        expect(sends[0]).toMatchObject({ body: "hi", title: "t" });
        await expect(store.get(stored.id)).resolves.toMatchObject({ lastStatus: "ok" });
    });

    it("prunes a subscription the push service reports as gone", async () => {
        expect.hasAssertions();

        const { push, store } = setup();
        const stored = await push.register({ subscription: goneSub });
        const receipt = await push.send(stored.id, { body: "hi" });

        expect(receipt.successful).toBe(false);
        await expect(store.get(stored.id)).resolves.toBeUndefined();
    });

    it("prunes an FCM device the way FCM actually reports one — a NOT_FOUND message, no code", async () => {
        expect.hasAssertions();

        // The FCM provider forwards `body.error.message` and drops
        // `error.details[].errorCode`, so `UNREGISTERED` never reaches us — the
        // NOT_FOUND prose is the whole signal (see `FCM_DEAD_TOKEN_ERROR`). This
        // is the pruning the README, the docs and `LunoraPush.broadcast`'s JSDoc
        // all promise for FCM.
        const { push, store } = setup();
        const stored = await push.register({ kind: "fcm", token: "gone-device-token" });
        const receipt = await push.send(stored.id, { body: "hi" });

        expect(receipt.successful).toBe(false);
        expect(receipt.successful ? [] : receipt.errorMessages).toContain(FCM_DEAD_TOKEN_ERROR);
        await expect(store.get(stored.id)).resolves.toBeUndefined();
    });

    it("counts a dead FCM token as pruned, not failed, in a broadcast", async () => {
        expect.hasAssertions();

        const { push } = setup();

        await push.register({ kind: "fcm", token: "gone-device-token" });

        const result = await push.broadcast({ body: "hi" });

        expect(result).toMatchObject({ failed: 0, pruned: 1, sent: 0, total: 1 });
    });

    it("throws sending to an unknown subscription id", async () => {
        expect.hasAssertions();

        const { push } = setup();

        await expect(push.send("nope", { body: "x" })).rejects.toThrow(/no registered subscription/u);
    });

    it("unregisters the caller's own subscription", async () => {
        expect.hasAssertions();

        const { push, store } = setup();
        const stored = await push.register({ subscription: okSub, userId: "u1" });

        await push.unregister(stored.id, { userId: "u1" });

        await expect(store.get(stored.id)).resolves.toBeUndefined();
    });

    it("refuses to re-own another user's subscription through register (IDOR, the register half)", async () => {
        expect.hasAssertions();

        // The mirror image of the `unregister` guard below: the id is derived from
        // the endpoint, so a caller who can guess or observe a victim's endpoint
        // could re-register it under their own userId with garbage keys — taking the
        // device dark (every later send fails encryption, which is not a gone signal,
        // so it is never pruned either) and handing the attacker `unregister` over it.
        const { push, store } = setup();
        const victim = await push.register({ subscription: okSub, userId: "victim" });

        await expect(push.register({ subscription: { endpoint: okSub.endpoint, keys: { auth: "AAAA", p256dh: "AAAA" } }, userId: "attacker" })).rejects.toThrow(
            /registered to a different user/u,
        );

        await expect(store.get(victim.id)).resolves.toMatchObject({ keys: okSub.keys, userId: "victim" });
    });

    it("lets the same owner re-register (a routine service-worker key refresh)", async () => {
        expect.hasAssertions();

        const { push, store } = setup();
        const first = await push.register({ subscription: okSub, userId: "u1" });

        await push.register({ subscription: { endpoint: okSub.endpoint, keys: { auth: "a2", p256dh: "p2" } }, userId: "u1" });

        await expect(store.get(first.id)).resolves.toMatchObject({ keys: { auth: "a2", p256dh: "p2" }, userId: "u1" });
    });

    it("lets an anonymous row be claimed, but not an owned one un-owned", async () => {
        expect.hasAssertions();

        const { push, store } = setup();
        const anonymous = await push.register({ subscription: okSub });

        // Unowned → claimable: the device signed in.
        await push.register({ subscription: okSub, userId: "u1" });

        await expect(store.get(anonymous.id)).resolves.toMatchObject({ userId: "u1" });

        // Owned → an anonymous register must not strip the owner off it.
        await expect(push.register({ subscription: okSub })).rejects.toThrow(/registered to a different user/u);
        await expect(store.get(anonymous.id)).resolves.toMatchObject({ userId: "u1" });
    });

    it("does not let a register delete another user's legacy-id row", async () => {
        expect.hasAssertions();

        // The legacy (`wp_`) row for the SAME device has a different primary key, so
        // the guarded upsert never touches it — the migration eviction is a separate
        // DELETE, and an unscoped one silenced the victim's device just as well.
        const { push, store } = setup();
        const legacyId = legacyWebPushId(okSub.endpoint);

        await store.put({ createdAt: 1, endpoint: okSub.endpoint, id: legacyId, keys: okSub.keys, kind: "web-push", lastSeenAt: 1, userId: "victim" });

        await push.register({ subscription: okSub, userId: "attacker" });

        await expect(store.get(legacyId)).resolves.toMatchObject({ userId: "victim" });
    });

    it("leaves another user's subscription in place (IDOR: the id is a caller-controlled key)", async () => {
        expect.hasAssertions();

        // A subscription id is `webPushId(endpoint)` — derived from a value the
        // client supplies as `replacedEndpoint` after a VAPID rotation. Deleting
        // by id alone let any caller who could guess or observe another user's
        // endpoint silence that device (CWE-639).
        const { push, store } = setup();
        const victim = await push.register({ subscription: okSub, userId: "victim" });

        await push.unregister(victim.id, { userId: "attacker" });

        await expect(store.get(victim.id)).resolves.toMatchObject({ userId: "victim" });
    });

    it("keeps an owned row and an anonymous row apart", async () => {
        expect.hasAssertions();

        // `undefined` and `null` are the same anonymous bucket (that is how the
        // store's own `userId` filter reads them), and an anonymous caller must
        // not reach a row someone signed in registered.
        const { push, store } = setup();
        const owned = await push.register({ subscription: okSub, userId: "u1" });
        const anonymous = await push.register({ subscription: goneSub });

        await push.unregister(owned.id, { userId: undefined });

        await expect(store.get(owned.id)).resolves.toMatchObject({ userId: "u1" });

        await push.unregister(anonymous.id, { userId: null });

        await expect(store.get(anonymous.id)).resolves.toBeUndefined();
    });

    // A read-then-write `unregister` (a `get` that checks the owner, then a
    // `delete` that acts on it) can have the row replaced in between: the check
    // passes for the caller and the removal lands on whoever re-registered.
    //
    // There is no way to stage that interleave against the fixed code, and that
    // IS the fix — the window has no interior to schedule into. So this pins the
    // two halves that make it true: the call reads nothing before writing, and
    // the removal is conditional on the owner the row carries at deletion time.
    // The store below would expose a read if one happened, by re-registering the
    // id to someone else the moment anything calls `get`.
    it("removes nothing by reading first — the owner check IS the delete", async () => {
        expect.hasAssertions();

        const backing = memorySubscriptionStore();
        const gets: string[] = [];
        const owned: [string, string | null][] = [];
        const racing = {
            ...backing,
            deleteOwned: async (id: string, userId: string | null) => {
                owned.push([id, userId]);

                return backing.deleteOwned(id, userId);
            },
            get: async (id: string) => {
                gets.push(id);

                const current = await backing.get(id);

                if (current !== undefined) {
                    await backing.put({ ...current, userId: "second-owner" });
                }

                return current;
            },
        };

        const providerMock = mockPushProvider();
        const { push } = createNotify(baseDefinition(racing), {}, { engine: mockEngine({ push: providerMock.provider }), silent: true });
        const stored = await push.register({ subscription: okSub, userId: "first-owner" });

        gets.length = 0;

        await push.unregister(stored.id, { userId: "first-owner" });

        // Nothing was read, so nothing could go stale between the check and the
        // removal — the store was asked one owner-scoped question.
        expect(gets).toStrictEqual([]);
        expect(owned).toStrictEqual([[stored.id, "first-owner"]]);
        await expect(backing.get(stored.id)).resolves.toBeUndefined();
    });

    it("is a silent no-op for an id that was never registered", async () => {
        expect.hasAssertions();

        // Same answer, and the same absence of a write, as a row owned by
        // someone else — so the call cannot be used to probe which endpoints
        // exist.
        const { push } = setup();

        await expect(push.unregister("nope", { userId: "u1" })).resolves.toBeUndefined();
    });
});

describe("ctx.push.broadcast", () => {
    it("fans out, counts outcomes and prunes gone subscriptions", async () => {
        expect.hasAssertions();

        const { push, store } = setup();
        await push.register({ subscription: okSub });
        await push.register({ subscription: goneSub });
        await push.register({ subscription: failSub });

        const result = await push.broadcast({ body: "broadcast", title: "News" });

        expect(result.total).toBe(3);
        expect(result.sent).toBe(1);
        expect(result.pruned).toBe(1);
        expect(result.failed).toBe(1);

        // gone pruned, ok + failed remain
        await expect(store.list()).resolves.toHaveLength(2);
    });

    it("spends exactly one POST on a permanently gone subscription", async () => {
        expect.hasAssertions();

        // A 410 is the facade's cue to DELETE the row. Retrying it three more times
        // POSTs to an endpoint that is definitionally dead — four requests and the
        // full backoff per device, on every broadcast, for as long as the device
        // stays registered (which, before FCM pruning worked, was forever).
        const { push, sends } = setup();

        await push.register({ subscription: goneSub });
        await push.broadcast({ body: "hi" });

        expect(sends).toHaveLength(1);
    });

    it("keeps delivering — and keeps other channels alive — when several devices are dead", async () => {
        expect.hasAssertions();

        // Two dead devices used to be enough: the engine-wide breaker counted their
        // retry attempts, opened after five consecutive failures, and then answered
        // `Circuit open` for EVERY channel in the isolate for 30 s. The second dead
        // device's own result became `Circuit open` too — not a gone signal, so it
        // survived the prune and did it all again next time.
        const { notify, push } = setup({ chat: true, concurrency: 1 });

        for (const index of [1, 2, 3]) {
            // eslint-disable-next-line no-await-in-loop -- registration order fixes the broadcast order this assertion depends on
            await push.register({ subscription: { endpoint: `https://push.example/gone-${index.toString()}`, keys: { auth: "a", p256dh: "p" } } });
        }

        await push.register({ subscription: okSub });

        const result = await push.broadcast({ body: "hi" });

        expect(result).toMatchObject({ failed: 0, pruned: 3, sent: 1, total: 4 });
        await expect(notify.chat({ text: "still up" })).resolves.toMatchObject({ successful: true });
    });

    it("still opens a circuit for a provider that is genuinely failing, and only that provider", async () => {
        expect.hasAssertions();

        // The breaker must keep doing its job for real outages — five consecutive
        // TRANSIENT failures still shed load — while a sibling channel is untouched.
        const { notify, push, sends } = setup({ chat: true, concurrency: 1 });

        for (const index of [1, 2, 3, 4, 5, 6]) {
            // eslint-disable-next-line no-await-in-loop -- registration order fixes the broadcast order this assertion depends on
            await push.register({ subscription: { endpoint: `https://push.example/fail-${index.toString()}`, keys: { auth: "a", p256dh: "p" } } });
        }

        const result = await push.broadcast({ body: "hi" }, { limit: 6 });

        expect(result.failed).toBe(6);
        // 5 devices × 4 attempts trips the breaker; the 6th never reaches the provider.
        expect(sends.length).toBeLessThan(24);
        await expect(notify.chat({ text: "still up" })).resolves.toMatchObject({ successful: true });
    });

    it("respects a userId filter", async () => {
        expect.hasAssertions();

        const { push, sends } = setup();
        await push.register({ subscription: okSub, userId: "u1" });
        await push.register({ subscription: { endpoint: "https://push.example/ok2", keys: { auth: "a", p256dh: "p" } }, userId: "u2" });

        const result = await push.broadcast({ body: "hi" }, { userId: "u1" });

        expect(result.total).toBe(1);
        expect(sends).toHaveLength(1);
    });
});

describe("ctx.push.broadcast pagination (plan 222 / NOTIFY-01)", () => {
    const pageSize = 5;

    const setupPaged = () => {
        const store = memorySubscriptionStore();
        const push = mockPushProvider();
        const engine = mockEngine({ push: push.provider });
        const facade = createNotify(baseDefinition(store), {}, { broadcastPageSize: pageSize, engine, silent: true });

        return { ...facade, engine, sends: push.sends, store };
    };

    // Regression: `broadcastPageSize` lived ONLY on `createNotify`'s third
    // argument, and the sole production call is codegen's fixed `{ log, metrics }`
    // — so `ctx.push.broadcast` was pinned at 250 per round trip forever, while
    // `SubscriptionFilter.limit`'s own docs pointed at this knob as the way to
    // size pages. It is settable on `defineNotify` now, which apps can reach.
    it("takes broadcastPageSize from the defineNotify definition", async () => {
        expect.hasAssertions();

        const store = memorySubscriptionStore();
        const provider = mockPushProvider();
        const { push } = createNotify(
            { ...baseDefinition(store), broadcastPageSize: 2 },
            {},
            { engine: mockEngine({ push: provider.provider }), silent: true },
        );

        for (let index = 0; index < 5; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential registration in a test
            await push.register({ subscription: { endpoint: `https://push.example/def/${index.toString()}`, keys: { auth: "a", p256dh: "p" } } });
        }

        const page = await push.broadcastPage({ body: "bulk", title: "t" });

        // One page is the definition's 2, not the 250 default.
        expect(page.result.total).toBe(2);
        expect(page.nextCursor).toBeDefined();
    });

    it("a broadcast over pageSize + 10 fakes visits every one across >= 2 pages", async () => {
        expect.hasAssertions();

        const { push, store } = setupPaged();
        const total = pageSize + 10;

        for (let index = 0; index < total; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential registration in a test
            await push.register({ subscription: { endpoint: `https://push.example/bulk/${index.toString()}`, keys: { auth: "a", p256dh: "p" } } });
        }

        const listSpy = vi.spyOn(store, "list");
        const result = await push.broadcast({ body: "bulk", title: "t" });

        expect(result.total).toBe(total);
        expect(result.sent).toBe(total);
        // A single page (pageSize=5) could never cover `total`=15 fakes — proves
        // the walk spanned multiple pages, not one big unbounded list().
        expect(listSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("broadcast({ limit }) caps the CUMULATIVE audience across pages, not per page", async () => {
        expect.hasAssertions();

        const { push, store } = setupPaged();
        const total = pageSize + 10; // audience bigger than the cap, spanning multiple pages
        const limit = pageSize + 2; // bigger than one page, so the walk must still span >= 2 pages

        for (let index = 0; index < total; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential registration in a test
            await push.register({ subscription: { endpoint: `https://push.example/cap/${index.toString()}`, keys: { auth: "a", p256dh: "p" } } });
        }

        const result = await push.broadcast({ body: "capped", title: "t" }, { limit });

        // Reaches EXACTLY `limit` subscriptions overall — not `limit` PER PAGE
        // (which would deliver to the whole `total` audience across pages).
        expect(result.total).toBe(limit);
        expect(result.sent).toBe(limit);

        const ids = result.outcomes.map((outcome) => outcome.id);

        expect(new Set(ids).size).toBe(limit);

        // The rest of the audience was registered but never delivered to.
        await expect(store.list()).resolves.toHaveLength(total);
    });

    it("broadcastPage returns one bounded page plus a resumable nextCursor", async () => {
        expect.hasAssertions();

        const { push } = setupPaged();

        for (let index = 0; index < pageSize + 2; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential registration in a test
            await push.register({ subscription: { endpoint: `https://push.example/page/${index.toString()}`, keys: { auth: "a", p256dh: "p" } } });
        }

        const first = await push.broadcastPage({ body: "p1" });

        expect(first.result.total).toBe(pageSize);
        expect(first.nextCursor).toBeDefined();

        const second = await push.broadcastPage({ body: "p2" }, { after: first.nextCursor });

        expect(second.result.total).toBe(2);
        expect(second.nextCursor).toBeUndefined();

        // No overlap between the two pages' delivered subscription ids.
        const firstIds = new Set(first.result.outcomes.map((outcome) => outcome.id));

        for (const outcome of second.result.outcomes) {
            expect(firstIds.has(outcome.id)).toBe(false);
        }
    });

    it("a job carrying a cursor (job.filter.after) resumes exactly where the previous page left off", async () => {
        expect.hasAssertions();

        const { push } = setupPaged();

        for (let index = 0; index < pageSize + 3; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential registration in a test
            await push.register({ subscription: { endpoint: `https://push.example/resume/${index.toString()}`, keys: { auth: "a", p256dh: "p" } } });
        }

        const firstPage = await push.broadcastPage({ body: "hi" });

        expect(firstPage.nextCursor).toBeDefined();

        // Simulate a queue job carrying the cursor forward (see `runPushBroadcastPage`).
        const resumed = await push.broadcastPage({ body: "hi" }, { after: firstPage.nextCursor });

        expect(resumed.result.total).toBe(3);
        expect(resumed.nextCursor).toBeUndefined();
    });

    it("a store that ignores `after` (unpaged fallback) terminates and never double-delivers", async () => {
        expect.hasAssertions();

        const backing = memorySubscriptionStore();
        // A non-cursoring store: `list` always returns the same (from-the-top)
        // window regardless of `filter.after` — the documented fallback case.
        // `broadcastPage`'s defensive re-filter is what has to keep this correct.
        const nonCursoringStore = {
            ...backing,
            list: (filter?: Parameters<typeof backing.list>[0]) => backing.list({ kind: filter?.kind, limit: filter?.limit, userId: filter?.userId }),
        };

        const providerMock = mockPushProvider();
        const { push } = createNotify(
            baseDefinition(nonCursoringStore),
            {},
            { broadcastPageSize: pageSize, engine: mockEngine({ push: providerMock.provider }), silent: true },
        );

        const total = pageSize + 10;

        for (let index = 0; index < total; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential registration in a test
            await push.register({ subscription: { endpoint: `https://push.example/nocursor/${index.toString()}`, keys: { auth: "a", p256dh: "p" } } });
        }

        // Must resolve (not hang/loop forever) — the real assertion is that the
        // promise settles at all within the test's timeout.
        const result = await push.broadcast({ body: "hi" });

        // A non-cursoring store can't be trusted to deliver the FULL matched
        // audience (see `SubscriptionFilter.after`'s documented fallback limit),
        // but it must never double-deliver: every delivered id is distinct, and
        // it can't exceed the registered total.
        const ids = result.outcomes.map((outcome) => outcome.id);

        expect(new Set(ids).size).toBe(ids.length);
        expect(result.total).toBeGreaterThan(0);
        expect(result.total).toBeLessThanOrEqual(total);
    });
});

describe("ctx.push.broadcast zero/negative limit (plan 279)", () => {
    it("broadcast({ limit: 0 }) delivers to nobody and returns the all-zero aggregate", async () => {
        expect.hasAssertions();

        const { push, sends } = setup();

        await push.register({ subscription: okSub });
        await push.register({ subscription: { endpoint: "https://push.example/ok2", keys: { auth: "a", p256dh: "p" } } });

        const result = await push.broadcast({ body: "zero", title: "t" }, { limit: 0 });

        expect(sends).toHaveLength(0);
        expect(result).toStrictEqual({ failed: 0, outcomes: [], pruned: 0, sent: 0, total: 0 });
    });

    it("broadcast({ limit: -5 }) behaves the same as limit: 0 (negative limits deliver to nobody)", async () => {
        expect.hasAssertions();

        const { push, sends } = setup();

        await push.register({ subscription: okSub });

        const result = await push.broadcast({ body: "negative", title: "t" }, { limit: -5 });

        expect(sends).toHaveLength(0);
        expect(result).toStrictEqual({ failed: 0, outcomes: [], pruned: 0, sent: 0, total: 0 });
    });

    it("broadcastPage({ limit: 0 }) delivers nothing and returns no nextCursor", async () => {
        expect.hasAssertions();

        const { push, sends } = setup();

        await push.register({ subscription: okSub });

        const page = await push.broadcastPage({ body: "zero-page", title: "t" }, { limit: 0 });

        expect(sends).toHaveLength(0);
        expect(page.nextCursor).toBeUndefined();
        expect(page.result).toStrictEqual({ failed: 0, outcomes: [], pruned: 0, sent: 0, total: 0 });
    });

    it("a zero-limit broadcast does NOT emit the no-subscriptions-matched skip metric", async () => {
        expect.hasAssertions();

        const store = memorySubscriptionStore();
        const pushProvider = mockPushProvider();
        const engine = mockEngine({ push: pushProvider.provider });
        const metrics = { count: vi.fn() };
        const { push } = createNotify(baseDefinition(store), {}, { engine, metrics, silent: true });

        // A matching subscription exists — the walk is skipped because the
        // caller asked for nobody, NOT because nothing matched the filter.
        await push.register({ subscription: okSub });

        const result = await push.broadcast({ body: "zero", title: "t" }, { limit: 0 });

        expect(result.total).toBe(0);
        expect(metrics.count).not.toHaveBeenCalledWith("notify.skipped", 1, { channel: "push", reason: "no-subscriptions-matched" });
    });

    it("broadcast({ limit: 1 }) still delivers exactly one recipient (the boundary above zero)", async () => {
        expect.hasAssertions();

        const { push, sends } = setup();

        await push.register({ subscription: okSub });
        await push.register({ subscription: { endpoint: "https://push.example/ok2", keys: { auth: "a", p256dh: "p" } } });

        const result = await push.broadcast({ body: "one", title: "t" }, { limit: 1 });

        expect(result.total).toBe(1);
        expect(result.sent).toBe(1);
        expect(sends).toHaveLength(1);
    });
});

describe("ctx.push.broadcast fault-tolerance", () => {
    const webPushSub = (suffix: string) => {
        return { endpoint: `https://push.example/${suffix}`, keys: { auth: "a", p256dh: "p" } };
    };

    it("a throwing recipient does not abort the fan-out — others still deliver", async () => {
        expect.hasAssertions();

        const store = memorySubscriptionStore();
        const throwing = mockThrowingPushProvider();
        const { push } = createNotify(baseDefinition(store), {}, { engine: mockEngine({ push: throwing.provider }), silent: true });

        await push.register({ subscription: webPushSub("ok") });
        await push.register({ subscription: webPushSub("throw") });
        await push.register({ subscription: webPushSub("ok2") });

        const result = await push.broadcast({ body: "b", title: "t" });

        // The one throwing send is a single `failed` outcome; the fan-out completes.
        expect(result.total).toBe(3);
        expect(result.sent).toBe(2);
        expect(result.failed).toBe(1);
        expect(result.pruned).toBe(0);
        expect(result.outcomes.filter((outcome) => outcome.status === "failed")).toHaveLength(1);
    });

    it("degrades a recipient whose channel is not configured to failed — others succeed", async () => {
        expect.hasAssertions();

        const store = memorySubscriptionStore();
        // Only the web-push channel is wired; an FCM target hits the router's throw.
        const engine = mockEngine({ push: routingPushProvider({ webPush: mockPushProvider().provider }) });
        const { push } = createNotify(baseDefinition(store), {}, { engine, silent: true });

        await push.register({ subscription: webPushSub("ok") });
        await push.register({ kind: "fcm", token: "device-token-xyz" });

        const result = await push.broadcast({ body: "b" });

        expect(result.total).toBe(2);
        expect(result.sent).toBe(1);
        expect(result.failed).toBe(1);

        const failed = result.outcomes.find((outcome) => outcome.status === "failed");

        expect(failed?.error).toContain("`fcm` channel is configured");
    });

    it("a failing store write during broadcast does not abort the fan-out", async () => {
        expect.hasAssertions();

        // The delivery succeeds but the follow-up `markStatus` UPDATE throws — a
        // transient store error must not reject the fan-out or the accepted send.
        const store = d1SubscriptionStore(fakeD1({ failOn: "UPDATE" }));
        const provider = mockPushProvider();
        const { push } = createNotify(baseDefinition(store), {}, { engine: mockEngine({ push: provider.provider }), silent: true });

        await push.register({ subscription: webPushSub("ok") });

        const result = await push.broadcast({ body: "b" });

        expect(result.total).toBe(1);
        expect(result.sent).toBe(1);
        expect(result.failed).toBe(0);
    });
});

describe("ctx.notify multi-channel", () => {
    it("delivers a multi-channel message through the engine", async () => {
        expect.hasAssertions();

        const { notify } = setup({ chat: true });
        const receipts = await notify.send({ chat: { text: "hello" }, push: { body: "b", to: "https://push.example/ok-target" } });

        expect(receipts.every((receipt) => receipt.successful)).toBe(true);
    });

    it("throws when using an unconfigured channel", async () => {
        expect.hasAssertions();

        const { notify } = setup();

        await expect(notify.chat({ text: "x" })).rejects.toThrow(/"chat" channel is not configured/u);
    });

    it("exposes the same push object on ctx.notify.push and ctx.push", () => {
        expect.hasAssertions();

        const { notify, push } = setup();

        expect(notify.push).toBe(push);
    });
});

describe("createNotify per-isolate memoization", () => {
    it("builds the engine once per isolate across repeated createNotify calls", () => {
        expect.hasAssertions();

        // No `options.engine` override, so the real engine is built from the config.
        // A counting `webPush` thunk proves `buildEngine`/provider resolution runs
        // exactly once even though `createNotify` is invoked per (simulated) request.
        let builds = 0;
        const env = {};
        const store = memorySubscriptionStore();
        const definition: NotifyDefinition = {
            isLunoraNotify: true,
            store: () => store,
            webPush: () => {
                builds += 1;

                return { vapidPrivateKey: "d", vapidPublicKey: "p", vapidSubject: "mailto:a@b.c" };
            },
        };

        createNotify(definition, env, { silent: true });
        createNotify(definition, env, { silent: true });
        createNotify(definition, env, { silent: true });

        expect(builds).toBe(1);
    });

    it("reuses one in-memory fallback store so a registration survives across calls", async () => {
        expect.hasAssertions();

        const env = {};
        const definition: NotifyDefinition = { isLunoraNotify: true, webPush: { vapidPrivateKey: "d", vapidPublicKey: "p", vapidSubject: "s" } };

        const first = createNotify(definition, env, { engine: mockEngine({ push: mockPushProvider().provider }), silent: true });

        await first.push.register({ subscription: okSub, userId: "u1" });

        // A second call in the SAME isolate (same definition + env) sees the earlier
        // registration — the fallback store is memoized, not re-created per request.
        const second = createNotify(definition, env, { engine: mockEngine({ push: mockPushProvider().provider }), silent: true });

        await expect(second.push.list()).resolves.toHaveLength(1);
        await expect(second.push.list({ userId: "u1" })).resolves.toHaveLength(1);
    });

    it("warns at most once per isolate when no store is configured", () => {
        expect.hasAssertions();

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const env = {};
        const push = mockPushProvider();
        const definition: NotifyDefinition = { isLunoraNotify: true, webPush: { vapidPrivateKey: "d", vapidPublicKey: "p", vapidSubject: "s" } };

        createNotify(definition, env, { engine: mockEngine({ push: push.provider }) });
        createNotify(definition, env, { engine: mockEngine({ push: push.provider }) });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("non-durable in-memory subscription store"));

        warn.mockRestore();
    });
});

describe("delivery observability (ctx.log + ctx.metrics)", () => {
    const setupObs = (options?: { chat?: boolean }) => {
        const store = memorySubscriptionStore();
        const push = mockPushProvider();
        const engine = mockEngine({ chat: options?.chat === true ? mockChatProvider() : undefined, push: push.provider });
        const log = { warn: vi.fn() };
        const metrics = { count: vi.fn() };
        const facade = createNotify(baseDefinition(store, options?.chat), {}, { engine, log, metrics, silent: true });

        return { ...facade, log, metrics, sends: push.sends, store };
    };

    it("counts an accepted push send and never logs a warning", async () => {
        expect.hasAssertions();

        const { log, metrics, push } = setupObs();
        const stored = await push.register({ subscription: okSub, userId: "u1" });

        await push.send(stored.id, { body: "hi", title: "t" });

        expect(metrics.count).toHaveBeenCalledWith("notify.send", 1, { channel: "push", provider: "web-push", status: "accepted" });
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("counts a failed push send with status=failed and logs a warning carrying the ids + error", async () => {
        expect.hasAssertions();

        const { log, metrics, push } = setupObs();
        const stored = await push.register({ subscription: failSub, userId: "u2" });

        await push.send(stored.id, { body: "hi" });

        expect(metrics.count).toHaveBeenCalledWith("notify.send", 1, { channel: "push", provider: "web-push", status: "failed" });
        expect(log.warn).toHaveBeenCalledWith(
            "notify push delivery failed",
            expect.objectContaining({ channel: "push", status: "failed", subscriptionId: stored.id, userId: "u2" }),
        );
    });

    it("counts a gone push send with status=gone and does not log (expected churn)", async () => {
        expect.hasAssertions();

        const { log, metrics, push } = setupObs();
        const stored = await push.register({ subscription: goneSub });

        await push.send(stored.id, { body: "hi" });

        expect(metrics.count).toHaveBeenCalledWith("notify.send", 1, { channel: "push", provider: "web-push", status: "gone" });
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("emits notify.skipped(no-subscriptions-matched) for a broadcast that reaches nobody", async () => {
        expect.hasAssertions();

        const { metrics, push } = setupObs();
        const result = await push.broadcast({ body: "nobody home", title: "t" });

        expect(result.total).toBe(0);
        expect(metrics.count).toHaveBeenCalledWith("notify.skipped", 1, { channel: "push", reason: "no-subscriptions-matched" });
        expect(metrics.count).not.toHaveBeenCalledWith("notify.send", 1, expect.anything());
    });

    it("aggregates broadcast notify.send into one count per status bucket, not per recipient", async () => {
        expect.hasAssertions();

        const { log, metrics, push } = setupObs();
        // 3 accepted, 2 failed, 1 gone — 6 recipients, one kind (web-push).
        for (const suffix of ["ok-1", "ok-2", "ok-3", "fail-1", "fail-2", "gone-1"]) {
            // eslint-disable-next-line no-await-in-loop -- sequential registration in a test
            await push.register({ subscription: { endpoint: `https://push.example/${suffix}`, keys: { auth: "a", p256dh: "p" } } });
        }

        await push.broadcast({ body: "drop", title: "News" });

        // ≤ kinds×3 aggregated counts — here exactly 3 (accepted/failed/gone),
        // NOT one per recipient — with the bucket total as the metric value.
        const sendCalls = metrics.count.mock.calls.filter((call) => call[0] === "notify.send");

        expect(sendCalls).toHaveLength(3);
        expect(metrics.count).toHaveBeenCalledWith("notify.send", 3, { channel: "push", provider: "web-push", status: "accepted" });
        expect(metrics.count).toHaveBeenCalledWith("notify.send", 2, { channel: "push", provider: "web-push", status: "failed" });
        expect(metrics.count).toHaveBeenCalledWith("notify.send", 1, { channel: "push", provider: "web-push", status: "gone" });
        // Failure LOGS stay per-recipient (the 2 failed; gone/accepted don't warn).
        expect(log.warn).toHaveBeenCalledTimes(2);
    });

    it("counts a configured channel send on notify.send with the receipt's provider", async () => {
        expect.hasAssertions();

        const { metrics, notify } = setupObs({ chat: true });

        await notify.chat({ text: "shipped" });

        // Pin the full dimension set — the channel path is where `provider` comes
        // off the receipt (mock-chat's id), exercising observeSend's provider path.
        expect(metrics.count).toHaveBeenCalledWith("notify.send", 1, { channel: "chat", provider: "mock-chat", status: "accepted" });
    });

    it("counts one notify.send per receipt for a multi-channel send, with the unknown fallback", async () => {
        expect.hasAssertions();

        // A fake engine returns receipts directly, including an UNLABELED failure
        // receipt — the only way to reach the `?? "unknown"` fallback, since a real
        // engine receipt always carries channel + provider.
        const receipts: Receipt[] = [
            { channel: "chat", messageId: "m1", provider: "slack", successful: true, timestamp: new Date() },
            { errorMessages: ["boom"], successful: false },
        ];
        const engine = { send: async () => receipts } as unknown as Notification;
        const log = { warn: vi.fn() };
        const metrics = { count: vi.fn() };
        const { notify } = createNotify(baseDefinition(memorySubscriptionStore()), {}, { engine, log, metrics, silent: true });

        const returned = await notify.send({ chat: { text: "hi" } });

        expect(returned).toBe(receipts);
        expect(metrics.count).toHaveBeenCalledWith("notify.send", 1, { channel: "chat", provider: "slack", status: "accepted" });
        expect(metrics.count).toHaveBeenCalledWith("notify.send", 1, { channel: "unknown", provider: "unknown", status: "failed" });
        expect(log.warn).toHaveBeenCalledWith(
            "notify unknown delivery failed",
            expect.objectContaining({ channel: "unknown", error: "boom", status: "failed" }),
        );
    });

    it("emits notify.skipped(channel-not-configured) and throws when the channel is unwired", async () => {
        expect.hasAssertions();

        const { metrics, notify } = setupObs();

        await expect(notify.inApp({ body: "x" } as never)).rejects.toThrow("not configured");
        expect(metrics.count).toHaveBeenCalledWith("notify.skipped", 1, { channel: "inapp", reason: "channel-not-configured" });
    });

    it("is a no-op when no log/metrics handles are threaded", async () => {
        expect.hasAssertions();

        const store = memorySubscriptionStore();
        const push = mockPushProvider();
        const engine = mockEngine({ push: push.provider });
        const { push: facade } = createNotify(baseDefinition(store), {}, { engine, silent: true });
        const stored = await facade.register({ subscription: okSub });

        // No observability handles → sends still succeed, nothing throws.
        await expect(facade.send(stored.id, { body: "hi" })).resolves.toMatchObject({ successful: true });
    });
});

describe("web Push SSRF-posture warning (unset allowedPushOrigins)", () => {
    const registerFacade = (definitionOverrides: Partial<NotifyDefinition> = {}) => {
        const store = memorySubscriptionStore();
        const push = mockPushProvider();
        const engine = mockEngine({ push: push.provider });
        // Fresh definition/env identity so the per-isolate one-shot guard starts clean;
        // NOT `silent`, so the warning is allowed to fire.
        const { push: facade } = createNotify({ ...baseDefinition(store), ...definitionOverrides }, {}, { engine });

        return facade;
    };

    it("warns exactly once per isolate when a web-push subscription registers without allowedPushOrigins", async () => {
        expect.hasAssertions();

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        try {
            const facade = registerFacade();

            await facade.register({ subscription: okSub, userId: "u1" });
            await facade.register({ subscription: goneSub, userId: "u2" });

            const originWarnings = warn.mock.calls.filter(([message]) => typeof message === "string" && message.includes("allowedPushOrigins"));

            expect(originWarnings).toHaveLength(1);
        } finally {
            warn.mockRestore();
        }
    });

    it("does not warn for an FCM registration (no client-controlled endpoint) or when allowedPushOrigins is set", async () => {
        expect.hasAssertions();

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        try {
            // FCM tokens carry no endpoint — the origin allowlist doesn't apply.
            await registerFacade().register({ kind: "fcm", token: "device-token-1", userId: "u1" });
            // A configured allowlist is the closed posture — no nudge.
            await registerFacade({ allowedPushOrigins: ["https://push.example"] }).register({ subscription: okSub, userId: "u2" });

            const originWarnings = warn.mock.calls.filter(([message]) => typeof message === "string" && message.includes("allowedPushOrigins"));

            expect(originWarnings).toHaveLength(0);
        } finally {
            warn.mockRestore();
        }
    });
});

describe("web-push send-time DNS-rebinding guard", () => {
    /** Stub Cloudflare DoH so `resolvePrivateAddress` sees `answers` for the A query. */
    const stubDoh = (answers: { data: string; type: number }[]) =>
        vi.stubGlobal("fetch", async (input: string) => {
            const type = Number(new URL(input).searchParams.get("type"));

            return {
                json: async () => {
                    return { Answer: type === 1 ? answers : [] };
                },
                ok: true,
            } as unknown as Response;
        });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // A public hostname resolving to an internal address passes the register-time
    // STRING classifier; only the resolved-address re-check at send time stops the
    // worker POSTing the payload into the private network.
    it("refuses to POST a payload to an endpoint whose host resolves private", async () => {
        expect.hasAssertions();

        // eslint-disable-next-line sonarjs/no-hardcoded-ip -- link-local fixture asserting the guard classifies it; no connection is made
        stubDoh([{ data: "169.254.169.254", type: 1 }]);

        const inner = mockPushProvider();
        const router = routingPushProvider({ webPush: inner.provider });

        await expect(
            router.send({
                body: "b",
                to: JSON.stringify({ endpoint: "https://169-254-169-254.sslip.io/p/1", keys: { auth: "a", p256dh: "p" } }),
            }),
        ).rejects.toThrow(/resolves to a private\/internal address/);

        // The payload never reached the transport.
        expect(inner.sends).toHaveLength(0);
    });

    it("checks EVERY target of a multi-recipient `to`, not just the first", async () => {
        expect.hasAssertions();

        // `notify.send()` hands a caller-shaped message straight to the engine, so a
        // multi-recipient push `to` reaches this router and the provider POSTs all of
        // them. Guarding only `to[0]` lets every later entry past the one place the
        // rebinding check is enforced.
        vi.stubGlobal("fetch", async (input: string) => {
            const { searchParams } = new URL(input);
            const isRebind = searchParams.get("name") === "169-254-169-254.sslip.io";
            const type = Number(searchParams.get("type"));

            return {
                json: async () => {
                    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- fixtures asserting the guard classifies them; no connection is made
                    return { Answer: type === 1 ? [{ data: isRebind ? "169.254.169.254" : "93.184.216.34", type: 1 }] : [] };
                },
                ok: true,
            } as unknown as Response;
        });

        const inner = mockPushProvider();
        const router = routingPushProvider({ webPush: inner.provider });
        const sub = (host: string) => JSON.stringify({ endpoint: `https://${host}/p`, keys: { auth: "a", p256dh: "p" } });

        await expect(
            // A public first target hides a rebinding second one.
            router.send({ body: "b", to: [sub("push.example"), sub("169-254-169-254.sslip.io")] }),
        ).rejects.toThrow(/resolves to a private\/internal address/);

        expect(inner.sends).toHaveLength(0);
    });

    it("refuses an empty `to` by name instead of blaming an unconfigured channel", async () => {
        expect.hasAssertions();

        // With no targets both routing branches fall through to the FCM one, so a
        // webPush-only app was told it "received an FCM token target but no `fcm`
        // channel is configured" — for a send that named no recipient at all.
        const inner = mockPushProvider();
        const router = routingPushProvider({ webPush: inner.provider });

        await expect(router.send({ body: "b", to: [] })).rejects.toThrow(/no recipients/u);
        expect(inner.sends).toHaveLength(0);
    });

    it("delivers when the host resolves public, and skips the check entirely under allowedPushOrigins", async () => {
        expect.hasAssertions();

        // eslint-disable-next-line sonarjs/no-hardcoded-ip -- public IP fixture so the guard passes
        stubDoh([{ data: "93.184.216.34", type: 1 }]);

        const inner = mockPushProvider();
        const target = JSON.stringify({ endpoint: "https://push.example/ok", keys: { auth: "a", p256dh: "p" } });

        await routingPushProvider({ webPush: inner.provider }).send({ body: "b", to: target });

        expect(inner.sends).toHaveLength(1);

        // With an exact-origin allowlist configured, no DoH round-trip happens at
        // all — the allowlist is the stronger guard and may name an internal host.
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        await routingPushProvider({ allowedPushOrigins: ["https://internal.push"], webPush: inner.provider }).send({
            body: "b",
            to: JSON.stringify({ endpoint: "https://internal.push/x", keys: { auth: "a", p256dh: "p" } }),
        });

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(inner.sends).toHaveLength(2);
    });
});

describe("mixed-kind push routing", () => {
    // `allowedPushOrigins` names the fixture origin so no DoH round-trip happens
    // and routing is the only behavior under test.
    const origins = { allowedPushOrigins: ["https://push.example"] };
    const sub = (path: string) => JSON.stringify({ endpoint: `https://push.example/${path}`, keys: { auth: "a", p256dh: "p" } });

    it("routes each target of a mixed `to` to its own provider", async () => {
        expect.hasAssertions();

        const webPush = mockPushProvider();
        const fcm = mockPushProvider();
        const router = routingPushProvider({ ...origins, fcm: fcm.provider, webPush: webPush.provider });

        const receipt = await router.send({ body: "b", to: [sub("ok"), "device-token-1"] });

        // Each provider sees ONLY its own kind — an FCM token must never reach
        // the Web Push transport (or the reverse).
        expect(webPush.sends).toHaveLength(1);
        expect(webPush.sends[0]?.to).toBe(sub("ok"));
        expect(fcm.sends).toHaveLength(1);
        expect(fcm.sends[0]?.to).toBe("device-token-1");
        expect(receipt.success).toBe(true);
    });

    it("passes a single-kind array through to one provider unchanged", async () => {
        expect.hasAssertions();

        const webPush = mockPushProvider();
        const fcm = mockPushProvider();
        const router = routingPushProvider({ ...origins, fcm: fcm.provider, webPush: webPush.provider });

        await router.send({ body: "b", to: [sub("one"), sub("two")] });
        await router.send({ body: "b", to: ["device-token-1", "device-token-2"] });

        expect(webPush.sends).toHaveLength(1);
        expect(webPush.sends[0]?.to).toStrictEqual([sub("one"), sub("two")]);
        expect(fcm.sends).toHaveLength(1);
        expect(fcm.sends[0]?.to).toStrictEqual(["device-token-1", "device-token-2"]);
    });

    it("carries both groups' message ids when both succeed", async () => {
        expect.hasAssertions();

        const webPush = mockPushProvider();
        const fcm = mockPushProvider();
        const router = routingPushProvider({ ...origins, fcm: fcm.provider, webPush: webPush.provider });

        const receipt = await router.send({ body: "b", to: [sub("ok"), "device-token-1"] });

        // One receipt describes two provider calls: dropping either half's id
        // leaves the caller holding a message id that names half the send.
        expect(receipt.success).toBe(true);
        expect((receipt.data as { messageId: string }).messageId).toBe("mock-1,mock-1");
    });

    it("refuses a mixed send with an unconfigured channel before delivering either half", async () => {
        expect.hasAssertions();

        const webPush = mockPushProvider();
        // No `fcm` channel: the FCM half is undeliverable from the start.
        const router = routingPushProvider({ ...origins, webPush: webPush.provider });

        await expect(router.send({ body: "b", to: [sub("ok"), "device-token-1"] })).rejects.toThrow(/no `fcm` channel is configured/);

        // Both channels are resolved before either send, so the throw leaves
        // nothing delivered — a partial delivery reported as a total failure is
        // the outcome the caller cannot recover from.
        expect(webPush.sends).toHaveLength(0);
    });

    it("still attempts the other group when one transport throws", async () => {
        expect.hasAssertions();

        const webPush = mockThrowingPushProvider();
        const fcm = mockPushProvider();
        const router = routingPushProvider({ ...origins, fcm: fcm.provider, webPush: webPush.provider });

        const receipt = await router.send({ body: "b", to: [sub("throw"), "device-token-1"] });

        // A throwing transport must not cancel the sibling group's send.
        expect(fcm.sends).toHaveLength(1);
        expect(fcm.sends[0]?.to).toBe("device-token-1");
        expect(receipt.success).toBe(false);
    });

    it("keeps both causes when both groups fail", async () => {
        expect.hasAssertions();

        const webPush = mockPushProvider();
        const fcm = mockPushProvider();
        const router = routingPushProvider({ ...origins, fcm: fcm.provider, webPush: webPush.provider });

        const receipt = await router.send({ body: "b", to: [sub("fail"), "fail-token"] });

        expect(receipt.success).toBe(false);
        expect((receipt.error as AggregateError).errors).toHaveLength(2);
    });

    it("does not let a succeeding group mask the other group's failure", async () => {
        expect.hasAssertions();

        const webPush = mockPushProvider();
        const fcm = mockPushProvider();
        const router = routingPushProvider({ ...origins, fcm: fcm.provider, webPush: webPush.provider });

        // The web-push target succeeds; the FCM token fails (mock 503).
        const receipt = await router.send({ body: "b", to: [sub("ok"), "fail-token"] });

        expect(webPush.sends).toHaveLength(1);
        expect(fcm.sends).toHaveLength(1);
        expect(receipt.success).toBe(false);
    });
});
