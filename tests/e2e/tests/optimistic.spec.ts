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

    // Capture timing: the optimistic row should appear before the network ack.
    const sendButton = signedInPage.getByRole("button", { name: "Send" });
    // Scope to the `(pending)` row specifically — during the brief overlap after
    // the ack the optimistic override and the real subscription row both carry
    // `draftText`, so a bare `:has-text(draftText)` would match two elements and
    // trip strict mode. The `(pending)` marker is unique to the optimistic row.
    const pendingRow = signedInPage.locator("li", { hasText: draftText }).filter({ hasText: "(pending)" });

    await Promise.all([
        sendButton.click(),
        // Race window: < 200ms is essentially "instant" — the server can't have
        // acked yet in any realistic deployment.
        expect(pendingRow).toBeVisible({ timeout: 200 }),
    ]);

    // On ack the optimistic override is dropped and the real (unmarked) row
    // shows through — no `(pending)` row remains for this draft.
    await expect(pendingRow).toHaveCount(0, { timeout: 5000 });
    // …and the message itself is still there, now server-backed.
    await expect(signedInPage.locator("li", { hasText: draftText }).first()).toBeVisible();
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
            // Mimic real network latency before the rejection. Fulfilling
            // synchronously would batch the optimistic insert and its rollback into
            // one paint, so the pending row would never become observable.
            await new Promise((resolve) => setTimeout(resolve, 150));
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
