import { expect, test } from "../fixtures/lunora.js";

/**
 * The copy-in auth screens (`lunora add auth-ui`) in a real browser, against the
 * real Miniflare-backed worker — the layer jsdom component tests can't reach:
 * a genuine form submit, a genuine `/api/auth/*` round trip, and the session
 * cookie flipping the app to its authenticated view.
 *
 * `?authui=1` mounts them beside the playground's hand-rolled login (see
 * `AuthUiDemo.tsx`), so the other specs keep driving that form.
 *
 * Failure modes covered:
 *   - sign-up through the card → session → authenticated view
 *   - sign-in through the card for an existing user
 *   - client-side validation stops an empty submit before any request
 *   - a bad password surfaces the mapped error on the card, not a blank screen
 */
const WORKER_URL = process.env.LUNORA_E2E_WORKER_URL ?? "http://localhost:5173";

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

/**
 * Pre-create a user through the API. Absolute URL + explicit `Origin` because
 * better-auth rejects cross-origin posts — without it the sign-up quietly fails
 * and the card, correctly, reports invalid credentials later.
 */
const signUpViaApi = async (page: import("@playwright/test").Page, email: string, password: string): Promise<void> => {
    const response = await page.request.post(`${WORKER_URL}/api/auth/sign-up/email`, {
        data: { email, name: email, password },
        headers: { Origin: WORKER_URL },
    });

    expect(response.status()).toBe(200);
};

const fill = async (page: import("@playwright/test").Page, label: string, value: string): Promise<void> => {
    await page.getByLabel(label, { exact: true }).fill(value);
};

/** Scoped to the card's form: the demo's nav has its own "Show …" buttons. */
const submit = async (page: import("@playwright/test").Page, name: string): Promise<void> => {
    await page.locator("form").getByRole("button", { name, exact: true }).click();
};

test("sign-up card creates an account and lands in the authenticated view", async ({ page }) => {
    await page.goto("/?authui=1");

    await page.getByRole("button", { name: "Show sign up", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();

    const email = `authui-signup-${Date.now()}@lunora.test`;

    await fill(page, "Name", "Auth UI Tester");
    await fill(page, "Email", email);
    await fill(page, "Password", "test-password-1234"); // gitleaks:allow
    await submit(page, "Create account");

    // The session cookie lands and <App> swaps to the chat view.
    await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible();
});

test("sign-in card authenticates an existing user", async ({ page }) => {
    const email = `authui-signin-${Date.now()}@lunora.test`;
    const password = "test-password-1234"; // gitleaks:allow

    await signUpViaApi(page, email, password);
    // Start from a clean jar so the card, not the cookie, does the signing in.
    await page.context().clearCookies();

    await page.goto("/?authui=1");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    await fill(page, "Email", email);
    await fill(page, "Password", password);
    await submit(page, "Sign in");

    await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible();
});

test("submitting an empty form validates client-side instead of calling the API", async ({ page }) => {
    await page.goto("/?authui=1");

    let authRequests = 0;

    page.on("request", (request) => {
        if (request.url().includes("/api/auth/sign-in")) {
            authRequests += 1;
        }
    });

    await submit(page, "Sign in");

    await expect(page.getByText("Email is required.")).toBeVisible();
    expect(authRequests).toBe(0);
});

test("a wrong password surfaces the mapped error on the card", async ({ page }) => {
    const email = `authui-badpw-${Date.now()}@lunora.test`;

    await signUpViaApi(page, email, "test-password-1234"); // gitleaks:allow
    await page.context().clearCookies();

    await page.goto("/?authui=1");
    await fill(page, "Email", email);
    await fill(page, "Password", "wrong-password-9999"); // gitleaks:allow
    await submit(page, "Sign in");

    // `mapAuthError` turns better-auth's code into the card's banner copy.
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Channels" })).toBeHidden();
});

/*
 * The signed-in half. `?authui=account` swaps the chat view for the account
 * cards (see `AuthUiAccount.tsx`), which is the only way these reach a browser —
 * the four specs above sign in and land in chat, and the jsdom suite never makes
 * a real `/api/auth/*` call.
 *
 * Only plugin-free cards are covered: the playground's client is a bare
 * `createAuthClient`, so passkeys, two-factor and organizations have no server
 * half here.
 */

/** Sign up through the API, then land on the account screen with that session. */
const signInToAccount = async (page: import("@playwright/test").Page, email: string, password: string): Promise<void> => {
    await signUpViaApi(page, email, password);
    await page.goto("/?authui=account");
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
};

test("profile card saves a new display name", async ({ page }) => {
    const email = `authui-profile-${Date.now()}@lunora.test`;

    await signInToAccount(page, email, "test-password-1234"); // gitleaks:allow

    await fill(page, "Name", "Renamed Tester");
    await page.locator("form").getByRole("button", { name: "Save changes", exact: true }).click();

    await expect(page.getByText("Your profile has been updated.")).toBeVisible();

    // Survives a reload, so it was persisted rather than only shown optimistically.
    await page.reload();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Renamed Tester");
});

test("change-password card rotates the password and the old one stops working", async ({ page }) => {
    const email = `authui-changepw-${Date.now()}@lunora.test`;
    const oldPassword = "test-password-1234"; // gitleaks:allow
    const newPassword = "test-password-5678"; // gitleaks:allow

    await signInToAccount(page, email, oldPassword);

    await fill(page, "Current password", oldPassword);
    await fill(page, "New password", newPassword);
    await fill(page, "Confirm password", newPassword);
    await page.locator("form").getByRole("button", { name: "Change password", exact: true }).click();

    await expect(page.getByText("Your password has been changed.")).toBeVisible();

    // The rotation was real: the old password no longer signs in.
    await page.context().clearCookies();
    await page.goto("/?authui=1");
    await fill(page, "Email", email);
    await fill(page, "Password", oldPassword);
    await submit(page, "Sign in");

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Channels" })).toBeHidden();
});

test("sessions card lists the session and revoking others leaves this one signed in", async ({ page }) => {
    const email = `authui-sessions-${Date.now()}@lunora.test`;

    await signInToAccount(page, email, "test-password-1234"); // gitleaks:allow

    const card = page.locator(".lunora-auth-card").filter({ has: page.getByRole("heading", { name: "Active sessions" }) });

    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Sign out other sessions", exact: true }).click();

    // Revoking *other* sessions must not revoke this one.
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
});

test("sign-out button clears the session and returns to the sign-in card", async ({ page }) => {
    const email = `authui-signout-${Date.now()}@lunora.test`;

    await signInToAccount(page, email, "test-password-1234"); // gitleaks:allow

    await page.getByRole("button", { name: "Sign out", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
