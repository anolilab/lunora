import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * Browser smoke for the chess example: two accounts, one table, a real move.
 *
 * The server-side suite already proves the rules are enforced. What only a
 * browser can show is that a move made by one player repaints the other
 * player's board over the socket — the whole point of the example.
 */
const unique = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const signUp = async (page: Page, name: string): Promise<void> => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Display name").fill(name);
    await page.getByLabel("Email").fill(`${name.toLowerCase()}@example.test`);
    await page.getByLabel("Password").fill("correct-horse-battery-staple");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Play" })).toBeVisible();
};

test("seats two players and plays a move that both boards show", async ({ browser, page }) => {
    await signUp(page, `Host${unique()}`);

    // The host opens a public table, which then appears in the other player's list.
    await page.getByRole("button", { name: "Quick match" }).click();
    await expect(page.getByRole("heading", { name: "Your table" })).toBeVisible();

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();

    await signUp(guest, `Guest${unique()}`);
    await guest.getByRole("button", { name: "Sit down" }).first().click();

    await page.getByRole("button", { name: "Start game" }).click();

    // White opens; the pawn is addressed by its square, which is also its label.
    await page.getByRole("button", { name: "e2 white pawn" }).click();
    await page.getByRole("button", { name: /^e4/ }).click();

    await expect(page.getByRole("button", { name: "e4 white pawn" })).toBeVisible();
    await expect(guest.getByRole("button", { name: "e4 white pawn" })).toBeVisible();

    await guestContext.close();
});

test("keeps a signed-out visitor on the sign-in screen", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Lunora Chess" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Play" })).toBeHidden();
});
