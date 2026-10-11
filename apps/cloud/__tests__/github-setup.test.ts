import { LunoraError } from "@lunora/server";
import { describe, expect, it, vi } from "vitest";

import type { SetupOutcome } from "../src/github/setup-flow";
import { completeInstall, startInstall } from "../src/github/setup-flow";
import { signSetupState, verifySetupState } from "../src/github/setup-state";

/**
 * The GitHub App install flow. A staged installation is bound to an organization
 * only by the signed callback, so the tests pin what that callback refuses: a
 * tampered, expired or wrong-user state, a missing secret, and a bind with no
 * state at all, which is what a direct claim by an attacker looks like.
 */

const NOW = 1_700_000_000_000;
const SECRET = "secret-one";
const MINUTE = 60 * 1000;

interface StateOverrides {
    expiresAt: number;
    organizationId: string;
    userId: string;
}

const signed = (over: Partial<StateOverrides> = {}, secret = SECRET): Promise<string> =>
    signSetupState({ expiresAt: NOW + 10 * MINUTE, nonce: "nonce-1", organizationId: "org_1", userId: "usr_1", ...over }, secret);

/** Flip the last hex digit of the payload, so the MAC no longer covers it. */
const tampered = (token: string): string => {
    const [payload = "", mac = ""] = token.split(".");
    const last = payload.endsWith("0") ? "1" : "0";

    return `${payload.slice(0, -1)}${last}.${mac}`;
};

/** The value of a successful step; a refusal fails the test. */
const valueOf = <T>(outcome: SetupOutcome<T>): T => {
    if (!outcome.ok) {
        throw new Error(`expected success, got ${String(outcome.status)}: ${outcome.error}`);
    }

    return outcome.value;
};

describe("the signed install state", () => {
    it("verifies a state it signed and returns exactly what it named", async () => {
        const token = await signed();

        await expect(verifySetupState(token, SECRET, NOW)).resolves.toStrictEqual({
            expiresAt: NOW + 10 * MINUTE,
            nonce: "nonce-1",
            organizationId: "org_1",
            userId: "usr_1",
        });
    });

    it("refuses a payload changed after signing", async () => {
        await expect(verifySetupState(tampered(await signed()), SECRET, NOW)).resolves.toBeNull();
    });

    it("refuses a state past its expiry", async () => {
        await expect(verifySetupState(await signed({ expiresAt: NOW - 1 }), SECRET, NOW)).resolves.toBeNull();
    });

    it("refuses a state signed under another secret", async () => {
        await expect(verifySetupState(await signed({}, "secret-two"), SECRET, NOW)).resolves.toBeNull();
    });

    it("refuses a token that is not in the signed shape", async () => {
        await expect(verifySetupState("not-a-token", SECRET, NOW)).resolves.toBeNull();
    });

    it("refuses to sign or verify at all without a secret, so an empty key never vouches for anything", async () => {
        await expect(signed({}, "")).rejects.toThrow("GITHUB_SETUP_STATE_SECRET is not configured");
        await expect(verifySetupState(await signed(), undefined, NOW)).rejects.toThrow("GITHUB_SETUP_STATE_SECRET is not configured");
    });
});

describe(startInstall, () => {
    const start = (over: Partial<Parameters<typeof startInstall>[0]> = {}) =>
        startInstall({ allowed: true, appSlug: "lunora-cloud", nonce: "nonce-1", now: NOW, organizationId: "org_1", secret: SECRET, userId: "usr_1", ...over });

    it("redirects an owner or admin to the App's install page, carrying a state that names them", async () => {
        const url = new URL(valueOf(await start()));

        expect(`${url.origin}${url.pathname}`).toBe("https://github.com/apps/lunora-cloud/installations/new");
        await expect(verifySetupState(url.searchParams.get("state") ?? "", SECRET, NOW)).resolves.toMatchObject({
            organizationId: "org_1",
            userId: "usr_1",
        });
    });

    it("refuses to start without the state secret", async () => {
        await expect(start({ secret: undefined })).resolves.toMatchObject({ ok: false, status: 500 });
    });

    it("refuses to start without the App's slug", async () => {
        await expect(start({ appSlug: undefined })).resolves.toMatchObject({ ok: false, status: 500 });
    });

    it("refuses a member who is neither owner nor admin", async () => {
        await expect(start({ allowed: false })).resolves.toMatchObject({ ok: false, status: 403 });
    });
});

