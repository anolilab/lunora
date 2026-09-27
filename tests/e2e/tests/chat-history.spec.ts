import type { Dialog } from "@playwright/test";

import { expect, test } from "../fixtures/lunora.js";

/**
 * The chat's message window and author names, past the first screenful.
 *
 * `messages:list` returns a bounded window (50 by default), and the client
 * renders exactly that window. A window read oldest-first stops moving once a
 * channel passes the limit: every later message is stored but never listed,
 * so it vanishes for its sender and for everyone else in the channel.
 */
test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("a message sent into a channel past the list window still reaches everyone", async ({ browser, makeUser, user }) => {
    test.setTimeout(120_000);

    const other = await makeUser("other");
    const contextA = await browser.newContext({ storageState: await user.request.storageState() });
    const contextB = await browser.newContext({ storageState: await other.request.storageState() });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto("/");
    await pageB.goto("/");

    const name = `busy-${Date.now()}`;

    pageA.once("dialog", async (dialog: Dialog) => dialog.accept(name));
    await pageA.getByRole("button", { name: "+ New channel" }).click();
    await pageA.getByRole("button", { name }).click();
    await pageB.getByRole("button", { name }).click();

    const channelId = (await pageA.locator("main h2").textContent())?.trim().split(" ")[0];

    // Fill the window: 50 earlier messages, split across both users to stay
    // under the per-user send limit (30 a minute).
    for (const member of [user, other]) {
        for (let index = 0; index < 25; index += 1) {
            const response = await member.request.post("/_lunora/rpc", {
                data: { args: { channelId, createdAt: Date.now(), text: `old-${index}` }, functionPath: "messages:send" },
            });

            expect(response.ok()).toBe(true);
        }
    }

    await expect(pageB.locator("main li")).toHaveCount(50, { timeout: 10_000 });

    const fresh = `fresh-${Date.now()}`;

    await pageA.getByPlaceholder("Type a message…").fill(fresh);
    await pageA.getByRole("button", { name: "Send" }).click();

    // Past the optimistic row: it has to survive the server's answer.
    await expect(pageA.getByTestId("sync-status")).toBeHidden({ timeout: 10_000 });
    await expect(pageA.getByText(fresh)).toBeVisible({ timeout: 10_000 });
    await expect(pageB.getByText(fresh)).toBeVisible({ timeout: 10_000 });

    await contextA.close();
    await contextB.close();
});

test("renders a message's author by display name, not by user id", async ({ signedInPage, user }) => {
    const page = signedInPage;

    await page.goto("/");

    const name = `authors-${Date.now()}`;

    page.once("dialog", async (dialog: Dialog) => dialog.accept(name));
    await page.getByRole("button", { name: "+ New channel" }).click();
    await page.getByRole("button", { name }).click();

    const body = `named-${Date.now()}`;

    await page.getByPlaceholder("Type a message…").fill(body);
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.locator("main li").filter({ hasText: body })).toContainText(`${user.name}: ${body}`);
});
