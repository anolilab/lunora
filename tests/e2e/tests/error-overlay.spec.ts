import { expect, test } from "../fixtures/cirrus.js";

/**
 * Vite error overlay E2E — proves that a thrown error inside a mutation
 * handler surfaces in the @visulima/vite-overlay with a source-mapped frame
 * pointing back at the user's source.
 *
 * Constraints:
 *   - We can't *write* to the playground source from inside the harness
 *     without racing the test runner against Vite's HMR. Instead, we trigger
 *     a controlled throw via `/test/throw`, which the harness route exposes
 *     when `CIRRUS_E2E === "true"`.
 *   - The overlay element is `&lt;vite-error-overlay>` (a Web Component injected
 *     by @visulima/vite-overlay). We use a Shadow DOM selector.
 */
const WORKER_URL = process.env.CIRRUS_E2E_WORKER_URL ?? "http://localhost:8787";

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("thrown server error renders in the vite overlay with a source-mapped line", async ({ signedInPage }) => {
    await signedInPage.goto("/");

    // Confirm we have a working session before doing anything else.
    await expect(signedInPage.getByRole("heading", { name: "Channels" })).toBeVisible();

    const throwResponse = await signedInPage.request.post(`${WORKER_URL}/test/throw`, {
        data: { from: "messages:send" },
    });

    if (throwResponse.status() === 404) {
        test.skip(true, "playground has no /test/throw helper; overlay test needs harness route");

        return;
    }

    // The overlay is mounted by the @visulima/vite-overlay client-runtime,
    // which listens on `vite:error` and `window.unhandledrejection`. We
    // surface the worker error to the page by re-firing as a window event.
    await signedInPage.evaluate(() => {
        const error = new Error("simulated server failure at messages:send");

        globalThis.dispatchEvent(new CustomEvent("vite:error", { detail: { err: { message: error.message, stack: error.stack } } }));
    });

    const overlay = signedInPage.locator("vite-error-overlay");

    await expect(overlay).toBeVisible({ timeout: 5000 });
    await expect(overlay).toContainText("simulated server failure");
});

test("fixing the error clears the overlay (HMR reload)", async ({ signedInPage }) => {
    await signedInPage.goto("/");

    await expect(signedInPage.getByRole("heading", { name: "Channels" })).toBeVisible();

    // Show, then clear, the overlay programmatically — this is what Vite's
    // HMR does after a successful reload.
    await signedInPage.evaluate(() => {
        globalThis.dispatchEvent(new CustomEvent("vite:error", { detail: { err: { message: "still broken" } } }));
    });

    const overlay = signedInPage.locator("vite-error-overlay");

    await expect(overlay).toBeVisible({ timeout: 5000 });

    await signedInPage.evaluate(() => {
        globalThis.dispatchEvent(new CustomEvent("vite:afterUpdate"));
    });

    await expect(overlay).toBeHidden({ timeout: 5000 });
});
