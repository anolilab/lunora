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
 * const link = `https://app.example/sign-up?email=${encodeURIComponent(invite.email)}&invite=${invite.token}`;
 *
 * await sendMail(invite.email, `You can now sign up: ${link}`);
 * ```
 *
 * `invite.token` is the only time that value exists in the clear — see the
 * security section below. `@lunora/auth-ui` reads both parameters off the URL and
 * submits the token with the form.
 *
 * Nothing signs up before that first invitation exists, including you — see
 * {@link InviteOnlyOptions.allowFirstUser}. Leave `emailAndPassword.disableSignUp`
 * **off**: the invitee still uses the ordinary sign-up form, and closing it would
 * leave them nothing to submit.
 *
 * # Security — two checks, because the paths differ
 *
 * An invitation carries a **secret token**: 256 CSPRNG bits, handed back in the
 * clear exactly once when the invitation is issued, stored only as a SHA-256.
 * The invitee brings it back in the sign-up link (`?invite=…`).
 *
 * The token is checked on `/sign-up/email` and nowhere else, which is the whole
 * design rather than an oversight. Every other path that mints an account has
 * already proved the person controls the address before the row is written: an
 * OAuth callback carries a provider-verified email, and magic-link and email-OTP
 * only fire for whoever is holding the mailbox. Password sign-up is the one place
 * where anyone may claim any address, so it is the one place a shared secret adds
 * anything. So:
 *
 * - `databaseHooks.user.create.before` — the universal backstop. An unspent,
 *   unexpired invitation must exist for the address, whatever created the row.
 * - `hooks.before` on `/sign-up/email` — additionally requires the token.
 *
 * Without the token this would be guessable in bulk, and that is not theoretical:
 * the common case is inviting a team, where addresses are `first.last@company`.
 * The rejection is also deliberately uniform — missing token, wrong token,
 * expired invitation and never-invited address all answer
 * `SIGN_UP_INVITE_INVALID` with one message, so the form cannot be used to sift
 * a directory for which addresses are on the list.
 *
 * What the token does **not** do is make an invitation single-use against a
 * simultaneous request, or survive being forwarded: whoever holds the link can
 * spend the seat, so treat it as a bearer credential and send it to the invitee
 * rather than to a shared inbox. `requireEmailVerification` remains worth setting
 * — better-auth writes the user row before it mails the verification token, so
 * verification is what stops a spent invitation from becoming a usable session.
 *
 * A row with no `tokenHash` — one an OAuth-only deployment never needed, or a
 * leftover from before tokens — cannot satisfy password sign-up at all. There is
 * nothing to present that matches. Re-invite to mint one.
 *
 * # What it refuses that you may not expect
 *
 * Plugins that mint an account from something other than a real mailbox still
 * synthesize an address — `anonymous` writes `temp-<id>@<domain>`, `siwe` writes
 * `<wallet>@<domain>`, `phoneNumber`'s sign-up-on-verification writes a temp
 * address of its own. None of them can match an invitation, so the gate **rejects**
 * them — but only once the first account exists. With
 * {@link InviteOnlyOptions.allowFirstUser} on, the bootstrap runs before the
 * address is ever compared, so the first anonymous session or wallet sign-in is
 * what claims it. Do not combine those plugins with this one.
 *
 * `AuthAdmin.createUser` (`./admin.ts`) mints through the same internal adapter, so
 * the studio's create-user action is gated too. Issue an invitation first, or call
 * {@link createSignUpInvitation} from the same operator flow.
 */

import { defineErrorCodes } from "@better-auth/core/utils/error-codes";
import { LunoraError } from "@lunora/errors";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

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
    // Deliberately one code and one message for every way a token can fail —
    // missing, wrong, expired, or for an address nobody invited. Distinguishing
    // them would turn the sign-up form back into the oracle the token exists to
    // close: "wrong token" tells you the address IS invited.
    SIGN_UP_INVITE_INVALID: "That sign-up invitation is not valid. Ask an administrator for a new invitation link.",
    // Sentence case: `@lunora/auth-ui`'s `mapAuthError` renders a server message
    // verbatim in the sign-up card's banner, beside better-auth's own
    // ("Invalid email or password").
    SIGN_UP_INVITE_REQUIRED: "Sign-up is invite-only — ask an administrator for an invitation.",
});

/**
 * Bytes of entropy per invitation token. 256 bits, from the platform CSPRNG — a
 * token is the only thing standing between a guessable address and its seat, so
 * this is not a place to be clever about length.
 */
const TOKEN_BYTES = 32;

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

/**
 * What {@link createSignUpInvitation} hands back: the stored row plus the one
 * and only sight of the plaintext `token`. Nothing reads it back afterwards —
 * the database holds a SHA-256 of it — so an invitation link that is lost is
 * reissued, not recovered.
 */
interface IssuedSignUpInvitation extends SignUpInvitation {
    /** Put this in the sign-up link as `?invite=…`. Never stored, never logged, never listed. */
    token: string;
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

/**
 * A fresh invitation token, URL-safe so it survives an email client, a query
 * string, and a copy-paste. Base64url of {@link TOKEN_BYTES} CSPRNG bytes; no
 * dependency, and `crypto.getRandomValues` is present on workerd and Node alike.
 */
const mintToken = (): string =>
    btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");

/**
 * SHA-256 of a token, hex. **Only the hash is stored.** A leaked database — a
 * backup, a log of a `SELECT *`, the studio's own table browser — then yields
 * nothing usable, which is why the plaintext is returned exactly once at issue
 * time and never again.
 *
 * No salt and no KDF on purpose: this is a 256-bit random value, not a password,
 * so there is nothing to brute-force and nothing for a rainbow table to hold.
 */
const hashToken = async (token: string): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));

    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Compare two hex digests without leaking where they diverge. Length is checked
 * first and is not secret (every digest is the same length), then every
 * remaining character is examined whatever the earlier ones said.
 */
const digestsMatch = (a: string, b: string): boolean => {
    if (a.length !== b.length) {
        return false;
    }

    let difference = 0;

    for (let index = 0; index < a.length; index += 1) {
        // eslint-disable-next-line no-bitwise -- accumulating differences without branching is the point.
        difference |= (a.codePointAt(index) ?? 0) ^ (b.codePointAt(index) ?? 0);
    }

    return difference === 0;
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
    // The bootstrap check is a `COUNT(*)` over `user`, and it runs on every
    // *uninvited* attempt — an attacker's lever. It can only ever go from true to
    // false (a database does not lose its users), so once one exists stop asking.
    //
    // Shared by both hooks below on purpose: if the route hook demanded a token
    // while the bootstrap window was open, `allowFirstUser` would be silently
    // inert for password sign-up — which is the only way most deployments would
    // ever use it.
    let mayBootstrap = options.allowFirstUser ?? false;

    /** Whether this request falls inside the one-account bootstrap window. Closes it for good on the first miss. */
    const inBootstrapWindow = async (adapter: AuthAdapter): Promise<boolean> => {
        if (!mayBootstrap) {
            return false;
        }

        if ((await adapter.count({ model: "user" })) === 0) {
            return true;
        }

        mayBootstrap = false;

        return false;
    };

    return {
        $ERROR_CODES: ERROR_CODES,

        /**
         * The token check, on `/sign-up/email` and nowhere else.
         *
         * That is not an arbitrary scope. Every other path that mints an account
         * has already proved the person controls the address before the row is
         * written — an OAuth callback carries a provider-verified email, magic
         * link and email-OTP only fire for someone holding the mailbox. Password
         * sign-up is the one place where anyone may claim any address, so it is
         * the one place a shared secret adds something.
         *
         * This runs before the route, so a bad token means no user row at all,
         * and it runs *in addition to* the `user.create.before` gate below —
         * which stays the universal backstop for the paths that never present a
         * token.
         */
        hooks: {
            before: [
                {
                    handler: createAuthMiddleware(async (context) => {
                        const body = (context.body ?? {}) as { email?: unknown; inviteToken?: unknown };
                        const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
                        const presented = typeof body.inviteToken === "string" ? body.inviteToken : "";

                        // One rejection for every failure below, so the response
                        // cannot be read as "this address is on the list".
                        const refuse = (): never => {
                            throw new APIError("BAD_REQUEST", ERROR_CODES.SIGN_UP_INVITE_INVALID);
                        };

                        if (email === "") {
                            refuse();
                        }

                        if (await inBootstrapWindow(context.context.adapter)) {
                            return;
                        }

                        if (presented === "") {
                            refuse();
                        }

                        const row = await context.context.adapter.findOne<Record<string, unknown>>({
                            model: INVITATION_MODEL,
                            where: [{ field: "email", value: email }],
                        });

                        const stored = row === null ? undefined : row["tokenHash"];

                        // Hash the presented token even when there is nothing to
                        // compare it against, so a missing invitation and a wrong
                        // token cost the same.
                        const presentedHash = await hashToken(presented);

                        if (typeof stored !== "string" || !digestsMatch(stored, presentedHash)) {
                            refuse();
                        }
                    }),
                    matcher: (context) => context.path === "/sign-up/email",
                },
            ],
        },
        id: "lunora-invite-only",
        init: (context) => {
            warnIfVerificationOff(context.options);

            const { adapter } = context;

            const before: UserCreateBefore = async (user) => {
                const email = emailOf(user);

                if (email !== undefined && (await hasUsableInvitation(adapter, email))) {
                    return;
                }

                if (await inBootstrapWindow(adapter)) {
                    return;
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
                    // Nullable because a row can outlive the token that made it —
                    // and because a deployment that only signs up through OAuth
                    // never needs one. The password path treats "no hash" exactly
                    // like a wrong hash: there is nothing to present, so nothing
                    // matches.
                    tokenHash: { required: false, type: "string" },
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
 *
 * Each call mints a **new token** and returns it in the clear, once. Only its
 * SHA-256 is stored, so re-inviting an address invalidates the previous link, and
 * a link that was never delivered is reissued rather than looked up.
 */
const createSignUpInvitation = async (
    auth: LunoraAuth,
    input: { email: string; expiresInSeconds?: number; invitedBy?: string },
): Promise<IssuedSignUpInvitation> => {
    const email = normalizeEmail(input.email);

    if (!looksLikeEmail(email)) {
        throw new LunoraError("VALIDATION_ERROR", `not an email address to invite: ${JSON.stringify(input.email)}`);
    }

    const { expiresInSeconds = DEFAULT_TTL_SECONDS } = input;

    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > MAX_TTL_SECONDS) {
        throw new LunoraError("VALIDATION_ERROR", `expiresInSeconds must be a positive integer no greater than ${String(MAX_TTL_SECONDS)}`);
    }

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const token = mintToken();
    const tokenHash = await hashToken(token);
    // eslint-disable-next-line unicorn/no-null -- clearing a prior acceptance needs an explicit null; `undefined` would leave the old value.
    const invitedBy = input.invitedBy ?? null;
    const context = await auth.$context;
    const where = [{ field: "email", value: email }];

    /** Re-open the existing row. Also the recovery path when a concurrent insert won the unique index. */
    const refresh = async (): Promise<null | Record<string, unknown>> =>
        // eslint-disable-next-line unicorn/no-null -- see above.
        context.adapter.update<Record<string, unknown>>({ model: INVITATION_MODEL, update: { acceptedAt: null, expiresAt, invitedBy, tokenHash }, where });

    if (await context.adapter.findOne({ model: INVITATION_MODEL, where })) {
        const updated = await refresh();

        if (updated) {
            return { ...toInvitation(updated), token };
        }
    }

    try {
        const created = await context.adapter.create<Record<string, unknown>>({
            data: { createdAt: new Date(), email, expiresAt, invitedBy, tokenHash },
            model: INVITATION_MODEL,
        });

        return { ...toInvitation(created), token };
    } catch (error) {
        // `email` is unique, so a concurrent invite for the same new address loses
        // this insert with a backend-specific constraint error. Re-open the row the
        // winner wrote rather than surfacing that; if there is no such row the
        // insert failed for some other reason and the original error is the honest one.
        const updated = await refresh();

        if (updated === null) {
            throw error;
        }

        return { ...toInvitation(updated), token };
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
 *
 * Not retroactive, and not atomic against a sign-up already in flight: better-auth
 * creates the user without wrapping the `before` hook and the insert in one
 * transaction, so a revoke landing between the two lets that one account through.
 * There is no conditional consume in the adapter contract to close it with. Treat
 * revocation as "no further sign-ups", and `AuthAdmin.removeUser` as the way to
 * undo one that already happened.
 */
const revokeSignUpInvitation = async (auth: LunoraAuth, input: { email: string }): Promise<void> => {
    const context = await auth.$context;

    await context.adapter.delete({ model: INVITATION_MODEL, where: [{ field: "email", value: normalizeEmail(input.email) }] });
};

/**
 * Delete invitations that expired without being used, and report how many went.
 *
 * Only the dead ones: a spent invitation is the record of who was let in, and an
 * unexpired one is still live, so both stay. Nothing calls this for you — an app
 * that invites at any volume should put it on a cron; one that doesn't can leave
 * the rows.
 *
 * Bounded by `limit` and therefore incremental: a backlog larger than one pass
 * takes several. It reads a page and deletes row by row rather than issuing one
 * ranged `deleteMany`, because a `lt` comparison against a `date` column is the
 * kind of thing that behaves differently on each of the three adapters this
 * package ships, and a prune job is not where that should be discovered.
 */
const pruneSignUpInvitations = async (auth: LunoraAuth, options: { limit?: number } = {}): Promise<number> => {
    const context = await auth.$context;

    const rows = await context.adapter.findMany<Record<string, unknown>>({
        limit: Math.min(options.limit ?? MAX_LISTED, MAX_LISTED),
        model: INVITATION_MODEL,
        sortBy: { direction: "asc", field: "createdAt" },
    });

    const dead = rows.map((row) => toInvitation(row)).filter((row) => row.acceptedAt === null && row.expiresAt.getTime() <= Date.now());

    for (const invitation of dead) {
        // Sequential rather than `Promise.all`: this runs on a scheduled worker
        // against the same store as live sign-ups, and a burst of concurrent
        // deletes is the wrong thing to spend that budget on.
        // eslint-disable-next-line no-await-in-loop -- see above.
        await context.adapter.delete({ model: INVITATION_MODEL, where: [{ field: "email", value: invitation.email }] });
    }

    return dead.length;
};

export type { InviteOnlyOptions, IssuedSignUpInvitation, SignUpInvitation };
export { createSignUpInvitation, inviteOnly, listSignUpInvitations, pruneSignUpInvitations, revokeSignUpInvitation };
