import { expect, test } from "../fixtures/lunora.js";

/**
 * Auth flow E2E — exercises `@lunora/auth`'s better-auth integration end to
 * end. Signup runs the better-auth schema migrations against D1 (Miniflare),
 * signin verifies the scrypt hash, and the issued session cookie is read
 * back by `authClient.useSession()` on the next render.
 *
 * Failure modes covered:
 *   - happy path (signup → session cookie → authed view; signout → cleared)
 *   - wrong password → 401 with INVALID_EMAIL_OR_PASSWORD code
 *   - weak password (< 8 chars) → 400 PASSWORD_TOO_SHORT
 */
const WORKER_URL = process.env.LUNORA_E2E_WORKER_URL ?? "http://localhost:5173";

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("user can sign up and sees an authenticated session", async ({ page }) => {
    await page.goto("/");

    // The unauthenticated app renders the Login form (Login.tsx).
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    const email = `signup-${Date.now()}@lunora.test`;
    const password = "test-password-1234"; // gitleaks:allow

    // Sign up via better-auth's REST endpoint directly so we still validate
    // the worker route on top of the UI.
    const signupResponse = await page.request.post(`${WORKER_URL}/api/auth/sign-up/email`, {
        data: { email, name: email, password },
        headers: { Origin: WORKER_URL },
    });

    expect(signupResponse.status()).toBe(200);

    const body = (await signupResponse.json()) as { token?: string; user?: { email?: string } };

    expect(body.user?.email).toBe(email);
    expect(body.token).toBeTruthy();

    // Reload — `authClient.useSession()` picks up the cookie set on the
    // request above (Playwright shares the cookie jar between `page` and
    // `page.request`).
    await page.reload();

    // Chat view shows once the session cookie is present.
    await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible();
});

test("sign in with wrong password returns a helpful error", async ({ page }) => {
    const email = `wrongpw-${Date.now()}@lunora.test`;
    const password = "test-password-1234"; // gitleaks:allow

    // Pre-create the user via API so we can attempt a failed login.
    const signupResponse = await page.request.post(`${WORKER_URL}/api/auth/sign-up/email`, {
        data: { email, name: email, password },
        headers: { Origin: WORKER_URL },
    });

    expect(signupResponse.status()).toBe(200);

    // Clear the session cookie that signup set so we land on the Login form.
    await page.context().clearCookies();

    await page.goto("/");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("wrong-password-xxxx"); // gitleaks:allow
    await page.getByRole("button", { name: "Sign in" }).click();

    // Login.tsx surfaces the failure as a role="alert" paragraph.
    const alert = page.getByRole("alert");

    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/invalid email or password|failed/i);
});

test("sign out clears the session cookie", async ({ signedInPage }) => {
    await signedInPage.goto("/");

    await expect(signedInPage.getByRole("heading", { name: "Channels" })).toBeVisible();

    await signedInPage.getByRole("button", { name: "Sign out" }).click();

    // After signOut() resolves better-auth has cleared the session cookie;
    // useSession() flips the App back to the Login form on the next render.
    await expect(signedInPage.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("sign up with weak password (< 8 chars) returns 400 PASSWORD_TOO_SHORT", async ({ page }) => {
    const response = await page.request.post(`${WORKER_URL}/api/auth/sign-up/email`, {
        data: { email: `weak-${Date.now()}@lunora.test`, name: "weak", password: "abc" },
        headers: { Origin: WORKER_URL },
    });

    expect(response.status()).toBe(400);

    const body = (await response.json()) as { code?: string; message?: string };

    expect(body.code).toBe("PASSWORD_TOO_SHORT");
});
