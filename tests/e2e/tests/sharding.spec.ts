import type { APIRequestContext, Dialog } from "@playwright/test";

import type { TestUser } from "../fixtures/lunora.js";
import { expect, test } from "../fixtures/lunora.js";

/**
 * Sharding E2E — proves `shardBy("channelId")` routes each channel's writes
 * to its own DO and the `messages.list` query never sees foreign rows, and
 * that two independent clients subscribed to the SAME shard converge.
 *
 * The unit tests in `packages/do/__tests__` already verify the DO
 * routing math, but they can't catch a regression where the *client* mints
 * the wrong shard hint or the *server* falls back to a single DO. This test
 * round-trips through the full pipe.
 *
 * The server derives no shard from a function's args — the caller names it
 * with `shardKey`, and a call without one lands in the default `__root__`
 * shard. So every assertion here reads a row back from a NAMED shard and
 * checks it is absent from `__root__`: a list that omits `shardKey` would pass
 * just as well with every shard collapsed into the root DO.
 */

const ROOT_SHARD = "__root__";

interface MessageRow {
    channelId: string;
    text: string;
}

/** One RPC, optionally routed to a shard. Throws on a transport-level failure. */
const rpc = async (request: APIRequestContext, functionPath: string, args: Record<string, unknown>, shardKey?: string): Promise<unknown> => {
    const response = await request.post(`/_lunora/rpc`, {
        data: { args, functionPath, ...(shardKey === undefined ? {} : { shardKey }) },
    });

    if (!response.ok()) {
        throw new Error(`rpc ${functionPath} failed (${response.status()})`);
    }

    return ((await response.json()) as { result: unknown }).result;
};

/** `messages:list` for `channelId`, read from the DO `shardKey` names. */
const listIn = async (user: TestUser, channelId: string, shardKey: string): Promise<MessageRow[]> =>
    (await rpc(user.request, "messages:list", { channelId, limit: 200 }, shardKey)) as MessageRow[];

/** A fresh channel. `channels` is not sharded, so it needs no `shardKey`. */
const createChannel = async (user: TestUser, name: string): Promise<string> =>
    // `channels:create` / `messages:send` are deterministic mutations: the client
    // stamps `createdAt` (Date.now() in a handler would be non-deterministic), so
    // direct RPC callers must supply it too. `id` is optional (server mints it).
    (await rpc(user.request, "channels:create", { createdAt: Date.now(), name })) as string;

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("each channel's messages live in its own shard — not in the other channel's, not in __root__", async ({ user }) => {
    // Drive sharding via RPC directly — clicking through the UI 100 times is
    // slow and adds no extra coverage versus the network round-trip. The
    // better-auth session cookie travels with `user.request`.
    const channelA = await createChannel(user, "shard-A");
    const channelB = await createChannel(user, "shard-B");

    expect(channelA).not.toBe(channelB);

    // Both channels' sends are one user, so they share the `messages:send` token
    // bucket (30 / 60s). 2×SEND_COUNT must stay under it — a dozen per channel
    // proves shard isolation just as well as fifty without tripping the limiter.
    const SEND_COUNT = 12;

    for (let index = 0; index < SEND_COUNT; index += 1) {
        await rpc(user.request, "messages:send", { channelId: channelA, createdAt: Date.now(), text: `A-${index}` }, channelA);
        await rpc(user.request, "messages:send", { channelId: channelB, createdAt: Date.now(), text: `B-${index}` }, channelB);
    }

    const listA = await listIn(user, channelA, channelA);
    const listB = await listIn(user, channelB, channelB);

    expect(listA).toHaveLength(SEND_COUNT);
    expect(listB).toHaveLength(SEND_COUNT);

    expect(listA.every((row) => row.channelId === channelA && row.text.startsWith("A-"))).toBe(true);
    expect(listB.every((row) => row.channelId === channelB && row.text.startsWith("B-"))).toBe(true);

    // The rows are in their own DO and nowhere else: not in the root shard, and
    // not in the other channel's shard.
    expect(await listIn(user, channelA, ROOT_SHARD)).toHaveLength(0);
    expect(await listIn(user, channelB, ROOT_SHARD)).toHaveLength(0);
    expect(await listIn(user, channelA, channelB)).toHaveLength(0);
    expect(await listIn(user, channelB, channelA)).toHaveLength(0);
});

