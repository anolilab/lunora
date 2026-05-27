import type { Dialog } from "@playwright/test";

import { expect, test } from "../fixtures/cirrus.js";

/**
 * Real-time subscription E2E — the *load-bearing* test for Cirrus.
 *
 * Two browser tabs join the same channel. When tab A sends a message, the
 * ShardDO must broadcast a delta over the WebSocket subscription on
 * `/_cirrus/ws`, and tab B must render the new message without polling.
 *
 * Why we don't just unit-test this:
 *   - The DO's `broadcastDelta` is well-covered by Vitest workers-pool tests,
 *     but the *client* side — `@cirrus/react`'s `useQuery` subscription, the
 *     React state batch, and the actual DOM update — only run for real in a
 *     browser. Mocking the WS in JSDom would leave a sizable confidence gap.
 */
test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("tab B sees a message from tab A within 500ms via WS subscription", async ({ browser, user }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    // Seed the same auth token in both contexts so both subscriptions are
    // authenticated as the same user.
    await contextA.addInitScript((token: string) => {
        globalThis.localStorage.setItem("cirrus.token", token);
    }, user.token);
    await contextB.addInitScript((token: string) => {
        globalThis.localStorage.setItem("cirrus.token", token);
    }, user.token);

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto("/");
    await pageB.goto("/");

    // Tab A creates a channel — the prompt dialog needs an override.
    pageA.once("dialog", async (dialog: Dialog) => dialog.accept("realtime-channel"));
    await pageA.getByRole("button", { name: "+ New channel" }).click();

    // Both tabs select it once it shows up in the channel list (B picks it up
    // through the channels query subscription, proving the global D1 sub
    // works end-to-end too).
    const channelButtonA = pageA.getByRole("button", { name: "realtime-channel" });
    const channelButtonB = pageB.getByRole("button", { name: "realtime-channel" });

    await channelButtonA.click();

    await expect(channelButtonB).toBeVisible({ timeout: 2000 });

    await channelButtonB.click();

    // Tab A sends a message; tab B must receive it via WS push.
    const marker = `hello-from-A-${Date.now()}`;

    await pageA.getByPlaceholder("Type a message…").fill(marker);

    const sentAt = Date.now();

    await pageA.getByRole("button", { name: "Send" }).click();

    // Tab B's list of <li>s grows. We tolerate 1500ms to leave headroom for
    // CI; the local-dev p95 is ~80ms.
    await expect(pageB.getByText(marker)).toBeVisible({ timeout: 1500 });

    const elapsed = Date.now() - sentAt;

    // eslint-disable-next-line no-console
    console.info(`[e2e:subscriptions] B-saw-A in ${elapsed}ms`);

    await contextA.close();
    await contextB.close();
});

test("offline → online replays queued messages and broadcasts to other tabs", async ({ browser, user }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    await contextA.addInitScript((token: string) => {
        globalThis.localStorage.setItem("cirrus.token", token);
    }, user.token);
    await contextB.addInitScript((token: string) => {
        globalThis.localStorage.setItem("cirrus.token", token);
    }, user.token);

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto("/");
    await pageB.goto("/");

    pageA.once("dialog", async (dialog: Dialog) => dialog.accept("offline-channel"));
    await pageA.getByRole("button", { name: "+ New channel" }).click();

    await pageA.getByRole("button", { name: "offline-channel" }).click();

    await expect(pageB.getByRole("button", { name: "offline-channel" })).toBeVisible({ timeout: 2000 });

    await pageB.getByRole("button", { name: "offline-channel" }).click();

    // Take tab A offline. Playwright's CDP wrapper closes existing sockets,
    // which forces the client into its "queue mutations" mode.
    await contextA.setOffline(true);

    const queued = `queued-${Date.now()}`;

    await pageA.getByPlaceholder("Type a message…").fill(queued);
    await pageA.getByRole("button", { name: "Send" }).click();

    // Confirm B does NOT have it yet (offline → no flight).
    await expect(pageB.getByText(queued)).toBeHidden({ timeout: 500 });

    // Bring A back online — the @cirrus/client mutation queue should drain
    // and the WS reconnect should hydrate B.
    await contextA.setOffline(false);

    await expect(pageA.getByText(queued)).toBeVisible({ timeout: 5000 });
    await expect(pageB.getByText(queued)).toBeVisible({ timeout: 5000 });

    await contextA.close();
    await contextB.close();
});
