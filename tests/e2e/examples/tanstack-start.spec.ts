import type { Page } from "@playwright/test";
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
const waitForLive = async (page: Page): Promise<void> => {
    await expect(page.getByText("live", { exact: true })).toBeVisible();
};

const uniqueBody = (): string => `ssr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Everything the pages threw or logged as an error during the current test.
 *
 * Module scope is safe here: the examples config runs `workers: 1` with
 * `fullyParallel: false`, so exactly one test is ever in flight.
 */
let pageErrors: string[] = [];

/**
 * Fail the test on anything a page reports as an error.
 *
 * Both assertions below survive a hydration mismatch — the JS-free check reads
 * the server's HTML, and a live push re-renders whichever tree React ended up
 * with. So this example ran for a while emitting "Hydration failed because the
 * server rendered HTML didn't match the client" on every single load, React
 * discarding the server tree and re-rendering the page from scratch (the exact
 * opposite of the claim in the header comment), with every test green. An
 * error is the one signal that tells the two apart, so every page a test opens
 * is watched.
 */
const watchForErrors = (page: Page): Page => {
    page.on("pageerror", (error) => {
        pageErrors.push(`pageerror: ${error.message}`);
    });

    page.on("console", (message) => {
        if (message.type() === "error") {
            pageErrors.push(`console.error: ${message.text()}`);
        }
    });

    return page;
};

test.beforeEach(({ page }) => {
    pageErrors = [];
    watchForErrors(page);
});

test.afterEach(() => {
    expect(pageErrors).toEqual([]);
});

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

    const writer = watchForErrors(await browser.newPage());
    const body = uniqueBody();

    await writer.goto("/");
    await waitForLive(writer);
    await writer.getByLabel("Message").fill(body);
    await writer.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText(body)).toBeVisible();

    await writer.close();
});
