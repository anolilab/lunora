/**
 * Invite-only sign-up — an account may only be created for an address an
 * administrator has invited.
 *
 * # Why a plugin and not a hook
 *
 * The enforcement itself is one `databaseHooks.user.create.before` (the same
 * seam `./email-gate.ts` uses, and the only one every account-minting path goes
 * through — `/sign-up/email`, an OAuth callback creating a new user, magic-link,
 * `admin.createUser`). What a hook cannot do is declare the table the invitations
 * live in. A better-auth plugin's `schema` flows into `getAuthTables`, so
 * `authTables()`, `compileMigrationsSql`, and the Durable-Object DDL in
 * `./do-schema.ts` all pick `signUpInvitation` up with nothing further to write.
 *
 * # Wiring
 *
 * ```ts
 * import { createAuth, createSignUpInvitation } from "@lunora/auth";
 * import { inviteOnly } from "@lunora/auth/plugins";
 *
 * export const auth = createAuth({
 *     database: env.DB,
 *     emailAndPassword: { enabled: true, requireEmailVerification: true },
 *     plugins: [inviteOnly()],
 *     secret: env.AUTH_SECRET,
 * });
 *
 * // …then, from your own admin-authorized code:
 * const invite = await createSignUpInvitation(auth, { email: "ada@example.com" });
 * await sendMail(invite.email, `You can now sign up: https://app.example/sign-up?email=${encodeURIComponent(invite.email)}`);
 * ```
 *
 * Nothing signs up before that first invitation exists, including you — see
 * {@link InviteOnlyOptions.allowFirstUser}. Leave `emailAndPassword.disableSignUp`
 * **off**: the invitee still uses the ordinary sign-up form, and closing it would
 * leave them nothing to submit. The `?email=` parameter is read by
 * `lunora/auth-ui`'s sign-up prefill.
 *
 * # Security — what an invitation is, and what it is not
 *
 * An invitation is keyed by email address and nothing else. There is no secret
 * token, because this gate runs inside `user.create.before`, which is handed the
 * row about to be written and never the request that asked for it.
 *
 * So anyone who learns an invited address can spend that seat.
 * `requireEmailVerification` does **not** close this, and it is worth being exact
 * about what it does: better-auth's `/sign-up/email` writes the user row first and
 * mails the verification token afterwards, so an attacker who signs up as the
 * invited address still creates a real account with their own password, still
 * burns the invitation, and still leaves the invitee locked out of an address that
 * is now taken. What verification buys is that the attacker holds no session until
 * someone clicks the link — and the link lands in the invitee's inbox, where she is
 * expecting it. Recovery is `AuthAdmin.removeUser` plus a fresh invitation.
 *
 * Treat an invited address as semi-secret, prefer providers that verify ownership
 * before the account is usable, and do not use this where the seat itself is
 * valuable enough to guess for.
 *
 * # What it refuses that you may not expect
 *
 * Plugins that mint an account from something other than a real mailbox still
 * synthesize an address — `anonymous` writes `temp-<id>@<domain>`, `siwe` writes
 * `<wallet>@<domain>`, `phoneNumber`'s sign-up-on-verification writes a temp
 * address of its own. None of them can match an invitation, so the gate **rejects**
 * them once the first account exists. Do not combine those plugins with this one.
 *
 * `AuthAdmin.createUser` (`./admin.ts`) mints through the same internal adapter, so
 * the studio's create-user action is gated too. Issue an invitation first, or call
 * {@link createSignUpInvitation} from the same operator flow.
 */

import { defineErrorCodes } from "@better-auth/core/utils/error-codes";
import { LunoraError } from "@lunora/errors";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";

import type { LunoraAuth } from "./create-auth";

/** The model name the invitations table is registered (and migrated) under. */
const INVITATION_MODEL = "signUpInvitation";

/** How long an invitation stays usable when the caller doesn't say (7 days). */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Longest invitation TTL accepted (1 year) — past this a huge value overflows to an Invalid Date. */
const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;

/** Ceiling on {@link listSignUpInvitations}, so the default call cannot read an unbounded table into the isolate. */
const MAX_LISTED = 500;

