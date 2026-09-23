import { expect, test } from "@playwright/test";

import { CLOUDFLARE_AUTH_AVAILABLE } from "../examples-setup";

/**
 * Browser smoke for the feedback board. The interesting part is the optimistic
 * vote: the count and the "have I voted" flag live in two different queries, so
 * a wrong optimistic update shows up as a flicker or a stuck caret that no
 * server-side test can see.
 *
 * The AI summary button is left alone — it calls Workers AI, which has no local
 * binding.
 */
/**
 * The whole example needs a Cloudflare account to boot (see `examples-setup.ts`),
 * so on a tokenless runner these skip rather than fail. It is a `test.skip`
 * rather than the config dropping the project, because a drop is invisible: the
 * run, the report and the required check all read exactly as they do when the
 * three cases passed.
 */
test.skip(!CLOUDFLARE_AUTH_AVAILABLE, "needs a Cloudflare account for the Workers AI binding — set CLOUDFLARE_API_TOKEN to run it");
/** Anchored so it matches the post body, not the "Upvote <title>" control. */
const uniqueTitle = (): string => `feedback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const submit = async (page: import("@playwright/test").Page, title: string): Promise<void> => {
    await page.getByRole("button", { name: "Submit feedback" }).click();
    await page.getByLabel("Your name").fill("Ada");
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Description").fill("Because the current flow is slow.");
    await page.getByRole("button", { name: "Post", exact: true }).click();
};

test("posts an idea and shows it on the board", async ({ page }) => {
    const title = uniqueTitle();

    await page.goto("/");
    await submit(page, title);

    await expect(page.getByRole("button", { name: new RegExp(`^${title}`) })).toBeVisible();
});

test("toggles a vote and settles on the server's count", async ({ page }) => {
    const title = uniqueTitle();

    await page.goto("/");
    await submit(page, title);

    const vote = page.getByRole("button", { name: `Upvote ${title}` });

    await expect(vote).toBeVisible();
    await vote.click();

    // Pressed state and count both flip — and stay flipped after the round trip,
    // which is what catches an optimistic update the server then contradicts.
    const voted = page.getByRole("button", { name: `Remove upvote from ${title}` });

    await expect(voted).toHaveAttribute("aria-pressed", "true");
    await expect(voted).toContainText("1");

    await voted.click();
    await expect(vote).toHaveAttribute("aria-pressed", "false");
    await expect(vote).toContainText("0");
});

test("opens a post's detail view and adds a comment", async ({ page }) => {
    const title = uniqueTitle();

    await page.goto("/");
    await submit(page, title);

    await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
    // A textarea, so Enter adds a newline — the form needs its button.
    await page.getByLabel("Add a comment").fill("Strong agree.");
    await page.getByRole("button", { name: "Comment" }).click();

    await expect(page.getByText("Strong agree.")).toBeVisible();
});
