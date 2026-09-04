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
 * Leave `emailAndPassword.disableSignUp` **off**: the invitee still uses the
 * ordinary sign-up form, and closing it would leave them nothing to submit. The
 * `?email=` parameter is read by `lunora/auth-ui`'s sign-up prefill.
 *
 * # Security — an invitation is keyed by email, and nothing else
 *
 * There is no secret token. Whoever signs up first with an invited address gets
 * the seat, so an attacker who *knows* an invited address can take it before its
 * owner does. `requireEmailVerification` is what closes that, which is why
 * {@link inviteOnly} warns when the password provider is on without it. OAuth
 * sign-ups carry a provider-verified address and are safe either way.
 *
 * Accounts created with no email at all (the `anonymous` and `siwe` plugins) are
 * not gated — there is no address to match an invitation against. Installing
 * either alongside this plugin re-opens self-serve sign-up.
 */

import { LunoraError } from "@lunora/errors";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";

import type { LunoraAuth } from "./create-auth";

/** The model name the invitations table is registered (and migrated) under. */
const MODEL = "signUpInvitation";

/** How long an invitation stays usable when the caller doesn't say (7 days). */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Hard ceiling on an invitation TTL (1 year), so a huge value can't overflow to an Invalid Date. */
const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;

/** One pending or accepted sign-up invitation. */
interface SignUpInvitation {
    /** When the invited address was used to create an account; `null` while pending. */
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
     * bootstrapped without seeding a row by hand.
     *
     * The check is "the `user` table is empty", which is racy under concurrent
     * sign-ups — two requests can both observe zero and both get in. It is a
     * one-shot bootstrap on an empty database, so the window is the gap between
     * deploying and the owner signing up; set `false` and seed the first
     * invitation with `createSignUpInvitation` if that window matters.
     * @default true
     */
    allowFirstUser?: boolean;
}

/** A `where` clause as better-auth's adapter takes it. */
interface AdapterWhere {
    field: string;
    value: unknown;
}

/**
 * The slice of better-auth's `DBAdapter` this module uses. Written by hand for
 * the same reason `./ui-config.ts` hand-writes its options shape: the real type
 * is generic over the whole resolved config and is not nameable here, while
 * every member below is stable public API.
 */
interface InvitationAdapter {
    count: (input: { model: string }) => Promise<number>;
    create: <T>(input: { data: Record<string, unknown>; model: string }) => Promise<T>;
    delete: (input: { model: string; where: AdapterWhere[] }) => Promise<void>;
    findMany: <T>(input: {
        limit?: number;
        model: string;
        offset?: number;
        sortBy?: { direction: "asc" | "desc"; field: string };
        where?: AdapterWhere[];
    }) => Promise<T[]>;
    findOne: <T>(input: { model: string; where: AdapterWhere[] }) => Promise<null | T>;
    update: <T>(input: { model: string; update: Record<string, unknown>; where: AdapterWhere[] }) => Promise<null | T>;
}

/** better-auth's `user.create.before` / `.after` hook signatures, derived so an upstream rename fails to compile. */
type DatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;
type UserCreateAfter = NonNullable<NonNullable<NonNullable<DatabaseHooks["user"]>["create"]>["after"]>;
type UserCreateBefore = NonNullable<NonNullable<NonNullable<DatabaseHooks["user"]>["create"]>["before"]>;

/**
 * A stored timestamp as a number. Adapters hand `date` columns back as `Date`
 * (better-auth's D1/kysely layer parses them), but a raw row from a store that
 * didn't can still be compared rather than silently reading `NaN`.
 */
const toTime = (value: unknown): number => {
    if (value instanceof Date) {
        return value.getTime();
    }

    if (typeof value === "number") {
        return value;
    }

    return typeof value === "string" ? Date.parse(value) : Number.NaN;
};

