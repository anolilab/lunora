import type { Dialog, Request, Route } from "@playwright/test";

import { expect, test } from "../fixtures/cirrus.js";

/**
 * Optimistic update E2E — verifies `useMutation` in `@cirrus/react` shows
 * the pending row immediately, swaps to a real id on ack, and rolls back on
 * server rejection.
 *
 * The Chat.tsx page renders `pending` items with a `(pending)` suffix when
 * the mutation hasn't acked yet. If the playground UI changes, update both
 * the selector here and the Chat.tsx rendering.
 */
test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("optimistic message appears instantly, then clears the pending indicator on ack", async ({ signedInPage }) => {
    await signedInPage.goto("/");

    signedInPage.once("dialog", async (dialog: Dialog) => dialog.accept("optimistic-channel"));
    await signedInPage.getByRole("button", { name: "+ New channel" }).click();
    await signedInPage.getByRole("button", { name: "optimistic-channel" }).click();

    const draftText = `optimistic-${Date.now()}`;

    await signedInPage.getByPlaceholder("Type a message…").fill(draftText);

    // Capture timing: optimistic row should appear before the network ack.
    const sendButton = signedInPage.getByRole("button", { name: "Send" });
    const optimisticListItem = signedInPage.locator(`li:has-text("${draftText}")`);

    await Promise.all([
        sendButton.click(),
        // Race window: < 50ms is essentially "instant" — server can't have
        // acked yet in any realistic deployment.
        expect(optimisticListItem).toBeVisible({ timeout: 200 }),
    ]);

    // The acked row clears the (pending) indicator.
    await expect(optimisticListItem).not.toContainText("(pending)", { timeout: 5000 });
});

test("failed mutation rolls back the optimistic value", async ({ signedInPage }) => {
    await signedInPage.goto("/");

    signedInPage.once("dialog", async (dialog: Dialog) => dialog.accept("rollback-channel"));
    await signedInPage.getByRole("button", { name: "+ New channel" }).click();
    await signedInPage.getByRole("button", { name: "rollback-channel" }).click();

    // Force the next /_cirrus/rpc call to fail. Playwright's request
    // interception is route-scoped to the page, so we can simulate a server
    // 500 without touching real state.
    await signedInPage.route("**/_cirrus/rpc", async (route: Route, request: Request) => {
        const body = request.postData() ?? "";

        if (body.includes('"messages:send"')) {
            await route.fulfill({
                status: 500,
                contentType: "application/json",
                body: JSON.stringify({ error: { code: "INTERNAL", message: "simulated failure" } }),
            });

            return;
        }

        await route.continue();
    });

    const draftText = `rollback-${Date.now()}`;

    await signedInPage.getByPlaceholder("Type a message…").fill(draftText);
    await signedInPage.getByRole("button", { name: "Send" }).click();

    // Initially visible (optimistic), then disappears once the server rejects
    // and the client rolls back.
    const row = signedInPage.locator(`li:has-text("${draftText}")`);

    await expect(row).toBeVisible({ timeout: 500 });
    await expect(row).toBeHidden({ timeout: 5000 });
});
