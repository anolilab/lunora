import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { cloudSkipReason, DEV_EMAIL, DEV_PASSWORD } from "../cloud-setup";

/**
 * The Lunora Cloud control plane (`apps/cloud`) in a real browser, against a real
 * seeded database — the layer its 80-odd unit suites cannot reach.
 *
 * Why it exists: the hosted studio is server-rendered by TanStack Start on top of
 * the control-plane Worker, so the two things most likely to break it are invisible
 * to unit tests. One is the SSR/hydration seam — a reactive `useQuery` on a
 * loader-free route diverges between the server pass and the first client pass, and
 * React answers by discarding the whole tree, with a console error and a working-ish
 * page as the only symptom. The other is the org list: `organizations.list` now
 * resolves the caller's memberships and fetches each org BY ID, and the shape of
 * that answer is only observable end to end — a regression there empties the
 * switcher for everyone, and every dashboard route hangs off it.
 *
 * What each test proves:
 *   - sign-in — the seeded dev account signs in through the real form and lands on
 *     the org picker, which is `organizations.list` server-rendered.
 *   - org switcher — the sidebar switcher on a per-org route lists the seeded org.
 *     That is the SECOND `organizations.list` read (the `$organizationId` layout's
 *     loader), so a by-id read that silently returned nothing would show here.
 *   - deployments — drilling into a project renders its Deployments table with the
 *     seeded live production deployment.
 *   - traffic — the Traffic tab survives a full server-rendered load with no
 *     hydration error on the console. The live half is `ClientOnly`-wrapped
 *     precisely so it can; unwrapping it puts the error back.
 *
 * The fixture is whatever `apps/cloud/scripts/seed.ts` creates (see `cloud-seed.ts`),
 * which is state a user could have created — it seeds through the real surfaces. The
 * same setup signs that account in once and the config hands every test that session,
 * so only the sign-in test itself starts signed out.
 *
 * Deliberately NOT covered: creating a project through the UI. Quota is resolved
 * from live subscription state, and with no billing provider locally the seeded org
 * resolves to the free plan's limit of ONE project — which the seed's own project
 * already occupies. Covering it would mean forging a provider webhook to buy a
 * higher limit, and would still accumulate a row per run against persisted local
 * state. `apps/cloud/__tests__/plans.test.ts` and `entitlements.test.ts` own that path.
 */
const SKIP = cloudSkipReason();

test.skip(SKIP !== undefined, SKIP ?? "");

const ORG_NAME = "Acme Dev";
const PROJECT_NAME = "Web";
/** The seeded deployment's URL, as the Deployments table renders it (protocol stripped). */
const DEPLOYMENT_URL = "web.acme-dev.test";

/** Path of a per-org route: the id, not the slug, is the URL segment. */
const ORG_ROUTE = /\/orgs\/[^/]+\/projects/;

/**
 * Interact, then wait for the app to act on it — retrying the interaction until it does.
 *
 * Every screen here is SERVER-rendered, so its controls are in the DOM, visible and
 * enabled well before React has hydrated, and a click that lands in that window is
 * simply dropped: the row's `onClick` is not attached yet, so nothing happens and the
 * assertion after it waits forever on a page that will never change. (Every test in
 * this file failed exactly that way before this helper existed.)
 *
 * A fixed pause would be a guess about hydration cost on the slowest runner. `toPass`
 * retries the whole interaction instead, so the first attempt that lands after
 * hydration wins and a fast machine pays nothing.
 */
const actUntil = async (act: () => Promise<void>, settled: () => Promise<void>): Promise<void> => {
    await expect(async () => {
        await act();
        await settled();
    }).toPass({ timeout: 90_000 });
};

/**
 * Pick the seeded organization off the picker and return its id.
 *
 * The click-through is deliberate rather than reading the id out of the API: it is
 * the same two `organizations.list` reads a visitor makes, so a test that only
 * needed the id still exercises them.
 */
const openSeededOrganization = async (page: Page): Promise<string> => {
    await page.goto("/");

    await actUntil(
        async () => page.getByRole("button", { name: new RegExp(ORG_NAME) }).click(),
        async () => expect(page).toHaveURL(ORG_ROUTE, { timeout: 20_000 }),
    );

    const organizationId = new URL(page.url()).pathname.split("/")[2];

    expect(organizationId, "no organization id in the dashboard URL").toBeTruthy();

    return organizationId as string;
};

/**
 * The one test that must NOT start from the shared session — it is the sign-in form
 * itself under test, so it needs an empty cookie jar.
 */
