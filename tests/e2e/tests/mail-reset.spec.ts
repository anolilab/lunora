import { extractLink, waitForMail } from "@lunora/mail/testing";

import { expect, test } from "../fixtures/lunora.js";

/**
 * Forgot-password E2E through the dev mail catcher.
 *
 * The playground routes better-auth's `sendResetPassword` through `@lunora/mail`
 * (`createMailerFromEnv`). Under the E2E run `LUNORA_MAIL_CAPTURE=1` (see
 * `globalSetup.ts`), so the reset email is captured into the studio's root-shard
 * inbox instead of being delivered. This test drives the real flow: request a
 * reset → read the captured mail over the admin RPC (`@lunora/mail/testing`) →
 * follow the link's token → set a new password → sign in with it.
 */
const WORKER_URL = process.env.LUNORA_E2E_WORKER_URL ?? "http://localhost:5173";
/** Must match `LUNORA_ADMIN_TOKEN` written into the E2E `.dev.vars` by `globalSetup.ts`. */
const ADMIN_TOKEN = "e2e-deterministic-admin-token";

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("forgot-password email is captured and its reset link sets a new password", async ({ page }) => {
    const email = `reset-${Date.now()}@lunora.test`;
    const password = "test-password-1234"; // gitleaks:allow

    // Create the account.
    const signup = await page.request.post(`${WORKER_URL}/api/auth/sign-up/email`, {
        data: { email, name: email, password },
        headers: { Origin: WORKER_URL },
    });

    expect(signup.status()).toBe(200);

    // Request a password reset — better-auth fires `sendResetPassword`, which the
    // playground sends via @lunora/mail. In the E2E run that's captured, not sent.
    // better-auth ≥1.6 serves this at `/request-password-reset` (the old
    // `/forget-password` path was removed and 404s — see
    // packages/auth/__tests__/forget-password-route.test.ts).
    const forgot = await page.request.post(`${WORKER_URL}/api/auth/request-password-reset`, {
        data: { email, redirectTo: `${WORKER_URL}/reset` },
        headers: { Origin: WORKER_URL },
    });

    expect(forgot.status()).toBe(200);

    // Read the captured reset email from the studio inbox over the admin RPC.
    const mail = await waitForMail({ adminToken: ADMIN_TOKEN, baseUrl: WORKER_URL, subjectMatch: "Reset", timeoutMs: 15_000, to: email });
    const resetLink = extractLink(mail);

    expect(resetLink).toContain(WORKER_URL);

    // Pull the token out (handles both `?token=…` and `/reset-password/<token>` link shapes).
    const token = new URL(resetLink).searchParams.get("token") ?? resetLink.split("?")[0]?.split("/").pop();

    expect(token).toBeTruthy();

    // Complete the reset, then confirm the new password authenticates.
    const newPassword = "new-password-5678"; // gitleaks:allow
    const reset = await page.request.post(`${WORKER_URL}/api/auth/reset-password`, {
        data: { newPassword, token },
        headers: { Origin: WORKER_URL },
    });

    expect(reset.status()).toBe(200);

    const signin = await page.request.post(`${WORKER_URL}/api/auth/sign-in/email`, {
        data: { email, password: newPassword },
        headers: { Origin: WORKER_URL },
    });

    expect(signin.status()).toBe(200);
});