/** Shape a raw adapter row as a {@link SignUpInvitation}. */
const toInvitation = (row: Record<string, unknown>): SignUpInvitation => {
    const acceptedAt = toTime(row["acceptedAt"]);

    return {
        // eslint-disable-next-line unicorn/no-null -- `null` is the stored "still pending" value, not an absent key.
        acceptedAt: Number.isNaN(acceptedAt) ? null : new Date(acceptedAt),
        createdAt: new Date(toTime(row["createdAt"])),
        email: String(row["email"]),
        expiresAt: new Date(toTime(row["expiresAt"])),
        id: String(row["id"]),
        // eslint-disable-next-line unicorn/no-null -- ditto: the column is nullable.
        invitedBy: typeof row["invitedBy"] === "string" ? row["invitedBy"] : null,
    };
};

/** The address an invitation is matched on: trimmed and lowercased, as better-auth stores `user.email`. */
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Read `user.email` off a hook payload, normalized. Absent for the account shapes that have none. */
const emailOf = (user: unknown): string | undefined => {
    const value = (user as { email?: unknown } | undefined)?.email;

    if (typeof value !== "string") {
        return undefined;
    }

    const normalized = normalizeEmail(value);

    return normalized === "" ? undefined : normalized;
};

/** The invitation for `email` if one is usable — present, unaccepted, unexpired. */
const findUsableInvitation = async (adapter: InvitationAdapter, email: string): Promise<Record<string, unknown> | undefined> => {
    const row = await adapter.findOne<Record<string, unknown>>({ model: MODEL, where: [{ field: "email", value: email }] });

    // A parseable `acceptedAt` means the invitation has already been used; unset
    // (however the adapter spells "unset") reads back as `NaN` — same test
    // `toInvitation` applies to the same column.
    if (row === null || !Number.isNaN(toTime(row["acceptedAt"]))) {
        return undefined;
    }

    return toTime(row["expiresAt"]) > Date.now() ? row : undefined;
};

/**
 * Warn once per auth context when the password provider is on without
 * `requireEmailVerification`, naming the exposure the docblock above describes.
 * Mirrors `./plugins-enterprise.ts`'s `sso()` warning: it does not change the
 * default, it just refuses to let the gap be silent.
 */
const warnIfVerificationOff = (options: BetterAuthOptions): void => {
    if (options.emailAndPassword?.enabled !== true || options.emailAndPassword.requireEmailVerification === true) {
        return;
    }

    // eslint-disable-next-line no-console
    console.warn(
        "@lunora/auth: inviteOnly() is installed with password sign-up but without " +
            "`emailAndPassword: { requireEmailVerification: true }`. An invitation is keyed by email address " +
            "alone, so anyone who learns an invited address can claim that seat before its owner does. " +
            "Turn verification on, or accept that invited addresses are the only credential.",
    );
};

