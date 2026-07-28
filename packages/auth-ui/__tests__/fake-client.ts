/**
 * A stub better-auth client shared by every port's component tests.
 *
 * Both register their plugin set the way `lunora/auth-ui/client.ts` does, which
 * is the only thing the flow gate reads — a real client is a dynamic-path proxy
 * with nothing to inspect, so the fixtures must not pretend otherwise.
 */
import { vi } from "vitest";

import type { AuthClient, AuthResponse } from "../src/core";
import { registerAuthClientPlugins } from "../src/core";

const ok = <T>(data: T = null as T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });

interface FakeClient {
    client: AuthClient;
    signInEmail: ReturnType<typeof vi.fn>;
}

/** A client built with no optional plugins — every gated card stays hidden. */
const bareClient = (): FakeClient => {
    const signInEmail = vi.fn(() => ok({ user: { email: "a@b.co" } }));
    const client = {
        getSession: vi.fn(() => ok({ user: { email: "a@b.co" } })),
        signIn: { email: signInEmail, social: vi.fn(() => ok({})) },
    } as unknown as AuthClient;

    registerAuthClientPlugins(client, {});

    return { client, signInEmail };
};

/** A client built with the optional plugins — gated cards render. */
const pluginClient = (): FakeClient => {
    const bare = bareClient();
    const client = {
        ...bare.client,
        emailOtp: { sendVerificationOtp: vi.fn(() => ok({ success: true })) },
        organization: { list: vi.fn(() => ok([])) },
        passkey: { addPasskey: vi.fn(() => ok({})), listUserPasskeys: vi.fn(() => ok([])) },
        signIn: { ...bare.client.signIn, magicLink: vi.fn(() => ok({ status: true })) },
        twoFactor: { enable: vi.fn(() => ok({ backupCodes: [], totpURI: "otpauth://x" })) },
    } as unknown as AuthClient;

    registerAuthClientPlugins(client, { emailOtp: true, magicLink: true, organization: true, passkey: true, twoFactor: true });

    return { client, signInEmail: bare.signInEmail };
};

/** The router bridge every provider requires. */
const fakeNav = (): { navigate: (to: string) => void; replace: (to: string) => void } => {
    return {
        navigate: vi.fn<(to: string) => void>(),
        replace: vi.fn<(to: string) => void>(),
    };
};

export type { FakeClient };
export { bareClient, fakeNav, ok, pluginClient };
