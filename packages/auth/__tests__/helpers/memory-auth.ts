import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";

import type { LunoraAuth, LunoraAuthOptions } from "../../src/create-auth";
import { createAuth, resolveAuthOptions } from "../../src/create-auth";

/**
 * A real better-auth instance over a fresh in-memory adapter, with every table the
 * resolved plugin set declares already created.
 *
 * The memory adapter throws on a model it has no array for, and a plugin such as
 * `mcp()` writes tables (`oauthClient`, `jwks`, …) the bare options never name — so
 * the tables come from the *resolved* options, the set `createAuth` actually runs.
 */
const createMemoryAuth = (options: Omit<LunoraAuthOptions, "database">): LunoraAuth => {
    const database: Record<string, unknown[]> = {};
    const withDatabase: LunoraAuthOptions = { ...options, database: memoryAdapter(database) };

    for (const table of Object.values(getAuthTables(resolveAuthOptions(withDatabase)))) {
        database[table.modelName] = [];
    }

    return createAuth(withDatabase);
};

export default createMemoryAuth;
