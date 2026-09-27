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
 *   - The outbox drains in authored order. The rendered list cannot show that:
 *     the playground sorts by the client-stamped `createdAt`, which is fixed at
 *     authoring time, so an out-of-order replay still renders in order. The
 *     spec therefore watches the `messages:send` calls leave tab A and reads
 *     the server's own `_creationTime` order back.
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

    // Record the order the replayed sends leave tab A, over either transport.
    const replayed: string[] = [];
    const recordSend = (payload: string): void => {
        const draft = drafts.find((candidate) => payload.includes("messages:send") && payload.includes(candidate));

        if (draft !== undefined && !replayed.includes(draft)) {
            replayed.push(draft);
        }
    };

    pageA.on("request", (request) => {
        recordSend(request.postData() ?? "");
    });
    pageA.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
            recordSend(typeof payload === "string" ? payload : payload.toString("utf8"));
        });
    });

    // Reconnect — the outbox drains, the WS resubscribes, and both tabs land
    // on the same server-backed list.
    await contextA.setOffline(false);

    for (const draft of drafts) {
        await expect(pageA.getByText(draft)).toBeVisible({ timeout: 10_000 });
        await expect(pageB.getByText(draft)).toBeVisible({ timeout: 10_000 });
    }

    // The sync badge settles back to "no pending work" (neither offline nor syncing).
    await expect(pageA.getByTestId("sync-status")).toBeHidden({ timeout: 10_000 });

    // Replay order: the sends left tab A in authored order…
    expect(replayed).toEqual(drafts);

    // …and the server stamped them in that order. `_creationTime` has
    // millisecond resolution, so two sends can tie; a tie is not a reorder, but
    // a later draft stamped strictly earlier is.
    const channelId = (await pageB.locator("main h2").textContent())?.trim().split(" ")[0];
    const listed = await user.request.post("/_lunora/rpc", { data: { args: { channelId, limit: 50 }, functionPath: "messages:list" } });

    expect(listed.ok()).toBe(true);

    const rows = ((await listed.json()) as { result: { _creationTime: number; text: string }[] }).result;
    const stamps = drafts.map((draft) => rows.find((row) => row.text === draft)?._creationTime ?? Number.NaN);

    expect(stamps.every((stamp, index) => index === 0 || stamp >= (stamps[index - 1] ?? Number.NaN))).toBe(true);

    // Convergence: tab B renders all three.
    const textsB = await pageB.locator("main li").allTextContents();

    expect(drafts.every((draft) => textsB.some((text) => text.includes(draft)))).toBe(true);

    // And both tabs agree on the full list.
    const textsA = await pageA.locator("main li").allTextContents();

    expect(textsA.filter((text) => text.includes(`replay-${stamp}`))).toEqual(textsB.filter((text) => text.includes(`replay-${stamp}`)));

    await contextA.close();
    await contextB.close();
});
