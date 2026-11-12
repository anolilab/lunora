/**
 * Wire the email-domain gate into better-auth's native user lifecycle.
 *
 * better-auth mints users and changes addresses through its own endpoints and
 * `internalAdapter` (OAuth linking, `/change-email`, the email-OTP and admin
 * updates), none of which pass through a Lunora procedure middleware. So the gate
 * hooks two seams: `databaseHooks.user.create.before` for sign-up, and
 * `databaseHooks.user.update.before` for address changes. Both classify the
 * incoming address with {@link assertEmailAllowed} and, on a policy failure, throw
 * a better-auth `APIError` carrying the Lunora `code`, so the client sees a clean
 * `400 { code: "EMAIL_DOMAIN_BLOCKED", … }` instead of a generic 500.
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

/** The `user.update.before` hook signature better-auth calls with the patch of a user update. */
type UserUpdateBefore = NonNullable<NonNullable<NonNullable<DatabaseHooks["user"]>["update"]>["before"]>;

/** Config for the signup gate hooks: the base {@link EmailGateConfig} plus an optional classification tap. */
interface EmailGateHookConfig extends EmailGateConfig {
    /**
     * Called with the resolved classification once the gate passes, so app policy
     * can react to `free` vs `business` at signup (e.g. tag the account). Never
     * fires when the gate rejects. Fires only at creation: an address change never
     * calls it, because its hook receives the patch rather than the new user record.
     * `context` is better-auth's endpoint context (`null` outside a request, e.g. an
     * internal create).
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
 * Classify an address under the given list loads and rethrow a policy failure as
 * a better-auth `APIError`, so the transport carries the right status and `code`.
 * Shared by the create and update hooks so both reject with the same shape.
 */
const gateAddress = async (email: string, config: EmailGateHookConfig, lists: { disposable: boolean; free: boolean }): Promise<EmailClassification> => {
    try {
        return await assertEmailAllowed(email, { ...config, lists });
    } catch (error) {
        if (error instanceof LunoraError) {
            throw new APIError(statusString(error.status), { code: error.code, message: error.message });
        }

        throw error;
    }
};

/**
 * Build a better-auth `user.create.before` hook that enforces the email gate.
 * A record with no string `email` (some plugin flows) passes through ungated.
 */
const buildBeforeHook =
    (config: EmailGateHookConfig): UserCreateBefore =>
    async (user, context) => {
        const email = typeof user.email === "string" ? user.email : undefined;

        if (email === undefined || email === "") {
            return;
        }

        const observed = config.onClassify !== undefined;
        const classification = await gateAddress(email, config, { disposable: config.blockDisposable !== false || observed, free: observed });

        config.onClassify?.(classification, user, context);
    };

/**
 * Build a better-auth `user.update.before` hook that gates address changes. Every
 * address-change path (`/change-email`, the email-OTP change, the admin update and
 * `AuthAdmin.updateUser`) writes through `internalAdapter.updateUser`, and that
 * hook receives only the patch, so the gate reads `patch.email` and skips patches
 * that do not carry an address. `onClassify` stays creation-only, so the lists
 * loaded here are the ones the policy needs, not the ones a tap would need.
 */
const buildUpdateBeforeHook =
    (config: EmailGateHookConfig): UserUpdateBefore =>
    async (patch) => {
        if (patch.email === undefined) {
            return;
        }

        // A supplied blank or non-string address is not "no address change": the admin
        // update route passes such values straight to the adapter, so it must not slip through.
        if (typeof patch.email !== "string" || patch.email === "") {
            throw new APIError("BAD_REQUEST", { code: "VALIDATION_ERROR", message: "email must be a non-empty string" });
        }

        await gateAddress(patch.email, config, { disposable: config.blockDisposable !== false, free: false });
    };

/** The patch better-auth will persist: a hook's `{ data }` replacement, or the (possibly mutated) patch itself. */
type UserUpdatePatch = Parameters<UserUpdateBefore>[0];

const effectiveUpdatePatch = (result: Awaited<ReturnType<UserUpdateBefore>>, patch: UserUpdatePatch): UserUpdatePatch =>
    typeof result === "object" && "data" in result ? result.data : patch;

/**
 * Produce a `databaseHooks` fragment that gates better-auth's user lifecycle on the
 * email-domain policy: sign-up (`user.create.before`) and address changes
 * (`user.update.before`). Spread it into `createAuth({ databaseHooks: … })`, or
 * use {@link withEmailGate} to merge it (composing with any existing hooks).
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
        user: {
            create: { before: buildBeforeHook(config) },
            update: { before: buildUpdateBeforeHook(config) },
        },
    };
};

/**
 * Merge the email-domain gate into an existing better-auth options object,
 * preserving any `databaseHooks` the caller already set. For each hook the caller
 * already declared (`user.create.before`, `user.update.before`), the gate runs
 * first, rejecting a disallowed address before their hook sees it, then theirs
 * runs on the (possibly rewritten) input. Other existing hooks, such as
 * `user.update.after`, are kept as they were.
 *
 * ```ts
 * const auth = createAuth(withEmailGate({ secret, database }, { blockDisposable: true }));
 * ```
 */
const withEmailGate = (options: BetterAuthOptions, config: EmailGateHookConfig = {}): BetterAuthOptions => {
    const gateCreate = buildBeforeHook(config);
    const gateUpdate = buildUpdateBeforeHook(config);
    const existingCreate = options.databaseHooks?.user?.create?.before;
    const existingUpdate = options.databaseHooks?.user?.update?.before;

    const createBefore: UserCreateBefore = existingCreate
        ? async (user, context) => {
              await gateCreate(user, context);

              return existingCreate(user, context);
          }
        : gateCreate;

    // The caller's hook runs after the gate and may rewrite the address (mutating the patch, or
    // returning replacement data that better-auth persists), so the gate checks the result too.
    const updateBefore: UserUpdateBefore = existingUpdate
        ? async (patch, context) => {
              await gateUpdate(patch, context);

              const checkedEmail = patch.email;
              const result = await existingUpdate(patch, context);
              const effective = effectiveUpdatePatch(result, patch);

              // An unchanged address was already classified; re-checking it would repeat the MX lookup.
              if (effective.email !== checkedEmail) {
                  await gateUpdate(effective, context);
              }

              return result;
          }
        : gateUpdate;

    return {
        ...options,
        databaseHooks: {
            ...options.databaseHooks,
            user: {
                ...options.databaseHooks?.user,
                create: {
                    ...options.databaseHooks?.user?.create,
                    before: createBefore,
                },
                update: {
                    ...options.databaseHooks?.user?.update,
                    before: updateBefore,
                },
            },
        },
    };
};

export { emailGateDatabaseHooks, withEmailGate };
export type { EmailGateHookConfig };
