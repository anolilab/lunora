import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { cloudSkipReason } from "../cloud-setup";

/**
 * The control-plane shell's sidebar: an icon rail that slides open and shut.
 *
 * What each test proves:
 *   - the org switcher still works from the collapsed rail, with its dropdown opening
 *     out to the right and nothing painted over its links;
 *   - moving to another tab resets the content panel's scroll, which the router's own
 *     scroll restoration (aimed at the window) would not do for the inset panel;
 *   - the 1h / 24h / 7d segmented control presses one window at a time and never none;
 *   - the trigger flips the rail between `collapsed` (the default with no cookie) and
 *     `expanded`, and back;
 *   - ⌘B / Ctrl+B does the same, through the provider's window-level shortcut;
 *   - the chosen state survives a reload because the SERVER renders it from the
 *     `sidebar_state` cookie, so the first client pass matches and React reports no
 *     hydration error. Reading the cookie during render on the client instead is the
 *     regression this guards against.
 */
const SKIP = cloudSkipReason();

test.skip(SKIP !== undefined, SKIP ?? "");

const ORG_NAME = "Acme Dev";
const ORG_ROUTE = /\/orgs\/[^/]+\/projects/;

/** The desktop sidebar root, which carries `data-state`. */
const sidebarOf = (page: Page): Locator => page.locator('div[data-slot="sidebar"][data-state]');

/**
 * Drive the rail to `target`, retrying until the app acts on it.
 *
 * Every control here is server-rendered, so a click or keypress that lands before
 * hydration is dropped. Retrying blindly would flake the other way (a slow attempt
 * toggles it back), so each attempt acts only while the rail is not yet in `target`.
 */
const driveTo = async (page: Page, target: "collapsed" | "expanded", act: () => Promise<void>): Promise<void> => {
    const sidebar = sidebarOf(page);

    await expect(async () => {
        if ((await sidebar.getAttribute("data-state")) !== target) {
            await act();
        }

        await expect(sidebar).toHaveAttribute("data-state", target, { timeout: 2000 });
    }).toPass({ timeout: 90_000 });
};

/**
 * Pick the seeded organization, then land on its Traffic tab.
 *
 * Traffic rather than the default Projects tab: the shell is identical on every tab,
 * and Projects currently fails to render under the Vite dev server (its client code
 * reaches a `node:fs` import through `@lunora/config/celld`), which would fail these
 * tests for a reason that has nothing to do with the sidebar.
 */
const openSeededOrganization = async (page: Page): Promise<void> => {
    await page.goto("/");

    await expect(async () => {
        await page.getByRole("button", { name: new RegExp(ORG_NAME) }).click();
        await expect(page).toHaveURL(ORG_ROUTE, { timeout: 20_000 });
    }).toPass({ timeout: 90_000 });

    const organizationId = new URL(page.url()).pathname.split("/")[2];

    await page.goto(`/orgs/${String(organizationId)}/traffic`);
};

test("the org switcher opens from the collapsed rail and its links are clickable", async ({ page }) => {
    await openSeededOrganization(page);

    await expect(sidebarOf(page)).toHaveAttribute("data-state", "collapsed");

    const switcher = page
        .locator("details")
        .filter({ has: page.locator("summary") })
        .first();
    const link = switcher.getByRole("link", { name: new RegExp(ORG_NAME) });

    await expect(switcher.locator("summary")).toContainText(ORG_NAME);
    // `textContent` alone would pass with the name `display:none`d in the rail; the
    // accessible name is what a screen reader (and a role query) actually gets.
    await expect(switcher.locator("summary")).toHaveAccessibleName(new RegExp(ORG_NAME));

    // A native disclosure, so the click works before hydration too. A real click on
    // the link (not just a visibility check) is the point: Playwright refuses to click
    // an element something else paints over, which is how a dropdown opening out of
    // the narrow rail under the sticky header would show up.
    await switcher.locator("summary").click();
    await link.click();

    await expect(page).toHaveURL(ORG_ROUTE);
});

