import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * Browser smoke for the chat example, sign-up through live delivery.
 *
 * Two accounts in two contexts is the only way to check the parts that make it a
 * chat app rather than a form: a message reaching the other person's open window
 * without a reload, and presence showing them as online.
 *
 * Attachments get one round trip here — upload through the signed URL, then
 * another member downloading it — because the URL's host is only right or
 * wrong against a real origin. The key-prefix guard is asserted in the
 * server-side suite, where a forged key can actually be sent.
 */
const unique = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const signUp = async (page: Page, name: string): Promise<void> => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Display name").fill(name);
    await page.getByLabel("Email").fill(`${name.toLowerCase()}@example.test`);
    await page.getByLabel("Password").fill("correct-horse-battery-staple"); // secret-scanner:allow
    await page.getByRole("button", { name: "Create account" }).click();

    // The sidebar's "Channels" is a <strong>, not a heading — its input is the
    // unambiguous signed-in marker.
    await expect(page.getByLabel("New channel")).toBeVisible();
};

test("signs up, creates a channel, and delivers a message and an attachment to another member", async ({ browser, page }) => {
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

    // An attachment round trip. The browser PUTs the file to the signed URL the
    // action minted, so that URL has to point back at the origin this page is
    // on — the dev server here, the worker's own host on a deploy.
    const contents = `attachment-${unique()}`;

    await page.getByLabel("Attach a file").setInputFiles({ buffer: Buffer.from(contents), mimeType: "text/plain", name: "notes.txt" });
    await page.getByLabel(`Message #${channel}`).fill("see attached");
    await page.getByRole("button", { name: "Send" }).click();

    // The other member downloads it. The app opens the signed download URL in
    // a new tab; record that URL instead and fetch it with Grace's session.
    await grace.evaluate(() => {
        globalThis.open = (url?: URL | string) => {
            document.body.dataset["openedUrl"] = String(url);

            return null;
        };
    });
    await grace.getByRole("button", { name: /notes\.txt/ }).click();
    await expect(grace.locator("body")).toHaveAttribute("data-opened-url", /\/files\//);

    const signedUrl = (await grace.locator("body").getAttribute("data-opened-url")) ?? "";

    expect(new URL(signedUrl).origin).toBe(new URL(grace.url()).origin);

    const download = await grace.request.get(signedUrl);

    expect(download.status()).toBe(200);
    expect(await download.text()).toBe(contents);

    await other.close();
});

test("keeps a signed-out visitor on the sign-in screen", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Lunora Team Chat" })).toBeVisible();
    await expect(page.getByLabel("New channel")).toBeHidden();
});