/**
 * Rejection is a **400, not a 403**. better-auth's `/sign-up/email` catches a 403
 * from `user.create.before` and answers with a fabricated success — a synthetic
 * user object it never persisted — whenever `requireEmailVerification` or
 * `autoSignIn: false` is set (`api/routes/sign-up.mjs`, `shouldReturnGenericDuplicateResponse`).
 * That is deliberate anti-enumeration on their side, and it would silently swallow
 * this gate in the very configuration the docblock above recommends: the uninvited
 * caller would be told the account exists. `./email-gate.ts` maps to 400/422/429
 * for the same reason.
 */
const ERROR_CODES = defineErrorCodes({
    SIGN_UP_INVITE_REQUIRED: "sign-up is invite-only — ask an administrator for an invitation",
});

/** One pending or spent sign-up invitation. */
interface SignUpInvitation {
    /** When an account was created for this address; `null` while the invitation is unspent. */
    acceptedAt: Date | null;
    createdAt: Date;
    /** The invited address, lowercased — the only thing an invitation is matched on. */
    email: string;
    expiresAt: Date;
    id: string;
    /** Free-form attribution (a user id, an operator name); never read by the gate. */
    invitedBy: null | string;
}

/** Options for {@link inviteOnly}. */
interface InviteOnlyOptions {
    /**
     * Let the very first account through uninvited, so a fresh deployment can be
     * bootstrapped without seeding a row.
     *
     * **Off by default.** The check is "the `user` table is empty", which two
     * concurrent sign-ups can both observe, and the window it opens is the gap
     * between deploying and the owner signing up — whoever finds the URL first
     * gets an account on a deployment whose whole point is that nobody does. Seed
     * the first invitation with {@link createSignUpInvitation} instead (a one-off
     * call at worker init, or an internal mutation you run once).
     * @default false
     */
    allowFirstUser?: boolean;
}

/** better-auth's resolved adapter, named the way `./admin.ts` names it rather than re-declared structurally. */
type AuthAdapter = Awaited<LunoraAuth["$context"]>["adapter"];

/** better-auth's `user.create.before` / `.after` hook signatures, derived so an upstream rename fails to compile. */
type DatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;
type UserCreateAfter = NonNullable<NonNullable<NonNullable<DatabaseHooks["user"]>["create"]>["after"]>;
type UserCreateBefore = NonNullable<NonNullable<NonNullable<DatabaseHooks["user"]>["create"]>["before"]>;

/** A local part, exactly one `@`, and a domain. Kept free of adjacent quantifiers so it cannot backtrack. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

/**
 * Enough of an address to be worth storing: {@link EMAIL_SHAPE} plus a dotted
 * domain. Not RFC 5322 — better-auth validates the address the invitee actually
 * submits, and this only has to refuse the typos and the empty strings that would
 * otherwise sit in the table matching nothing.
 */
const looksLikeEmail = (email: string): boolean => {
    if (!EMAIL_SHAPE.test(email)) {
        return false;
    }

    const domain = email.slice(email.indexOf("@") + 1);

    return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
};

/** Shape a raw adapter row as a {@link SignUpInvitation}. Every adapter this package ships parses `date` columns back to `Date` (`./adapter.ts`, `supportsDates: false`). */
const toInvitation = (row: Record<string, unknown>): SignUpInvitation => {
    return {
        // eslint-disable-next-line unicorn/no-null -- `null` is the stored "unspent" value, not an absent key.
        acceptedAt: row["acceptedAt"] instanceof Date ? row["acceptedAt"] : null,
        createdAt: row["createdAt"] as Date,
        email: String(row["email"]),
        expiresAt: row["expiresAt"] as Date,
        id: String(row["id"]),
        // eslint-disable-next-line unicorn/no-null -- ditto: the column is nullable.
        invitedBy: typeof row["invitedBy"] === "string" ? row["invitedBy"] : null,
    };
};

/** The address an invitation is matched on: trimmed and lowercased, as better-auth stores `user.email`. */
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Read `user.email` off a hook payload, normalized. The parameter is structural so both hook signatures pass without a cast. */
const emailOf = (user: { email?: unknown }): string | undefined => {
    if (typeof user.email !== "string") {
        return undefined;
    }

    const normalized = normalizeEmail(user.email);

    return normalized === "" ? undefined : normalized;
};

