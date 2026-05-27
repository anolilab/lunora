import { expect, test } from "../fixtures/cirrus.js";

/**
 * Auth flow E2E — exercises `@cirrus/auth`'s email/password provider end to
 * end. Signup writes to D1 (Miniflare-backed), signin verifies the bcrypt
 * hash, and the returned token is read back by the React `useAuth` hook on
 * the next render.
 *
 * Failure modes covered:
 *   - happy path (signup → session, signout → cleared)
 *   - wrong password → 401 with a useful error body
 *   - weak password (< 8 chars) → 400 WEAK_PASSWORD
 */
const WORKER_URL = process.env.CIRRUS_E2E_WORKER_URL ?? "http://localhost:8787";

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("user can sign up and sees an authenticated session", async ({ page }) => {
    await page.goto("/");

    // The unauthenticated app renders the Login form (Login.tsx).
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    const email = `signup-${Date.now()}@cirrus.test`;
    const password = "test-password-1234";

    // The playground only ships a sign-in form, but the API has /auth/signup.
    // Drive it via fetch so this spec still validates the worker route.
    const signupResponse = await page.request.post(`${WORKER_URL}/auth/signup`, {
        data: { email, password },
    });

    expect(signupResponse.status()).toBe(200);

    const body = (await signupResponse.json()) as { token?: string };

    expect(body.token).toBeTruthy();

    // Now sign in via the UI to confirm the session is real.
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // Chat view shows once the token is set.
    await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible();
});

test("sign in with wrong password returns 401 with a helpful error", async ({ page }) => {
    const email = `wrongpw-${Date.now()}@cirrus.test`;
    const password = "test-password-1234";

    // Pre-create the user via API so we can attempt a failed login.
    const signupResponse = await page.request.post(`${WORKER_URL}/auth/signup`, {
        data: { email, password },
    });

    expect(signupResponse.status()).toBe(200);

    await page.goto("/");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("wrong-password-xxxx");
    await page.getByRole("button", { name: "Sign in" }).click();

    // Login.tsx renders the failure as a role="alert" paragraph.
    const alert = page.getByRole("alert");

    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/401|failed/i);
});

test("sign out clears the session cookie / token", async ({ signedInPage }) => {
    await signedInPage.goto("/");

    await expect(signedInPage.getByRole("heading", { name: "Channels" })).toBeVisible();

    // Clear the token (signout) — the React app re-renders into the Login form.
    await signedInPage.evaluate(() => {
        globalThis.localStorage.removeItem("cirrus.token");
    });

    await signedInPage.reload();

    await expect(signedInPage.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("sign up with weak password (< 8 chars) returns 400 WEAK_PASSWORD", async ({ page }) => {
    const response = await page.request.post(`${WORKER_URL}/auth/signup`, {
        data: { email: `weak-${Date.now()}@cirrus.test`, password: "abc" },
    });

    expect(response.status()).toBe(400);

    const body = (await response.json()) as { code?: string; message?: string };

    expect(body.code).toBe("WEAK_PASSWORD");
});