test("switching tabs scrolls the content panel back to the top", async ({ page }) => {
    await openSeededOrganization(page);

    // Hydrated first: before hydration the nav link is a plain anchor, and the full page
    // load it would trigger resets the scroll trivially, proving nothing.
    await driveTo(page, "expanded", async () => page.keyboard.press("ControlOrMeta+b"));

    // The inset panel, not the window, is the scroll container inside the app frame.
    const panel = page.locator('main[data-slot="sidebar-inset"]');

    await panel.evaluate((element) => {
        element.scrollTop = 300;
    });

    expect(await panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    // Alerts, like Traffic, is taller than the panel, so a reset is observable there.
    await page.getByRole("link", { exact: true, name: "Alerts" }).click();

    await expect(page).toHaveURL(/\/alerts$/);
    await expect.poll(async () => panel.evaluate((element) => element.scrollTop)).toBe(0);
    // Guard against a vacuous pass: a destination too short to scroll clamps
    // `scrollTop` to 0 by itself.
    expect(await panel.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(300);
});

test("the time-range segmented control switches the window", async ({ page }) => {
    await openSeededOrganization(page);

    const range = page.getByRole("group", { name: "Time range" });
    const oneHour = range.getByRole("button", { exact: true, name: "1h" });

    // The default window is 24h; picking 1h presses it and releases 24h. Retried
    // because a press before hydration is dropped.
    await expect(range.getByRole("button", { exact: true, name: "24h" })).toHaveAttribute("aria-pressed", "true");
    await expect(async () => {
        await oneHour.click();
        await expect(oneHour).toHaveAttribute("aria-pressed", "true", { timeout: 2000 });
    }).toPass({ timeout: 90_000 });
    await expect(range.getByRole("button", { exact: true, name: "24h" })).toHaveAttribute("aria-pressed", "false");

    // Pressing the active segment again keeps a window chosen rather than emptying it.
    await oneHour.click();
    await expect(oneHour).toHaveAttribute("aria-pressed", "true");
});

test("the sidebar trigger slides the rail open and closed", async ({ page }) => {
    await openSeededOrganization(page);

    const trigger = page.getByRole("button", { name: "Toggle Sidebar" });

    // No cookie in the shared session: the icon rail is the default.
    await expect(sidebarOf(page)).toHaveAttribute("data-state", "collapsed");

    await driveTo(page, "expanded", async () => trigger.click());
    await driveTo(page, "collapsed", async () => trigger.click());
});

test("⌘B toggles the sidebar", async ({ page }) => {
    await openSeededOrganization(page);

    await expect(sidebarOf(page)).toHaveAttribute("data-state", "collapsed");

    await driveTo(page, "expanded", async () => page.keyboard.press("ControlOrMeta+b"));
    await driveTo(page, "collapsed", async () => page.keyboard.press("ControlOrMeta+b"));
});

test("a reload keeps the server-rendered sidebar state without a hydration error", async ({ page }) => {
    await openSeededOrganization(page);

    await driveTo(page, "expanded", async () => page.getByRole("button", { name: "Toggle Sidebar" }).click());

    // The toggle wrote the cookie; the server must now render the rail expanded in the
    // HTML itself, before any client code runs.
    const html = await (await page.request.get(page.url())).text();

    expect(html).toMatch(/data-slot="sidebar"[^>]*data-state="expanded"|data-state="expanded"[^>]*data-slot="sidebar"/);

    // Collected BEFORE the reload: React reports a mismatch once, on the first pass.
    const consoleErrors: string[] = [];

    page.on("console", (message) => {
        if (message.type() === "error") {
            consoleErrors.push(message.text());
        }
    });
    page.on("pageerror", (error) => {
        consoleErrors.push(error.message);
    });

    await page.reload();

    await expect(sidebarOf(page)).toHaveAttribute("data-state", "expanded");

    // The shortcut listener is attached in an effect, so a flip landing proves
    // hydration has finished — and with it, React's chance to report a mismatch.
    await driveTo(page, "collapsed", async () => page.keyboard.press("ControlOrMeta+b"));

    expect(
        consoleErrors.filter((text) => /hydrat/i.test(text)),
        "React reported a hydration mismatch after reloading with the sidebar expanded",
    ).toEqual([]);
});
