import { expect, test } from "@playwright/test";

/**
 * Browser smoke for the kanban example: does a card created in one tab reach a
 * second tab without a reload?
 *
 * That is the only claim the example makes that a server-side test cannot check
 * — the in-memory harness proves the mutation writes, but not that the
 * subscription pushes the delta to a live client.
 */
const uniqueTitle = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

test("creates a card, and a second client sees it live", async ({ browser, page }) => {
    await page.goto("/");
    await expect(page.getByRole("region", { name: "To Do" })).toBeVisible();

    // A second client subscribed *before* the write, so it can only learn about
    // the card through the live query.
    const observer = await browser.newPage();

    await observer.goto("/");
    await expect(observer.getByRole("region", { name: "To Do" })).toBeVisible();

    const title = uniqueTitle("live");

    await page.getByRole("region", { name: "To Do" }).getByRole("button", { name: "+ Add a card" }).click();
    await page.getByLabel("New card in To Do").fill(title);
    await page.getByLabel("New card in To Do").press("Enter");

    await expect(page.getByRole("button", { exact: true, name: title })).toBeVisible();
    await expect(observer.getByRole("button", { exact: true, name: title })).toBeVisible();

    await observer.close();
});

test("filters the board with the search box", async ({ page }) => {
    const keep = uniqueTitle("keep");
    const hide = uniqueTitle("hide");

    await page.goto("/");

    // The composer stays open after Enter so a run of cards can be typed
    // straight through — which is why the button is only clicked once.
    await page.getByRole("region", { name: "To Do" }).getByRole("button", { name: "+ Add a card" }).click();

    for (const title of [keep, hide]) {
        await page.getByLabel("New card in To Do").fill(title);
        await page.getByLabel("New card in To Do").press("Enter");
        await expect(page.getByRole("button", { exact: true, name: title })).toBeVisible();
    }

    await page.getByLabel("Search cards").fill(keep);

    await expect(page.getByRole("button", { exact: true, name: keep })).toBeVisible();
    await expect(page.getByRole("button", { exact: true, name: hide })).toBeHidden();
});

test("opens the command palette with the keyboard", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("ControlOrMeta+k");

    const palette = page.getByRole("dialog", { name: "Command palette" });

    await expect(palette).toBeVisible();

    // A native <dialog> gives Escape-to-close for free; assert we actually get it.
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
});