test.describe("signed out", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("the seeded dev account signs in and lands on the organization picker", async ({ page }) => {
        await page.goto("/");

        // Anonymous visitors are bounced to /login by the `_authed` guard, on the server.
        await expect(page).toHaveURL(/\/login/);
        await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

        // Re-filled on each attempt: a submit that lands before hydration is a NATIVE
        // form submit, which reloads `/login` and clears both fields. The settled check
        // is the destination screen, and it is generous, because the card signs in and
        // then does a FULL load of `/` (so the new cookie is on the SSR request) — a
        // whole server render of a cold route stands between the click and the answer.
        await actUntil(
            async () => {
                const email = page.getByLabel("Email", { exact: true });

                // Gone already: an earlier attempt's submit is in flight, so there is
                // nothing to type into and the settled check just waits it out.
                if ((await email.count()) === 0) {
                    return;
                }

                await email.fill(DEV_EMAIL);
                await page.getByLabel("Password", { exact: true }).fill(DEV_PASSWORD);
                // Scoped to the card's form: the screen's footer has its own "sign in" affordance.
                await page.locator("form").getByRole("button", { name: "Sign in", exact: true }).click();
            },
            // The picker is the signed-in landing page, server-rendered from
            // `organizations.list` — so the seeded org is in the first byte.
            async () => expect(page.getByRole("heading", { name: /your organizations/i })).toBeVisible({ timeout: 20_000 }),
        );

        await expect(page.getByRole("button", { name: new RegExp(ORG_NAME) })).toBeVisible();
    });
});

test("the sidebar org switcher lists the seeded organization", async ({ page }) => {
    await openSeededOrganization(page);

    // A native <details> disclosure, so it works before hydration too.
    const switcher = page
        .locator("details")
        .filter({ has: page.locator("summary") })
        .first();

    await expect(switcher.locator("summary")).toContainText(ORG_NAME);

    await switcher.locator("summary").click();

    // Expanded: every org the caller is a member of, as a link to its Projects tab.
    await expect(switcher.getByRole("link", { name: new RegExp(ORG_NAME) })).toBeVisible();
    await expect(switcher.getByRole("link", { name: new RegExp(ORG_NAME) })).toHaveAttribute("href", ORG_ROUTE);
});

test("a project's Deployments tab renders the seeded live deployment", async ({ page }) => {
    const organizationId = await openSeededOrganization(page);

    // A full load of the tab, not a client navigation — the route server-renders.
    await page.goto(`/orgs/${organizationId}/projects`);

    // Drilling in is client state, not a route change — so the settled check is the
    // deployments card, not a URL.
    await actUntil(
        async () => page.getByRole("button", { name: new RegExp(`^${PROJECT_NAME} /`) }).click(),
        async () => expect(page.getByText("Deployments", { exact: true })).toBeVisible({ timeout: 20_000 }),
    );

    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();

    // The seeded production deployment, driven all the way to `live` by the seed.
    const row = page.getByRole("row").filter({ hasText: DEPLOYMENT_URL });

    await expect(row).toContainText("production");
    await expect(row).toContainText("live");
});

test("the Traffic tab server-renders and hydrates without a hydration error", async ({ page }) => {
    const organizationId = await openSeededOrganization(page);

    // Collect BEFORE the navigation: React reports a hydration mismatch once, on the
    // first client pass, and never again.
    const consoleErrors: string[] = [];

    page.on("console", (message) => {
        if (message.type() === "error") {
            consoleErrors.push(message.text());
        }
    });
    page.on("pageerror", (error) => {
        consoleErrors.push(error.message);
    });

    await page.goto(`/orgs/${organizationId}/traffic`);

    // Asserted on the parts of the tab that render unconditionally. The breakdown
    // cards ("Visitors by country" and friends) need Analytics-Engine credentials a
    // local worker does not have, and the section is deliberately built so that no
    // STRUCTURAL choice depends on that read — which is the same property this test
    // is here to protect.
    await expect(page.getByText("Live requests", { exact: true })).toBeVisible();
    await expect(page.getByText("p50 latency", { exact: true })).toBeVisible();
    // Both `[Loading…]` placeholders clearing IS hydration finishing: the live one is
    // the `ClientOnly` fallback the server and the first client pass both render, and
    // only the second client pass replaces. Asserting after it means a mismatch has
    // had its chance to be reported.
    // `toHaveCount(0)`, not `toBeHidden`: there are two placeholders (the snapshot's
    // and the live stream's) and a hidden-check over two nodes is a strict-mode error.
    await expect(page.getByText("[Loading…]")).toHaveCount(0);

    expect(
        consoleErrors.filter((text) => /hydrat/i.test(text)),
        "React reported a hydration mismatch on the Traffic tab",
    ).toEqual([]);
});
