/**
 * Reading an auth dump off disk and emitting better-auth rows.
 *
 * Kept apart from the mapping in `auth.ts` — that module decides what a
 * Supabase or Firebase identity *becomes*, this one decides how to get it off
 * disk. The split matters because the two dumps arrive in different formats
 * (CSV, JSON) but produce the same two tables.
 */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { LunoraError } from "@lunora/errors";
import { parse } from "csv-parse/sync";

import type { Logger } from "../../../util/logger";
import type { AuthRows, FirebaseAuthUser, SupabaseAuthUser } from "./auth";
import { emitAuthRows, fromFirebaseUser, fromSupabaseUser } from "./auth";
import type { ImportSourceMapping } from "./mapping";
import { castPostgresCsv } from "./supabase";

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

export { readAuthDump, readFirebaseAuth, readSupabaseAuth };
