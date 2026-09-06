import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test as base, request as requestApi } from "@playwright/test";

/**
 * Lunora-specific Playwright fixtures.
 *
 * These centralise the bits of plumbing that every test needs:
 *   - `resetServer`  — call the `/test/reset` route exposed by the playground
 *     worker (gated by `LUNORA_E2E === "true"`). Clears the shared **D1** state
 *     (users, channels, every `.global()` table). It does NOT clear Durable
 *     Object state — shard-local rows such as `messages` survive it, and stay
 *     out of each other's way only because every spec mints a fresh channel. A
 *     spec that needs a clean shard has to mint one, not rely on this.
 *   - `signedInPage` — a Page whose BrowserContext already holds the
 *     better-auth `session_token` cookie. Most chat tests skip the signup
 *     form and use this.
 *   - `user`         — creates a user via better-auth's API and exposes the
 *     credentials + a worker-scoped APIRequest context that owns the cookie
 *     jar, so tests can issue authenticated RPCs without a UI round-trip.
 *
 * Why an RPC-level fixture instead of clicking through the UI?
 *   - The UI walkthrough is *itself* covered by `auth.spec.ts`. Other suites
 *     shouldn't re-test that flow — they want a deterministic logged-in user
 *     in O(1) steps.
 */
const WORKER_URL = process.env.LUNORA_E2E_WORKER_URL ?? "http://localhost:5173";

export interface TestUser {
    readonly email: string;
    readonly name: string;
    readonly password: string;
    /** APIRequest context with the better-auth session cookie pre-loaded. */
    readonly request: APIRequestContext;
}

export interface LunoraFixtures {
    /**
     * Factory for ADDITIONAL users beyond the default `user` fixture — the
     * multi-user specs (auth-rls, sharding convergence) need two distinct
     * identities. Each call signs up a fresh user; the returned request
     * context carries that user's session cookie. Contexts are disposed on
     * fixture teardown.
     */
    makeUser: (label: string) => Promise<TestUser>;
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

/**
 * Sign up via better-auth's `/api/auth/sign-up/email` endpoint. better-auth
 * responds with `Set-Cookie: better-auth.session_token=…`, which the supplied
 * `request` context captures into its storage state so subsequent calls (and
 * any `BrowserContext` initialised from the same `storageState`) are signed
 * in automatically.
 */
const signUp = async (request: APIRequestContext, email: string, password: string, name: string): Promise<void> => {
    const response = await request.post(`${WORKER_URL}/api/auth/sign-up/email`, {
        data: { email, name, password },
    });

    if (!response.ok()) {
        const body = await response.text();

        throw new Error(`/api/auth/sign-up/email failed (${response.status()}): ${body}`);
    }
};

/** Slugify a test title path into an email-safe marker. */
const emailSlug = (parts: ReadonlyArray<string>): string =>
    parts
        .join("-")
        .replaceAll(/[^a-z0-9]/gi, "-")
        .toLowerCase();

export const test = base.extend<LunoraFixtures>({
    makeUser: async ({}, use, testInfo) => {
        const contexts: APIRequestContext[] = [];

        const factory = async (label: string): Promise<TestUser> => {
            const slug = emailSlug([...testInfo.titlePath, label]);
            const email = `e2e+${slug}-${Date.now()}@lunora.test`;
            const password = "test-password-1234"; // gitleaks:allow
            const name = `e2e ${slug}`;
            const request = await requestApi.newContext({ baseURL: WORKER_URL, extraHTTPHeaders: { Origin: WORKER_URL } });

            contexts.push(request);
            await signUp(request, email, password, name);

            return { email, name, password, request };
        };

        await use(factory);

        await Promise.all(contexts.map(async (context) => context.dispose()));
    },
    resetServer: async ({}, use) => {
        await use(resetServer);
    },
    signedInPage: async ({ browser, user }, use) => {
        // Spin up a context seeded with the cookie jar accumulated during
        // `user` setup. The session cookie hops over to the browser side so
        // `authClient.useSession()` resolves on first render.
        const storageState = await user.request.storageState();
        const context: BrowserContext = await browser.newContext({ storageState });
        const page = await context.newPage();

        await use(page);
        await context.close();
    },
    user: async ({}, use, testInfo) => {
        // Deterministic per-test email so parallel projects (chromium / firefox)
        // don't collide if they ever do run together.
        const slug = emailSlug(testInfo.titlePath);
        const email = `e2e+${slug}-${Date.now()}@lunora.test`;
        const password = "test-password-1234"; // gitleaks:allow
        const name = `e2e ${slug}`;
        // Real browsers send an `Origin` header; Playwright's API context does
        // not. better-auth's CSRF check requires it, so set a trusted one (the
        // worker origin) for these setup-only API calls.
        const request = await requestApi.newContext({ baseURL: WORKER_URL, extraHTTPHeaders: { Origin: WORKER_URL } });

        await signUp(request, email, password, name);

        await use({ email, name, password, request });
        await request.dispose();
    },
});

export const { expect } = test;