describe(completeInstall, () => {
    type Bind = (installationId: number, organizationId: string, userId: string) => Promise<void>;

    const complete = (over: Partial<Parameters<typeof completeInstall>[0]> = {}, bind = vi.fn<Bind>(() => Promise.resolve())) =>
        completeInstall({
            bind,
            installationId: "42",
            isOwnerOrAdmin: () => Promise.resolve(true),
            now: NOW,
            secret: SECRET,
            sessionUserId: "usr_1",
            setupAction: "install",
            state: null,
            ...over,
        });

    it("binds the installation when the state verifies and the session user still administers the org", async () => {
        const bind = vi.fn<Bind>(() => Promise.resolve());
        const outcome = await complete({ state: await signed() }, bind);

        expect(outcome).toStrictEqual({ ok: true, value: { installationId: 42, organizationId: "org_1" } });
        expect(bind).toHaveBeenCalledWith(42, "org_1", "usr_1");
    });

    it("refuses a tampered state and binds nothing", async () => {
        const bind = vi.fn<Bind>(() => Promise.resolve());

        await expect(complete({ state: tampered(await signed()) }, bind)).resolves.toMatchObject({ ok: false, status: 403 });
        expect(bind).not.toHaveBeenCalled();
    });

    it("refuses an expired state and binds nothing", async () => {
        const bind = vi.fn<Bind>(() => Promise.resolve());

        await expect(complete({ state: await signed({ expiresAt: NOW - 1 }) }, bind)).resolves.toMatchObject({ ok: false, status: 403 });
        expect(bind).not.toHaveBeenCalled();
    });

    it("refuses a session that is not the user the state names", async () => {
        const bind = vi.fn<Bind>(() => Promise.resolve());

        await expect(complete({ sessionUserId: "usr_2", state: await signed() }, bind)).resolves.toMatchObject({ ok: false, status: 403 });
        expect(bind).not.toHaveBeenCalled();
    });

    it("refuses when the state's user has since lost the owner or admin role", async () => {
        const bind = vi.fn<Bind>(() => Promise.resolve());

        await expect(complete({ isOwnerOrAdmin: () => Promise.resolve(false), state: await signed() }, bind)).resolves.toMatchObject({
            ok: false,
            status: 403,
        });
        expect(bind).not.toHaveBeenCalled();
    });

    it("refuses to bind without the state secret", async () => {
        const bind = vi.fn<Bind>(() => Promise.resolve());

        await expect(complete({ secret: undefined, state: await signed() }, bind)).resolves.toMatchObject({ ok: false, status: 500 });
        expect(bind).not.toHaveBeenCalled();
    });

    /** The attacker's direct claim: an installation id and a session, with no state from a start the attacker made for their own org. */
    it("refuses an attacker's direct claim that carries no state", async () => {
        const bind = vi.fn<Bind>(() => Promise.resolve());

        await expect(complete({ state: null }, bind)).resolves.toMatchObject({ ok: false, status: 403 });
        expect(bind).not.toHaveBeenCalled();
    });

    it("refuses a callback that is not an install", async () => {
        await expect(complete({ setupAction: "update", state: await signed() })).resolves.toMatchObject({ ok: false, status: 400 });
    });

    it("refuses a non-numeric installation id", async () => {
        await expect(complete({ installationId: "4x2", state: await signed() })).resolves.toMatchObject({ ok: false, status: 400 });
    });

    it("reports an installation GitHub has not reported yet, rather than binding it", async () => {
        const bind = vi.fn<Bind>(() => Promise.reject(new LunoraError("NOT_FOUND", "installation not found")));

        await expect(complete({ state: await signed() }, bind)).resolves.toMatchObject({ ok: false, status: 404 });
    });

    it("reports an installation already claimed by another organization", async () => {
        const bind = vi.fn<Bind>(() => Promise.reject(new LunoraError("CONFLICT", "installation is already claimed by another organization")));

        await expect(complete({ state: await signed() }, bind)).resolves.toMatchObject({ ok: false, status: 409 });
    });
});
