import { expect, test } from "@playwright/test";

/**
 * Browser smoke for the SSR example. The claim this example makes is that the
 * first paint comes from the server and the socket takes over afterwards, so
 * both halves are worth checking: the markup must arrive already populated
 * (asserted with JavaScript disabled), and a later write must arrive without a
 * reload.
 */
/**
 * The form is a React 19 `action`, so it only works once the page has hydrated —
 * before that a click is a native submit that goes nowhere. The "live" indicator
 * is the page's own signal that the client is up, so every interaction waits on
 * it rather than on a sleep.
 */
const waitForLive = async (page: import("@playwright/test").Page): Promise<void> => {
    await expect(page.getByText("live", { exact: true })).toBeVisible();
};

const uniqueBody = (): string => `ssr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

test("renders the board on the server, before any JavaScript runs", async ({ browser, page }) => {
    const body = uniqueBody();

    await page.goto("/");
    await waitForLive(page);
    await page.getByLabel("Message").fill(body);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(body)).toBeVisible();

    // A JS-free context can only see what the server rendered.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const noScript = await context.newPage();

    await noScript.goto("/");
    await expect(noScript.getByText(body)).toBeVisible();

    await context.close();
});

test("pushes a new message to an already-open page", async ({ browser, page }) => {
    await page.goto("/");
    await waitForLive(page);

    const writer = await browser.newPage();
    const body = uniqueBody();

    await writer.goto("/");
    await waitForLive(writer);
    await writer.getByLabel("Message").fill(body);
    await writer.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText(body)).toBeVisible();

    await writer.close();
});
