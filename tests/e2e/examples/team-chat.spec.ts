import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * Browser smoke for the chat example, sign-up through live delivery.
 *
 * Two accounts in two contexts is the only way to check the parts that make it a
 * chat app rather than a form: a message reaching the other person's open window
 * without a reload, and presence showing them as online.
 *
 * Attachments are not exercised — the upload goes to R2 through a signed URL,
 * and the interesting half of that (the key-prefix guard) is asserted in the
 * server-side suite where a forged key can actually be sent.
 */
const unique = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const signUp = async (page: Page, name: string): Promise<void> => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Display name").fill(name);
    await page.getByLabel("Email").fill(`${name.toLowerCase()}@example.test`);
    await page.getByLabel("Password").fill("correct-horse-battery-staple");
    await page.getByRole("button", { name: "Create account" }).click();

    // The sidebar's "Channels" is a <strong>, not a heading — its input is the
    // unambiguous signed-in marker.
    await expect(page.getByLabel("New channel")).toBeVisible();
};

test("signs up, creates a channel, and delivers a message to another member live", async ({ browser, page }) => {
    const channel = `room-${unique()}`;

    await signUp(page, `Ada${unique()}`);

    await page.getByLabel("New channel").fill(channel);
    await page.getByLabel("New channel").press("Enter");

    // The sidebar renders channels as `#name`.
    const channelButton = page.getByRole("button", { exact: true, name: `#${channel}` });

    await expect(channelButton).toBeVisible();
    await channelButton.click();

    // Second member, subscribed before the message is sent.
    const other = await browser.newContext();
    const grace = await other.newPage();

    await signUp(grace, `Grace${unique()}`);
    await grace.getByRole("button", { exact: true, name: `#${channel}` }).click();

    const body = `hello-${unique()}`;

    await page.getByLabel(`Message #${channel}`).fill(body);
    await page.getByLabel(`Message #${channel}`).press("Enter");

    await expect(page.getByText(body)).toBeVisible();
    await expect(grace.getByText(body)).toBeVisible();

    // Both are in the channel, so presence must show two people.
    await expect(page.getByRole("list", { name: "Online now" }).getByRole("listitem")).toHaveCount(2);

    await other.close();
});

test("keeps a signed-out visitor on the sign-in screen", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Lunora Team Chat" })).toBeVisible();
    await expect(page.getByLabel("New channel")).toBeHidden();
});
