/**
 * The sign-in tables in the workerd suite's real D1. `ensureSignIn` runs the same migration the Worker runs
 * on its first request, so the columns are better-auth's own. `seedSignIn` writes one subject's user,
 * session and password account with every column the schema requires.
 */
import { ensureMigrated } from "@lunora/auth/migrate";

import { buildMigrationAuth } from "../../lunora/auth";

export const ensureSignIn = async (db: D1Database, secret: string): Promise<void> => {
    await ensureMigrated(buildMigrationAuth({ AUTH_SECRET: secret, DB: db }));
};

/** Removes every sign-in row, so each test starts with the same tables and no rows. */
export const clearSignIn = async (db: D1Database): Promise<void> => {
    await db.batch(["account", "session", "user"].map((table) => db.prepare(`DELETE FROM "${table}"`)));
};

/** One subject's user, session and password account. */
export const seedSignIn = async (db: D1Database, userId: string): Promise<void> => {
    const now = Date.now();

    await db
        .prepare('INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 0, ?, ?)')
        .bind(userId, userId, `${userId}@example.test`, now, now)
        .run();
    await db
        .prepare('INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, ?, ?, ?)')
        .bind(`${userId}-session`, now + 86_400_000, `${userId}-token`, now, now, userId)
        .run();
    await db
        .prepare('INSERT INTO "account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(`${userId}-account`, userId, "credential", userId, "hash", now, now)
        .run();
};