/**
 * A better-auth server plugin that refuses to create an account for an address
 * with no pending invitation, and the `signUpInvitation` table those live in.
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
    const allowFirstUser = options.allowFirstUser ?? true;

    return {
        $ERROR_CODES: {
            SIGN_UP_INVITE_REQUIRED: { code: "SIGN_UP_INVITE_REQUIRED", message: "Sign-up is invite-only." },
        },
        id: "lunora-invite-only",
        init: (context) => {
            warnIfVerificationOff(context.options);

            const adapter = context.adapter as unknown as InvitationAdapter;

            // The bootstrap check is a `COUNT(*)` over `user`, and it runs on every
            // *uninvited* attempt — an attacker's lever. It can only ever go from
            // true to false (a database does not lose its users), so once one exists
            // stop asking.
            let mayBootstrap = allowFirstUser;

            const before: UserCreateBefore = async (user) => {
                const email = emailOf(user);

                // No address to match an invitation against (anonymous / siwe).
                // Documented in this module's docblock rather than guessed at here.
                if (email === undefined) {
                    return;
                }

                if (await findUsableInvitation(adapter, email)) {
                    return;
                }

                if (mayBootstrap) {
                    if ((await adapter.count({ model: "user" })) === 0) {
                        return;
                    }

                    mayBootstrap = false;
                }

                throw new APIError("FORBIDDEN", {
                    code: "SIGN_UP_INVITE_REQUIRED",
                    message: "sign-up is invite-only — ask an administrator for an invitation",
                });
            };

            // Stamping acceptance in the *after* hook, keyed by email again rather
            // than by carrying state across from `before`, means a failed create
            // doesn't burn the invitation. It cannot let a second account through:
            // `user.email` is unique, so the only sign-up that reaches here for an
            // address is the one that got it.
            const after: UserCreateAfter = async (user) => {
                const email = emailOf(user);

                if (email === undefined) {
                    return;
                }

                await adapter.update({ model: MODEL, update: { acceptedAt: new Date() }, where: [{ field: "email", value: email }] });
            };

            return { options: { databaseHooks: { user: { create: { after, before } } } } };
        },
        schema: {
            [MODEL]: {
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

/** Resolve the adapter off a built auth instance. The cast is the one in `inviteOnly`'s `init`, for the same reason. */
const adapterOf = async (auth: LunoraAuth): Promise<InvitationAdapter> => {
    const context = await auth.$context;

    return context.adapter as unknown as InvitationAdapter;
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
 */
const createSignUpInvitation = async (auth: LunoraAuth, input: { email: string; expiresInSeconds?: number; invitedBy?: string }): Promise<SignUpInvitation> => {
    const email = normalizeEmail(input.email);

    if (email === "" || !email.includes("@")) {
        throw new LunoraError("INVALID_INVITE_EMAIL", `not an email address to invite: ${JSON.stringify(input.email)}`);
    }

    const { expiresInSeconds } = input;

    if (expiresInSeconds !== undefined && (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0)) {
        throw new LunoraError("INVALID_INVITE_TTL", "expiresInSeconds must be a positive finite integer");
    }

    const expiresAt = new Date(Date.now() + Math.min(expiresInSeconds ?? DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS) * 1000);
    // eslint-disable-next-line unicorn/no-null -- clearing a prior acceptance needs an explicit null; `undefined` would leave the old value.
    const invitedBy = input.invitedBy ?? null;
    const adapter = await adapterOf(auth);

    const existing = await adapter.findOne<Record<string, unknown>>({ model: MODEL, where: [{ field: "email", value: email }] });

    if (existing) {
        const updated = await adapter.update<Record<string, unknown>>({
            model: MODEL,
            // eslint-disable-next-line unicorn/no-null -- see above.
            update: { acceptedAt: null, expiresAt, invitedBy },
            where: [{ field: "email", value: email }],
        });

        // Some adapters answer an update with `null` rather than the new row.
        return toInvitation(updated ?? { ...existing, acceptedAt: undefined, expiresAt, invitedBy });
    }

    return toInvitation(await adapter.create<Record<string, unknown>>({ data: { createdAt: new Date(), email, expiresAt, invitedBy }, model: MODEL }));
};

/**
 * Every invitation, newest first. `pendingOnly` drops the accepted and the
 * expired, which is the list an operator usually wants; the unfiltered form
 * doubles as the record of who was let in.
 */
const listSignUpInvitations = async (
    auth: LunoraAuth,
    options: { limit?: number; offset?: number; pendingOnly?: boolean } = {},
): Promise<SignUpInvitation[]> => {
    const adapter = await adapterOf(auth);

    const rows = await adapter.findMany<Record<string, unknown>>({
        limit: options.limit,
        model: MODEL,
        offset: options.offset,
        sortBy: { direction: "desc", field: "createdAt" },
    });

    const invitations = rows.map((row) => toInvitation(row));

    // Filtered here rather than in the query: "pending" is two conditions, one of
    // them a comparison against `now`, and adapter operator support varies by
    // backend. The page is already bounded by `limit`.
    return options.pendingOnly === true ? invitations.filter((row) => row.acceptedAt === null && row.expiresAt.getTime() > Date.now()) : invitations;
};

/**
 * Withdraw the invitation for `email`. Deletes the row, so it also forgets an
 * accepted one — the account it created is untouched, and removing that is
 * `AuthAdmin.removeUser`'s job.
 */
const revokeSignUpInvitation = async (auth: LunoraAuth, input: { email: string }): Promise<void> => {
    const adapter = await adapterOf(auth);

    await adapter.delete({ model: MODEL, where: [{ field: "email", value: normalizeEmail(input.email) }] });
};

export type { InviteOnlyOptions, SignUpInvitation };
export { createSignUpInvitation, inviteOnly, listSignUpInvitations, revokeSignUpInvitation };
