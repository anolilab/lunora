import { beforeAll, describe, expect, it, vi } from "vitest";

import { withLegacyCookieClearing } from "../src/auth-legacy-cookies";
import type { ControlPlaneEnv } from "../src/control-plane-env";
import { controlPlaneWorker } from "../src/control-plane-worker";
import { buildAuth, ORIGIN } from "./_helpers/auth-harness";

// The control plane's worker reads its better-auth instance from `currentAuth()`,
// which only `ensureAuth` sets in production. The mock factory must not import the
// harness: the harness imports this same module, and that cycle never resolves.
const authRef = vi.hoisted(() => {
    return { current: null as Awaited<ReturnType<typeof buildAuth>> | null };
});

vi.mock(import("../src/auth"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/auth")>();

    return { ...actual, currentAuth: () => authRef.current };
});

describe(withLegacyCookieClearing, () => {
    beforeAll(async () => {
        authRef.current = await buildAuth();
    });

    it("adds the clearing to an auth response when the request carries a legacy cookie", async () => {
        const handle = vi.fn<(request: Request) => Promise<Response | undefined>>(async () => new Response("ok"));
        const wrapped = withLegacyCookieClearing(handle);
        const response = await wrapped(
            new Request("https://cloud.lunora.app/api/auth/get-session", { headers: { cookie: "__Secure-better-auth.session_token=x" } }),
        );

        expect(handle).toHaveBeenCalledTimes(1);
        expect(response?.headers.getSetCookie().filter((line) => line.includes("Max-Age=0"))).toHaveLength(4);
    });

    it("passes an unhandled request through as undefined, without a clearing", async () => {
        const wrapped = withLegacyCookieClearing(async () => undefined);

        await expect(wrapped(new Request("https://cloud.lunora.app/studio"))).resolves.toBeUndefined();
    });

    it("clears the legacy cookies on the control plane's own /api/auth route", async () => {
        expect.assertions(2);

        const env = { AUTH_SECRET: "lunora-unit-test-auth-secret-lunora-unit-test", AUTH_URL: ORIGIN, WORKER_ENV: "test" } as ControlPlaneEnv;
        const response = await controlPlaneWorker(env).fetch(
            new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie: "__Secure-better-auth.session_token=stale" } }),
            env,
            { waitUntil: () => undefined },
        );
        const cleared = response.headers.getSetCookie().filter((line) => line.includes("Max-Age=0"));

        expect(cleared).toHaveLength(4);
        expect(cleared.every((line) => line.startsWith("__Secure-better-auth."))).toBe(true);
    });
});
