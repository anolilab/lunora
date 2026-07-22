/**
 * Wire the email-domain gate into better-auth's native signup path.
 *
 * better-auth mints users through its own `/sign-up/email` endpoint (and OAuth
 * linking), which never passes through a Lunora procedure middleware. To gate
 * those, we hook better-auth's `databaseHooks.user.create.before`: it classifies
 * the incoming address with {@link assertEmailAllowed} and, on a policy failure,
 * throws a better-auth `APIError` carrying the Lunora `code` — so the client sees
 * a clean `400 { code: "EMAIL_DOMAIN_BLOCKED", … }` instead of a generic 500.
 *
 * The classification is pure-data/edge-safe on the default path; the opt-in MX
 * step (`mx: true`) is the only branch that touches DNS.
 */

import { LunoraError } from "@lunora/errors";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";

import type { EmailClassification, EmailGateConfig } from "./email-guard";
import { assertEmailAllowed } from "./email-guard";

/** better-auth's `databaseHooks` shape, derived so a rename upstream fails to compile rather than silently mis-hooking. */
type DatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;

/** The `user.create.before` hook signature better-auth calls before persisting a new user. */
type UserCreateBefore = NonNullable<NonNullable<NonNullable<DatabaseHooks["user"]>["create"]>["before"]>;

/** Config for the signup gate hooks: the base {@link EmailGateConfig} plus an optional classification tap. */
interface EmailGateHookConfig extends EmailGateConfig {
    /**
     * Called with the resolved classification once the gate passes, so app policy
     * can react to `free` vs `business` at signup (e.g. tag the account). Never
     * fires when the gate rejects. `context` is better-auth's endpoint context
     * (`null` outside a request, e.g. an internal create).
     */
    onClassify?: (classification: EmailClassification, user: Record<string, unknown>, context: unknown) => void;
}

/** Map a Lunora transport status to the better-call status string `APIError` accepts. */
const statusString = (status: number): "BAD_REQUEST" | "INTERNAL_SERVER_ERROR" | "TOO_MANY_REQUESTS" | "UNPROCESSABLE_ENTITY" => {
    switch (status) {
        case 400: {
            return "BAD_REQUEST";
        }
        case 422: {
            return "UNPROCESSABLE_ENTITY";
        }
        case 429: {
            return "TOO_MANY_REQUESTS";
        }
        default: {
            return "INTERNAL_SERVER_ERROR";
        }
    }
};

/**
 * Build a better-auth `user.create.before` hook that enforces the email gate.
 * On a policy failure it rethrows the coded {@link LunoraError} as a better-auth
 * `APIError` so the transport carries the right status + `code`. A record with
 * no string `email` (some plugin flows) passes through ungated.
 */
const buildBeforeHook =
    (config: EmailGateHookConfig): UserCreateBefore =>
    async (user, context) => {
        const email = typeof user.email === "string" ? user.email : undefined;

        if (email === undefined || email === "") {
            return;
        }

        let classification: EmailClassification;

        try {
            classification = await assertEmailAllowed(email, config);
        } catch (error) {
            if (error instanceof LunoraError) {
                throw new APIError(statusString(error.status), { code: error.code, message: error.message });
            }

            throw error;
        }

        config.onClassify?.(classification, user, context);
    };

/**
 * Produce a `databaseHooks` fragment that gates better-auth's native signup on
 * the email-domain policy. Spread it into `createAuth({ databaseHooks: … })`, or
 * use {@link withEmailGate} to merge it (composing with any existing
 * `user.create.before`).
 *
 * ```ts
 * const auth = createAuth({
 *     secret: env.AUTH_SECRET,
 *     database: lunoraD1Adapter(env.DB),
 *     databaseHooks: emailGateDatabaseHooks({ blockDisposable: true }),
 * });
 * ```
 */
const emailGateDatabaseHooks = (config: EmailGateHookConfig = {}): DatabaseHooks => {
    return {
        user: { create: { before: buildBeforeHook(config) } },
    };
};

/**
 * Merge the email-domain signup gate into an existing better-auth options object,
 * preserving any `databaseHooks` the caller already set. If they already declared
 * a `user.create.before`, the gate runs first (rejecting disposable signups
 * before their hook sees them), then theirs runs on the (possibly rewritten) user.
 *
 * ```ts
 * const auth = createAuth(withEmailGate({ secret, database }, { blockDisposable: true }));
 * ```
 */
const withEmailGate = (options: BetterAuthOptions, config: EmailGateHookConfig = {}): BetterAuthOptions => {
    const gate = buildBeforeHook(config);
    const existing = options.databaseHooks?.user?.create?.before;

    const before: UserCreateBefore = existing
        ? async (user, context) => {
              await gate(user, context);

              return existing(user, context);
          }
        : gate;

    return {
        ...options,
        databaseHooks: {
            ...options.databaseHooks,
            user: {
                ...options.databaseHooks?.user,
                create: {
                    ...options.databaseHooks?.user?.create,
                    before,
                },
            },
        },
    };
};

export { emailGateDatabaseHooks, withEmailGate };
export type { EmailGateHookConfig };
