import { describe, expect, it, vi } from "vitest";

import type { ControlPlaneEnv } from "../src/control-plane-env";
import { controlPlaneWorker } from "../src/control-plane-worker";
import { buildAuth, ORIGIN } from "./_helpers/auth-harness";

// `currentAuth()` is set only by `ensureAuth` in production. The mock factory must
// not import the harness: the harness imports this same module.
const authRef = vi.hoisted(() => {
    return { current: null as Awaited<ReturnType<typeof buildAuth>> | null };
});

vi.mock(import("../src/auth"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/auth")>();

    return { ...actual, currentAuth: () => authRef.current };
});

describe(controlPlaneWorker, () => {
    it("does not keep a worker built before auth, so a later request still gets sign-in", async () => {
        expect.assertions(3);

        const env = { AUTH_SECRET: "lunora-unit-test-auth-secret-lunora-unit-test", AUTH_URL: ORIGIN, WORKER_ENV: "test" } as ControlPlaneEnv;
        // A scheduled tick as the isolate's first invocation: no auth yet.
        const cronWorker = controlPlaneWorker(env);

        authRef.current = await buildAuth();

        const requestWorker = controlPlaneWorker(env);
        const response = await requestWorker.fetch(new Request(`${ORIGIN}/api/auth/get-session`), env, { waitUntil: () => undefined });

        expect(requestWorker).not.toBe(cronWorker);
        expect(response.status).toBe(200);
        expect(controlPlaneWorker(env)).toBe(requestWorker);
    });
});
