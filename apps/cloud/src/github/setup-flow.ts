/**
 * The two decisions of the GitHub App install flow, without the HTTP or the
 * Lunora context: {@link startInstall} signs the state and names the App URL it
 * travels in, and {@link completeInstall} is the only path that binds a staged
 * installation to an organization. The routes in `deploy/routes/github-setup.ts`
 * supply the session, the role lookup and the bind.
 */
import { isLunoraError } from "@lunora/errors";

import { SETUP_STATE_TTL_MS, signSetupState, verifySetupState } from "./setup-state";

/** The outcome of a step: a value, or the HTTP status and message to refuse with. */
export type SetupOutcome<T> = { ok: true; value: T } | { error: string; ok: false; status: number };

const WHOLE_NUMBER = /^\d+$/u;

export interface StartInstallInput {
    /** Whether the signed-in user is an owner or admin of `organizationId`. */
    allowed: boolean;
    appSlug: string | undefined;
    nonce: string;
    now: number;
    organizationId: string;
    secret: string | undefined;
    userId: string;
}

/** Sign the install state and return the GitHub URL that carries it. */
export const startInstall = async (input: StartInstallInput): Promise<SetupOutcome<string>> => {
    if (!input.secret) {
        return { error: "GITHUB_SETUP_STATE_SECRET is not configured; the install cannot be verified", ok: false, status: 500 };
    }

    if (!input.appSlug) {
        return { error: "GITHUB_APP_SLUG is not configured", ok: false, status: 500 };
    }

    if (!input.allowed) {
        return { error: "only owners and admins can install the GitHub App", ok: false, status: 403 };
    }

    const state = await signSetupState(
        { expiresAt: input.now + SETUP_STATE_TTL_MS, nonce: input.nonce, organizationId: input.organizationId, userId: input.userId },
        input.secret,
    );

    return { ok: true, value: `https://github.com/apps/${input.appSlug}/installations/new?state=${state}` };
};

export interface CompleteInstallInput {
    /** Binds the installation to the organization. Throws the Lunora error the store raises. */
    bind: (installationId: number, organizationId: string, userId: string) => Promise<void>;
    installationId: null | string;
    /** Whether `userId` is an owner or admin of `organizationId` right now. */
    isOwnerOrAdmin: (organizationId: string, userId: string) => Promise<boolean>;
    now: number;
    secret: string | undefined;
    sessionUserId: string | undefined;
    setupAction: null | string;
    state: null | string;
}

/** The installation id GitHub sends, or `null` when it is not a whole number. */
const parseInstallationId = (raw: null | string): null | number => {
    if (raw === null || !WHOLE_NUMBER.test(raw)) {
        return null;
    }

    const id = Number(raw);

    return Number.isSafeInteger(id) ? id : null;
};

/** The refusal for a bind the store rejected, or `undefined` for a failure that is not the caller's to see. */
const refuseBind = (error: unknown): SetupOutcome<never> | undefined => {
    if (isLunoraError(error) && error.code === "NOT_FOUND") {
        return { error: "GitHub has not reported this installation yet; try again in a moment", ok: false, status: 404 };
    }

    if (isLunoraError(error) && error.code === "CONFLICT") {
        return { error: "this installation is already claimed by another organization", ok: false, status: 409 };
    }

    return undefined;
};

/**
 * Verify the callback and bind the installation. Refuses unless the state
 * verifies and is unexpired, the session is the user the state names, and that
 * user still owns or administers the organization the state names. A replayed
 * state within its lifetime binds the same installation again, which is harmless.
 */
export const completeInstall = async (input: CompleteInstallInput): Promise<SetupOutcome<{ installationId: number; organizationId: string }>> => {
    if (!input.secret) {
        return { error: "GITHUB_SETUP_STATE_SECRET is not configured; the install cannot be verified", ok: false, status: 500 };
    }

    if (input.setupAction !== "install") {
        return { error: "unsupported setup action; start the install from Lunora", ok: false, status: 400 };
    }

    if (input.state === null) {
        return { error: "missing setup state; start the install from Lunora", ok: false, status: 403 };
    }

    const state = await verifySetupState(input.state, input.secret, input.now);

    if (state === null) {
        return { error: "the install link is invalid or has expired; start the install again", ok: false, status: 403 };
    }

    if (input.sessionUserId === undefined) {
        return { error: "sign in to finish the GitHub install", ok: false, status: 401 };
    }

    if (input.sessionUserId !== state.userId) {
        return { error: "this install was started by another account", ok: false, status: 403 };
    }

    const installationId = parseInstallationId(input.installationId);

    if (installationId === null) {
        return { error: "installation_id must be a whole number", ok: false, status: 400 };
    }

    if (!(await input.isOwnerOrAdmin(state.organizationId, state.userId))) {
        return { error: "only owners and admins can install the GitHub App", ok: false, status: 403 };
    }

    try {
        await input.bind(installationId, state.organizationId, state.userId);
    } catch (error) {
        const refusal = refuseBind(error);

        if (refusal === undefined) {
            throw error;
        }

        return refusal;
    }

    return { ok: true, value: { installationId, organizationId: state.organizationId } };
};
