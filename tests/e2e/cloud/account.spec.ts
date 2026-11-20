import { readFile } from "node:fs/promises";

import type { Download } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { cloudSkipReason, DEV_EMAIL } from "../cloud-setup";

/**
 * Account-level actions on the signed-in landing page (the organization picker).
 *
 * What each test proves:
 *   - export — "Export my data" fetches `GET /v1/account/export` with the session
 *     cookie and hands the browser a JSON download carrying the current export format
 *     and the signed-in account's profile.
 *   - delete — the delete-account card is mounted with its password confirmation.
 *     It is never submitted: that would delete the seeded account every other spec
 *     signs in as (and the server refuses it anyway while the account is the only
 *     owner of the seeded organization).
 *
 * Every test starts from the seeded account's session (`cloud-seed.ts` signs it in
 * once and the config hands it out as `storageState`).
 */
const SKIP = cloudSkipReason();

test.skip(SKIP !== undefined, SKIP ?? "");

const EXPORT_FORMAT = "lunora-account-export/2";

test("export my data downloads the signed-in account's export", async ({ page }) => {
    await page.goto("/");

    const exportButton = page.getByRole("button", { name: "Export my data" });
    let download: Download | undefined;

    // Retried because the picker is server-rendered: a click that lands before
    // hydration has no handler yet, and no download ever starts.
    await expect(async () => {
        [download] = await Promise.all([page.waitForEvent("download", { timeout: 10_000 }), exportButton.click()]);
    }).toPass({ timeout: 90_000 });

    expect(download?.suggestedFilename()).toMatch(/^lunora-account-export-\d{4}-\d{2}-\d{2}\.json$/);

    const path = await download?.path();

    expect(path, "the download was not saved").toBeTruthy();

    const exported = JSON.parse(await readFile(path as string, "utf8")) as { format?: unknown; profile?: { email?: unknown } | null };

    expect(exported.format).toBe(EXPORT_FORMAT);
    expect(exported.profile?.email).toBe(DEV_EMAIL);
});

test("the delete-account card asks for the password", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 2, name: "Delete account" })).toBeVisible();

    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Delete account" }) });

    await expect(form.getByLabel("Password")).toHaveAttribute("type", "password");
    await expect(form.getByRole("button", { name: "Delete account" })).toBeEnabled();
});
