/**
 * Auth import: reading a Supabase `auth.users` dump or a Firebase `auth:export`
 * JSON off disk, and mapping it into better-auth `user` and `account` rows.
 *
 * **Passwords are never migrated.** Supabase stores bcrypt, Firebase its own
 * scrypt variant, and better-auth hashes with neither — there is no honest way
 * to carry a hash across, and inventing one would lock every user out with an
 * error they cannot act on. Every imported user lands without a credential
 * account, and the guide documents the "forgot password" reset that gives them
 * one. `emailVerified` and profile fields carry over, so the reset is the only
 * thing a user has to redo.
 */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { LunoraError } from "@lunora/errors";
import { parse } from "csv-parse/sync";

import type { Logger } from "../../../util/logger";
import type { ImportSourceMapping } from "./mapping";
import { castPostgresCsv } from "./supabase";

/** An all-digits value is already epoch milliseconds, not a date string. */
const EPOCH_DIGITS_RE = /^\d+$/;

/** Postgres writes `+00`, which is not a valid ISO-8601 offset until it gains its minutes. */
const BARE_HOUR_OFFSET_RE = /[+-]\d{2}$/;

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

    const iso = value.includes("T") ? value : value.replace(" ", "T");
    const parsed = Date.parse(BARE_HOUR_OFFSET_RE.test(iso) ? `${iso}:00` : iso);

    return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * Supabase's `raw_user_meta_data` is `jsonb`, so a CSV dump hands it over as a
 * JSON *string* while a direct read hands over an object. Accept both.
 */
const asMetadataObject = (metadata: unknown): Record<string, unknown> | undefined => {
    if (typeof metadata === "string") {
        try {
            const parsed: unknown = JSON.parse(metadata);

            return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
        } catch {
            return undefined;
        }
    }

    return metadata !== null && typeof metadata === "object" ? (metadata as Record<string, unknown>) : undefined;
};

/** Pull a display name out of Supabase's free-form user metadata. */
const nameFromMetadata = (metadata: unknown): string | undefined => {
    const record = asMetadataObject(metadata);

    if (record === undefined) {
        return undefined;
    }

    for (const key of ["name", "full_name", "user_name", "preferred_username"]) {
        if (typeof record[key] === "string" && record[key].length > 0) {
            return record[key];
        }
    }

    return undefined;
};

const imageFromMetadata = (metadata: unknown): string | undefined => {
    const record = asMetadataObject(metadata);

    if (record === undefined) {
        return undefined;
    }

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

        // The provider account id is part of the key: a user CAN hold two
        // identities at the same provider, and keying on `user:provider` alone
        // makes the second collide with the first — one silently replacing the
        // other, or the import failing on a duplicate id.
        const accountKey = `${id}:${provider}:${providerAccountId}`;

        return {
            _id: accountKey,
            accountId: providerAccountId,
            id: accountKey,
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
            const providerAccountId = info.rawId ?? info.federatedId ?? id;
            // Same reason as the Supabase mapper: `user:provider` alone is not
            // unique across two identities at one provider.
            const accountKey = `${id}:${provider}:${providerAccountId}`;

            return {
                _id: accountKey,
                accountId: providerAccountId,
                id: accountKey,
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

/** Resolve a mapping-named file inside the dump directory, by basename only. */
const resolveDumpFile = (directory: string, file: string): string => join(directory, basename(file));

/** Parse a Supabase auth CSV, sharing the table reader's NULL handling. */
const readCsvRows = async (path: string): Promise<Record<string, string | null>[]> => {
    const text = await readFile(path, "utf8");

    return parse(text, { cast: castPostgresCsv, columns: true, skipEmptyLines: true });
};

/** Group `auth.identities` rows by the user they belong to. */
const readIdentities = async (directory: string, identitiesFile: string | undefined): Promise<Map<string, Record<string, unknown>[]>> => {
    const byUser = new Map<string, Record<string, unknown>[]>();

    if (identitiesFile === undefined) {
        return byUser;
    }

    for (const identity of await readCsvRows(resolveDumpFile(directory, identitiesFile))) {
        const userId = identity["user_id"];

        if (typeof userId === "string") {
            byUser.set(userId, [...(byUser.get(userId) ?? []), identity]);
        }
    }

    return byUser;
};

/**
 * Read a Supabase auth dump: `auth.users` plus, when named, `auth.identities`
 * for the linked OAuth providers.
 */
const readSupabaseAuth = async (directory: string, mapping: ImportSourceMapping): Promise<AuthRows[]> => {
    const usersFile = mapping.auth?.file;

    if (usersFile === undefined) {
        return [];
    }

    const users = await readCsvRows(resolveDumpFile(directory, usersFile));
    const identitiesByUser = await readIdentities(directory, mapping.auth?.identitiesFile);

    return users.map((row) => fromSupabaseUser(row as SupabaseAuthUser, identitiesByUser.get(row["id"] ?? "") ?? []));
};

/** Read a Firebase `auth:export` dump (`{ users: [...] }`, or a bare array). */
const readFirebaseAuth = async (directory: string, mapping: ImportSourceMapping): Promise<AuthRows[]> => {
    const file = mapping.auth?.file;

    if (file === undefined) {
        return [];
    }

    const path = resolveDumpFile(directory, file);
    let parsed: unknown;

    try {
        parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error: unknown) {
        throw new LunoraError("INTERNAL", `${basename(path)}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    const users = Array.isArray(parsed) ? parsed : ((parsed as { users?: unknown }).users ?? []);

    if (!Array.isArray(users)) {
        throw new LunoraError("INTERNAL", `${basename(path)}: expected \`{ users: [...] }\` from \`firebase auth:export\`, or a bare array`);
    }

    return (users as FirebaseAuthUser[]).map((row) => fromFirebaseUser(row));
};

/**
 * Emit the auth rows for a dump, or nothing when the mapping names no auth file.
 *
 * Users come first in the stream so an `account` row never lands before the
 * `user` it points at — the same files-before-documents ordering the storage
 * transfer uses, for the same reason.
 */
const readAuthDump = async function* (
    source: "firebase" | "supabase",
    directory: string,
    mapping: ImportSourceMapping | undefined,
    logger: Logger,
    sourceRows: Map<string, number>,
): AsyncGenerator<string> {
    if (mapping?.auth?.file === undefined) {
        return;
    }

    const rows = source === "supabase" ? await readSupabaseAuth(directory, mapping) : await readFirebaseAuth(directory, mapping);

    logger.info(`auth: ${String(rows.length)} user(s) — passwords are never migrated; users reset via "forgot password"`);

    for (const line of emitAuthRows(rows, sourceRows)) {
        yield line;
    }
};

export type { AuthRows, FirebaseAuthUser, SupabaseAuthUser };
export { emitAuthRows, fromFirebaseUser, fromSupabaseUser, readAuthDump, readFirebaseAuth, readSupabaseAuth };