test("both channels run independently — a thrown error in A doesn't kill B", async ({ user }) => {
    const channelA = await createChannel(user, "shard-iso-A");
    const channelB = await createChannel(user, "shard-iso-B");

    // Force a failed write on channel A: a wrong-typed `text` fails arg
    // validation with a 4xx. (Sending to a *non-existent* channel id wouldn't
    // error — `shardBy` mints a shard on demand.) The point is resilience: a
    // rejected request must not poison the worker so B's writes still land.
    const bogusResponse = await user.request.post(`/_lunora/rpc`, {
        data: { args: { channelId: channelA, createdAt: Date.now(), text: 123 }, functionPath: "messages:send", shardKey: channelA },
    });

    // We don't care which error code — only that B still works after.
    expect(bogusResponse.status()).toBeGreaterThanOrEqual(400);

    await rpc(user.request, "messages:send", { channelId: channelB, createdAt: Date.now(), text: "post-error" }, channelB);

    expect((await listIn(user, channelB, channelB)).map((row) => row.text)).toContain("post-error");
    expect(await listIn(user, channelB, ROOT_SHARD)).toHaveLength(0);

    // sanity: A is empty in its own shard
    expect(await listIn(user, channelA, channelA)).toHaveLength(0);
});

test("the playground UI writes a channel's messages to that channel's shard, and renders rows written there", async ({ signedInPage: page, user }) => {
    await page.goto("/");

    const name = `ui-shard-${Date.now()}`;

    page.once("dialog", async (dialog: Dialog) => dialog.accept(name));
    await page.getByRole("button", { name: "+ New channel" }).click();
    await page.getByRole("button", { name }).click();

    // The header reads "<channelId> …" once a channel is active.
    await expect(page.locator("main h2")).not.toHaveText(/Select a channel/u);

    const channelId = ((await page.locator("main h2").textContent()) ?? "").trim().split(" ")[0] ?? "";

    expect(channelId).not.toBe("");

    // UI → shard: the optimistic write is delivered to the channel's own DO.
    const fromUi = `from-ui-${Date.now()}`;

    await page.getByPlaceholder("Type a message…").fill(fromUi);
    await page.getByRole("button", { name: "Send" }).click();

    await expect.poll(async () => (await listIn(user, channelId, channelId)).map((row) => row.text), { timeout: 10_000 }).toContain(fromUi);
    expect((await listIn(user, channelId, ROOT_SHARD)).map((row) => row.text)).not.toContain(fromUi);

    // Shard → UI: a row written straight into the channel's shard shows up, so
    // the UI's subscription reads that DO too — not the root one.
    const fromShard = `from-shard-${Date.now()}`;

    await rpc(user.request, "messages:send", { channelId, createdAt: Date.now(), text: fromShard }, channelId);
    await expect(page.getByText(fromShard)).toBeVisible({ timeout: 5000 });
});

test("two clients on the same shard converge in both directions over WS", async ({ browser, makeUser, user }) => {
    // DIFFERENT users, SAME channel → same shard DO. Cross-user convergence
    // proves the shard's WS fan-out isn't accidentally scoped per-user/session
    // (the subscriptions spec only ever covers one user in two tabs).
    const userB = await makeUser("shard-user-b");

    const contextA = await browser.newContext({ storageState: await user.request.storageState() });
    const contextB = await browser.newContext({ storageState: await userB.request.storageState() });

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto("/");
    await pageB.goto("/");

    pageA.once("dialog", async (dialog: Dialog) => dialog.accept("shared-shard"));
    await pageA.getByRole("button", { name: "+ New channel" }).click();
    await pageA.getByRole("button", { name: "shared-shard" }).click();

    // B discovers the channel through the global channels subscription.
    await expect(pageB.getByRole("button", { name: "shared-shard" })).toBeVisible({ timeout: 2000 });

    await pageB.getByRole("button", { name: "shared-shard" }).click();

    const stamp = Date.now();
    const fromA = `same-shard-from-A-${stamp}`;
    const fromB = `same-shard-from-B-${stamp}`;

    // A → B over the shard's WS broadcast.
    await pageA.getByPlaceholder("Type a message…").fill(fromA);
    await pageA.getByRole("button", { name: "Send" }).click();
    await expect(pageB.getByText(fromA)).toBeVisible({ timeout: 5000 });

    // B → A, same shard, opposite direction.
    await pageB.getByPlaceholder("Type a message…").fill(fromB);
    await pageB.getByRole("button", { name: "Send" }).click();
    await expect(pageA.getByText(fromB)).toBeVisible({ timeout: 5000 });

    // Both clients render both messages — full convergence on the shard.
    const [textsA, textsB] = await Promise.all([pageA.locator("main li").allTextContents(), pageB.locator("main li").allTextContents()]);
    const relevant = (texts: string[]): string[] => texts.filter((text) => text.includes(`same-shard-`)).map((text) => (text.includes(fromA) ? "A" : "B"));

    expect(relevant(textsA)).toEqual(["A", "B"]);
    expect(relevant(textsB)).toEqual(["A", "B"]);

    await contextA.close();
    await contextB.close();
});