/** Whether `email` has an invitation that is present, unspent, and unexpired. */
const hasUsableInvitation = async (adapter: AuthAdapter, email: string): Promise<boolean> => {
    const row = await adapter.findOne<Record<string, unknown>>({ model: INVITATION_MODEL, where: [{ field: "email", value: email }] });

    if (row === null || row["acceptedAt"] instanceof Date) {
        return false;
    }

    return row["expiresAt"] instanceof Date && row["expiresAt"].getTime() > Date.now();
};

/**
 * Warn once per auth context when the password provider is on without
 * `requireEmailVerification`. It does not make an invited address secret (see the
 * security section above) — it is the difference between an attacker who guesses
 * one holding a session immediately and holding none until the invitee clicks a
 * link she was expecting. Mirrors `./plugins-enterprise.ts`'s `sso()` warning: it
 * does not change the default, it just refuses to let the gap be silent.
 */
const warnIfVerificationOff = (options: BetterAuthOptions): void => {
    if (options.emailAndPassword?.enabled !== true || options.emailAndPassword.requireEmailVerification === true) {
        return;
    }

    // eslint-disable-next-line no-console
    console.warn(
        "@lunora/auth: inviteOnly() is installed with password sign-up but without " +
            "`emailAndPassword: { requireEmailVerification: true }`. An invitation is keyed by email address " +
            "alone, so anyone who learns an invited address can sign up as it — and without verification they " +
            "hold a session the moment they do.",
    );
};

/**
 * A better-auth server plugin that refuses to create an account for an address
 * with no unspent invitation, and the `signUpInvitation` table those live in.
 *
 * Issue invitations with {@link createSignUpInvitation}; there is no HTTP
 * endpoint for it on purpose. Who counts as an administrator is your
 * application's question — call it from a mutation you already authorize, the
 * same trust model `createAuthAdmin` documents.
 *
 * The return type is better-auth's own `BetterAuthPlugin` rather than the
 * precise shape of the schema map, for the reason `./ui-config.ts` spells out:
 * an anonymous inferred type is the difference between a build that emits
 * declarations and one that fails in the bundler alone.
 */
const inviteOnly = (options: InviteOnlyOptions = {}): BetterAuthPlugin => {
    const allowFirstUser = options.allowFirstUser ?? false;

    return {
        $ERROR_CODES: ERROR_CODES,
        id: "lunora-invite-only",
        init: (context) => {
            warnIfVerificationOff(context.options);

            const { adapter } = context;

            // The bootstrap check is a `COUNT(*)` over `user`, and it runs on every
            // *uninvited* attempt — an attacker's lever. It can only ever go from
            // true to false (a database does not lose its users), so once one exists
            // stop asking.
            let mayBootstrap = allowFirstUser;

            const before: UserCreateBefore = async (user) => {
                const email = emailOf(user);

                if (email !== undefined && (await hasUsableInvitation(adapter, email))) {
                    return;
                }

                if (mayBootstrap) {
                    if ((await adapter.count({ model: "user" })) === 0) {
                        return;
                    }

                    mayBootstrap = false;
                }

                throw new APIError("BAD_REQUEST", ERROR_CODES.SIGN_UP_INVITE_REQUIRED);
            };

            // Spending the invitation in the *after* hook, keyed by email again rather
            // than by carrying state across from `before`, means a failed create
            // doesn't burn it. It cannot let a second account through: `user.email` is
            // unique, so the only sign-up that reaches here for an address is the one
            // that got it.
            const after: UserCreateAfter = async (user) => {
                const email = emailOf(user);

                if (email === undefined) {
                    return;
                }

                await adapter.update({ model: INVITATION_MODEL, update: { acceptedAt: new Date() }, where: [{ field: "email", value: email }] });
            };

            return { options: { databaseHooks: { user: { create: { after, before } } } } };
        },
        schema: {
            [INVITATION_MODEL]: {
                fields: {
                    acceptedAt: { required: false, type: "date" },
                    createdAt: { defaultValue: () => new Date(), required: true, type: "date" },
                    email: { required: true, type: "string", unique: true },
                    expiresAt: { required: true, type: "date" },
                    invitedBy: { required: false, type: "string" },
                },
            },
        },
    };
};

