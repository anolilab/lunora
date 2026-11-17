import { getAuthTables } from "better-auth/db";

import type { LunoraAuthOptions } from "../../src/create-auth";
import { resolveAuthOptions } from "../../src/create-auth";

/**
 * A `memoryAdapter` store with an empty array for every table the resolved plugin
 * set declares.
 *
 * The memory adapter throws on a model it has no array for, and a plugin such as
 * `mcp()` writes tables (`oauthClient`, `jwks`, …) the bare options never name — so
 * the tables come from the *resolved* options, the set `createAuth` actually runs.
 */
const memoryTables = (options: LunoraAuthOptions): Record<string, unknown[]> =>
    Object.fromEntries(Object.values(getAuthTables(resolveAuthOptions(options))).map((table) => [table.modelName, []]));

export default memoryTables;
