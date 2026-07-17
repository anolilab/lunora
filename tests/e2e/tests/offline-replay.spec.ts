import type { Dialog } from "@playwright/test";

import { expect, test } from "../fixtures/lunora.js";

/**
 * Offline outbox replay E2E — deeper coverage than the single-message case in
 * `subscriptions.spec.ts`: several mutations queue up while the tab is
 * offline, then ALL of them replay on reconnect, in the order they were
 * authored, and a second tab converges onto the same list.
 *
 * What this proves that unit tests can't:
 *   - Playwright's `setOffline` really severs the WS + fetch layer, so the
 *     queued sends exercise `@tanstack/offline-transactions`' durable outbox
 *     (IndexedDB) rather than a mocked transport.
 *   - Replay ordering is user-visible ordering: the playground sorts by the
 *     client-stamped `createdAt`, so a queue that drained out of order (or
 *     re-stamped timestamps at replay time) would flip the rendered list.
 */
test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("multiple offline mutations replay in order and both tabs converge", async ({ browser, user }) => {
    const storageState = await user.request.storageState();
    const contextA = await browser.newContext({ storageState });
    const contextB = await browser.newContext({ storageState });

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto("/");
    await pageB.goto("/");

    pageA.once("dialog", async (dialog: Dialog) => dialog.accept("replay-channel"));
    await pageA.getByRole("button", { name: "+ New channel" }).click();
    await pageA.getByRole("button", { name: "replay-channel" }).click();

    await expect(pageB.getByRole("button", { name: "replay-channel" })).toBeVisible({ timeout: 2000 });

    await pageB.getByRole("button", { name: "replay-channel" }).click();

    // Sever tab A's network. The outbox must queue everything from here on.
    await contextA.setOffline(true);
    await expect(pageA.getByTestId("sync-status")).toHaveText("(offline)");

    const stamp = Date.now();
    const drafts = [`replay-${stamp}-first`, `replay-${stamp}-second`, `replay-${stamp}-third`];

    for (const draft of drafts) {
        await pageA.getByPlaceholder("Type a message…").fill(draft);
        await pageA.getByRole("button", { name: "Send" }).click();
        // The optimistic row lands immediately even offline.
        await expect(pageA.getByText(draft)).toBeVisible();
    }

    // None of them may reach the server while offline.
    await expect(pageB.getByText(`replay-${stamp}-third`)).toBeHidden({ timeout: 500 });
    await expect(pageB.getByText(`replay-${stamp}-first`)).toBeHidden();

    // Reconnect — the outbox drains, the WS resubscribes, and both tabs land
    // on the same server-backed list.
    await contextA.setOffline(false);

    for (const draft of drafts) {
        await expect(pageA.getByText(draft)).toBeVisible({ timeout: 10_000 });
        await expect(pageB.getByText(draft)).toBeVisible({ timeout: 10_000 });
    }

    // The sync badge settles back to "no pending work" (neither offline nor syncing).
    await expect(pageA.getByTestId("sync-status")).toBeHidden({ timeout: 10_000 });

    // Convergence + ordering: tab B renders the three replayed messages in
    // authored order (the client-stamped createdAt survived the replay).
    const textsB = await pageB.locator("main li").allTextContents();
    const indexes = drafts.map((draft) => textsB.findIndex((text) => text.includes(draft)));

    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);

    // And both tabs agree on the full list.
    const textsA = await pageA.locator("main li").allTextContents();

    expect(textsA.filter((text) => text.includes(`replay-${stamp}`))).toEqual(textsB.filter((text) => text.includes(`replay-${stamp}`)));

    await contextA.close();
    await contextB.close();
});
