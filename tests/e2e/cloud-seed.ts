import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";

import { request } from "@playwright/test";

import { CLOUD_BASE_URL, CLOUD_STORAGE_STATE, cloudSkipReason, DEV_EMAIL, DEV_PASSWORD } from "./cloud-setup";

/**
 * Seed the control plane before the browser suite runs.
 *
 * A cold control plane is not merely empty, it is unusable: `organizations:create`
 * places every organization on a **cell**, and a fleet with no cell fails the first
 * thing a new account does. `apps/cloud/scripts/seed.ts` fixes that through the real
 * surfaces (better-auth for the user, the admin-token route for the cell, public RPC
 * for the rest), so what the spec then drives is state a user could have created.
 *
 * It talks HTTP to a running server, so this runs after Playwright's `webServer` has
 * booted — and it is idempotent, so a re-run against a persisted `.wrangler/state`
 * reports "(exists)" rather than duplicating the fixture.
 *
 * It then signs that account in ONCE and saves the session for the whole suite (see
 * {@link CLOUD_STORAGE_STATE}).
 */
const SEED_TIMEOUT_MS = 180_000;

/**
 * Sign the seeded account in and persist the cookie jar the tests start from.
 *
 * `Origin` is mandatory: better-auth rejects a cookie-bearing unsafe-method request
 * that names no origin, and an API context sends none of its own.
 */
const saveSignedInState = async (): Promise<void> => {
    const context = await request.newContext({ baseURL: CLOUD_BASE_URL, extraHTTPHeaders: { Origin: CLOUD_BASE_URL } });
    const response = await context.post("/api/auth/sign-in/email", { data: { email: DEV_EMAIL, password: DEV_PASSWORD } });

    if (!response.ok()) {
        const body = await response.text();

        await context.dispose();

        throw new Error(`[cloud-e2e] sign-in as the seeded dev account failed (${String(response.status())}): ${body}`);
    }

    await context.storageState({ path: CLOUD_STORAGE_STATE });
    await context.dispose();
};

const globalSetup = async (): Promise<void> => {
    if (cloudSkipReason() !== undefined) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        execFile(
            "pnpm",
            ["--filter", "@lunora/cloud", "run", "seed"],
            { encoding: "utf8", env: { ...process.env, LUNORA_SEED_URL: CLOUD_BASE_URL }, timeout: SEED_TIMEOUT_MS },
            (error: ExecFileException | null, stdout: string, stderr: string) => {
                if (error) {
                    // The seed doubles as a smoke test of every path a cold start
                    // depends on, so its failure is a real defect — fail the run with
                    // its output rather than leaving the specs to fail on an empty
                    // dashboard and say nothing about why.
                    reject(new Error(`[cloud-e2e] seed failed:\n${stdout}\n${stderr}`));

                    return;
                }

                resolve();
            },
        );
    });

    await saveSignedInState();
};

export default globalSetup;
