/**
 * Auth import: a Supabase `auth.users` dump or a Firebase `auth:export` JSON
 * becomes better-auth `user` and `account` rows.
 *
 * **Passwords are never migrated.** Supabase stores bcrypt, Firebase its own
 * scrypt variant, and better-auth hashes with neither — there is no honest way
 * to carry a hash across, and inventing one would lock every user out with an
 * error they cannot act on. Every imported user lands without a credential
 * account, and the guide documents the "forgot password" reset that gives them
 * one. `emailVerified` and profile fields carry over, so the reset is the only
 * thing a user has to redo.
 */
import { LunoraError } from "@lunora/errors";

/** An all-digits value is already epoch milliseconds, not a date string. */
const EPOCH_DIGITS_RE = /^\d+$/;

/** One better-auth row pair for an imported identity. */
interface AuthRows {
    accounts: Record<string, unknown>[];
    user: Record<string, unknown>;
}

/** Supabase `auth.users` columns this reads. Everything else is ignored. */
interface SupabaseAuthUser {
    created_at?: null | string;
    email?: null | string;
    email_confirmed_at?: null | string;
    id?: null | string;
    last_sign_in_at?: null | string;
    raw_user_meta_data?: unknown;
    updated_at?: null | string;
}

/** Firebase `auth:export` account entries. */
interface FirebaseAuthUser {
    createdAt?: null | number | string;
    displayName?: null | string;
    email?: null | string;
    emailVerified?: boolean | null;
    lastSignedInAt?: null | number | string;
    localId?: null | string;
    photoUrl?: null | string;
    providerUserInfo?: { federatedId?: null | string; providerId?: null | string; rawId?: null | string }[];
}

const toEpochMs = (value: null | number | string | undefined): number | undefined => {
    if (value === null || value === undefined) {
        return undefined;
    }

    if (typeof value === "number") {
        return value;
    }

    const numeric = Number(value);

    if (Number.isFinite(numeric) && EPOCH_DIGITS_RE.test(value)) {
        return numeric;
    }

    const parsed = Date.parse(value.includes("T") ? value : value.replace(" ", "T"));

    return Number.isNaN(parsed) ? undefined : parsed;
};

/** Pull a display name out of Supabase's free-form user metadata. */
const nameFromMetadata = (metadata: unknown): string | undefined => {
    if (metadata === null || typeof metadata !== "object") {
        return undefined;
    }

    const record = metadata as Record<string, unknown>;

    for (const key of ["name", "full_name", "user_name", "preferred_username"]) {
        if (typeof record[key] === "string" && record[key].length > 0) {
            return record[key];
        }
    }

    return undefined;
};

const imageFromMetadata = (metadata: unknown): string | undefined => {
    if (metadata === null || typeof metadata !== "object") {
        return undefined;
    }

    const record = metadata as Record<string, unknown>;

    for (const key of ["avatar_url", "picture"]) {
        if (typeof record[key] === "string" && record[key].length > 0) {
            return record[key];
        }
    }

    return undefined;
};

/**
 * Map one Supabase `auth.users` row (plus any `auth.identities` rows for it).
 *
 * `email_confirmed_at` being set is Supabase's statement that the address was
 * verified, which is exactly better-auth's boolean `emailVerified`.
 */
const fromSupabaseUser = (row: SupabaseAuthUser, identities: ReadonlyArray<Record<string, unknown>>): AuthRows => {
    const { id } = row;

    if (typeof id !== "string" || id.length === 0) {
        throw new LunoraError("INTERNAL", "auth row is missing `id` — every user needs an id to preserve");
    }

    const metadata = row.raw_user_meta_data;
    const user: Record<string, unknown> = {
        _id: id,
        // eslint-disable-next-line unicorn/no-null -- better-auth stores an absent email as SQL NULL
        email: row.email ?? null,
        emailVerified: typeof row.email_confirmed_at === "string" && row.email_confirmed_at.length > 0,
        id,
    };

    const name = nameFromMetadata(metadata);
    const image = imageFromMetadata(metadata);
    const createdAt = toEpochMs(row.created_at);
    const updatedAt = toEpochMs(row.updated_at);

    if (name !== undefined) {
        user["name"] = name;
    }

    if (image !== undefined) {
        user["image"] = image;
    }

    if (createdAt !== undefined) {
        user["createdAt"] = createdAt;
    }

    if (updatedAt !== undefined) {
        user["updatedAt"] = updatedAt;
    }

    const accounts = identities.map((identity) => {
        const provider = typeof identity["provider"] === "string" ? identity["provider"] : "unknown";
        const providerAccountId = typeof identity["provider_id"] === "string" ? identity["provider_id"] : id;

        return {
            _id: `${id}:${provider}`,
            accountId: providerAccountId,
            id: `${id}:${provider}`,
            providerId: provider,
            userId: id,
        };
    });

    return { accounts, user };
};

