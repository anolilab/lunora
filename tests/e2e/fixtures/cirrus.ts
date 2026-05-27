import type { Page } from "@playwright/test";
import { test as base } from "@playwright/test";

/**
 * Cirrus-specific Playwright fixtures.
 *
 * These centralise the bits of plumbing that every test needs:
 *   - `resetServer`  — call the `/test/reset` route exposed by the playground
 *     worker (gated by `CIRRUS_E2E === "true"`). Clears DO state so tests are
 *     order-independent.
 *   - `signedInPage` — a Page that already has an authenticated session
 *     cookie. Most chat tests skip the signup form and use this.
 *   - `channel`      — creates a channel via the RPC layer and returns its id
 *     so tests can deep-link into it.
 *
 * Why an RPC-level fixture instead of clicking through the UI?
 *   - The UI walkthrough is *itself* covered by `auth.spec.ts`. Other suites
 *     shouldn't re-test that flow — they want a deterministic logged-in user
 *     in O(1) steps.
 */
const WORKER_URL = process.env.CIRRUS_E2E_WORKER_URL ?? "http://localhost:8787";

export interface TestUser {
    readonly email: string;
    readonly password: string;
    readonly token: string;
}

export interface CirrusFixtures {
    resetServer: () => Promise<void>;
    signedInPage: Page;
    user: TestUser;
}

export const resetServer = async (): Promise<void> => {
    const response = await fetch(`${WORKER_URL}/test/reset`, { method: "POST" });

    if (!response.ok) {
        throw new Error(`/test/reset failed (${response.status})`);
    }
};

const signUp = async (email: string, password: string): Promise<string> => {
    const response = await fetch(`${WORKER_URL}/auth/signup`, {
        body: JSON.stringify({ email, password }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok) {
        throw new Error(`/auth/signup failed (${response.status})`);
    }

    const body = (await response.json()) as { token?: string };

    if (!body.token) {
        throw new Error("signup response missing token");
    }

    return body.token;
};

export const test = base.extend<CirrusFixtures>({
    resetServer: async ({}, use) => {
        await use(resetServer);
    },
    signedInPage: async ({ page, user }, use) => {
        // Seed the auth token before the React app mounts so `useAuth()` sees
        // it on first render. The playground stores tokens in localStorage
        // keyed by "cirrus.token" (see @cirrus/react default config).
        await page.addInitScript((token) => {
            globalThis.localStorage.setItem("cirrus.token", token);
        }, user.token);

        await use(page);
    },
    user: async ({}, use, testInfo) => {
        // Deterministic per-test email so parallel projects (chromium / firefox)
        // don't collide if they ever do run together.
        const slug = testInfo.titlePath
            .join("-")
            .replaceAll(/[^a-z0-9]/gi, "-")
            .toLowerCase();
        const email = `e2e+${slug}-${Date.now()}@cirrus.test`;
        const password = "test-password-1234";
        const token = await signUp(email, password);

        await use({ email, password, token });
    },
});

export const { expect } = test;