/**
 * Invite `email` to sign up, or refresh an existing invitation for it.
 *
 * Re-inviting an address updates the row in place — a new expiry, and `acceptedAt`
 * cleared — because `email` is unique. That is also how you re-open a seat after
 * deleting the account that took it.
 *
 * This is a trusted server-side call with no authorization of its own; gate it
 * the way you gate any other administrative action. Delivering the invitation is
 * yours too: nothing here sends mail, so the returned row is the whole handoff.
 *
 * Nothing prunes the table — a spent or expired row stays until you delete it with
 * {@link revokeSignUpInvitation}, which is also what keeps it a record of who was
 * let in.
 */
const createSignUpInvitation = async (auth: LunoraAuth, input: { email: string; expiresInSeconds?: number; invitedBy?: string }): Promise<SignUpInvitation> => {
    const email = normalizeEmail(input.email);

    if (!looksLikeEmail(email)) {
        throw new LunoraError("VALIDATION_ERROR", `not an email address to invite: ${JSON.stringify(input.email)}`);
    }

    const { expiresInSeconds = DEFAULT_TTL_SECONDS } = input;

    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > MAX_TTL_SECONDS) {
        throw new LunoraError("VALIDATION_ERROR", `expiresInSeconds must be a positive integer no greater than ${String(MAX_TTL_SECONDS)}`);
    }

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    // eslint-disable-next-line unicorn/no-null -- clearing a prior acceptance needs an explicit null; `undefined` would leave the old value.
    const invitedBy = input.invitedBy ?? null;
    const context = await auth.$context;
    const where = [{ field: "email", value: email }];

    /** Re-open the existing row. Also the recovery path when a concurrent insert won the unique index. */
    const refresh = async (): Promise<null | Record<string, unknown>> =>
        // eslint-disable-next-line unicorn/no-null -- see above.
        context.adapter.update<Record<string, unknown>>({ model: INVITATION_MODEL, update: { acceptedAt: null, expiresAt, invitedBy }, where });

    if (await context.adapter.findOne({ model: INVITATION_MODEL, where })) {
        const updated = await refresh();

        if (updated) {
            return toInvitation(updated);
        }
    }

    try {
        return toInvitation(
            await context.adapter.create<Record<string, unknown>>({ data: { createdAt: new Date(), email, expiresAt, invitedBy }, model: INVITATION_MODEL }),
        );
    } catch (error) {
        // `email` is unique, so a concurrent invite for the same new address loses
        // this insert with a backend-specific constraint error. Re-open the row the
        // winner wrote rather than surfacing that; if there is no such row the
        // insert failed for some other reason and the original error is the honest one.
        const updated = await refresh();

        if (updated === null) {
            throw error;
        }

        return toInvitation(updated);
    }
};

/**
 * The most recent invitations, newest first, up to a fixed ceiling of
 * {@link MAX_LISTED}. `pendingOnly` drops the spent and the expired, which is the
 * list an operator usually wants; the unfiltered form doubles as the record of who
 * was let in.
 *
 * Deliberately not paged. "Pending" is two conditions, one of them a comparison
 * against `now`, and filtering those after a page would let page 1 come back empty
 * while pending invitations sat on page 2. An operator list that outgrows the
 * ceiling wants a query against the `signUpInvitation` table, not an offset.
 */
const listSignUpInvitations = async (auth: LunoraAuth, options: { pendingOnly?: boolean } = {}): Promise<SignUpInvitation[]> => {
    const context = await auth.$context;

    const rows = await context.adapter.findMany<Record<string, unknown>>({
        limit: MAX_LISTED,
        model: INVITATION_MODEL,
        sortBy: { direction: "desc", field: "createdAt" },
    });

    const invitations = rows.map((row) => toInvitation(row));

    return options.pendingOnly === true ? invitations.filter((row) => row.acceptedAt === null && row.expiresAt.getTime() > Date.now()) : invitations;
};

/**
 * Withdraw the invitation for `email`. Deletes the row, so it also forgets a spent
 * one — the account it created is untouched, and removing that is
 * `AuthAdmin.removeUser`'s job.
 */
const revokeSignUpInvitation = async (auth: LunoraAuth, input: { email: string }): Promise<void> => {
    const context = await auth.$context;

    await context.adapter.delete({ model: INVITATION_MODEL, where: [{ field: "email", value: normalizeEmail(input.email) }] });
};

export type { InviteOnlyOptions, SignUpInvitation };
export { createSignUpInvitation, inviteOnly, listSignUpInvitations, revokeSignUpInvitation };