/** Map one Firebase `auth:export` account entry. */
const fromFirebaseUser = (row: FirebaseAuthUser): AuthRows => {
    const id = row.localId;

    if (typeof id !== "string" || id.length === 0) {
        throw new LunoraError("INTERNAL", "auth row is missing `localId` — every user needs an id to preserve");
    }

    const user: Record<string, unknown> = {
        _id: id,
        // eslint-disable-next-line unicorn/no-null -- better-auth stores an absent email as SQL NULL
        email: row.email ?? null,
        emailVerified: row.emailVerified === true,
        id,
    };

    const createdAt = toEpochMs(row.createdAt);

    if (typeof row.displayName === "string") {
        user["name"] = row.displayName;
    }

    if (typeof row.photoUrl === "string") {
        user["image"] = row.photoUrl;
    }

    if (createdAt !== undefined) {
        user["createdAt"] = createdAt;
    }

    // `password`/`passwordHash`/`salt` are present in an `auth:export` dump and
    // are deliberately not read: see the module comment.
    const accounts = (row.providerUserInfo ?? [])
        .filter((info) => typeof info.providerId === "string" && info.providerId !== "password")
        .map((info) => {
            const provider = info.providerId as string;

            return {
                _id: `${id}:${provider}`,
                accountId: info.rawId ?? info.federatedId ?? id,
                id: `${id}:${provider}`,
                providerId: provider,
                userId: id,
            };
        });

    return { accounts, user };
};

/**
 * Turn a set of imported users into `{ table, doc }` NDJSON, refusing duplicate
 * emails.
 *
 * A collision means two source rows claim one identity, and picking a winner
 * silently merges two people's data. Imports are all-or-nothing, so the run
 * fails with the offending addresses listed and the operator resolves it in the
 * dump — where they can see both rows.
 */
const emitAuthRows = (rows: ReadonlyArray<AuthRows>, sourceRows: Map<string, number>): string[] => {
    const byEmail = new Map<string, string>();
    const duplicates: string[] = [];
    const lines: string[] = [];

    for (const { accounts, user } of rows) {
        const email = typeof user["email"] === "string" ? user["email"].toLowerCase() : undefined;

        if (email !== undefined && email.length > 0) {
            const existing = byEmail.get(email);

            if (existing === undefined) {
                byEmail.set(email, String(user["_id"]));
            } else {
                duplicates.push(`${email} (ids ${existing} and ${String(user["_id"])})`);
            }
        }

        lines.push(`${JSON.stringify({ doc: user, table: "user" })}\n`);
        sourceRows.set("user", (sourceRows.get("user") ?? 0) + 1);

        for (const account of accounts) {
            lines.push(`${JSON.stringify({ doc: account, table: "account" })}\n`);
            sourceRows.set("account", (sourceRows.get("account") ?? 0) + 1);
        }
    }

    if (duplicates.length > 0) {
        throw new LunoraError(
            "INTERNAL",
            `auth import found ${String(duplicates.length)} duplicate email(s), which would merge distinct users: ${duplicates.slice(0, 10).join("; ")}${duplicates.length > 10 ? " …" : ""}`,
        );
    }

    return lines;
};

export type { AuthRows, FirebaseAuthUser, SupabaseAuthUser };
export { emitAuthRows, fromFirebaseUser, fromSupabaseUser };
