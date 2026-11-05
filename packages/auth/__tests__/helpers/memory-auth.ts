import { memoryAdapter } from "better-auth/adapters/memory";

import type { LunoraAuth, LunoraAuthOptions } from "../../src/create-auth";
import { createAuth } from "../../src/create-auth";
import memoryTables from "./memory-tables";

/** A real better-auth instance over a fresh in-memory adapter, with every table already created. */
const createMemoryAuth = (options: Omit<LunoraAuthOptions, "database">): LunoraAuth =>
    createAuth({ ...options, database: memoryAdapter(memoryTables(options)) });

export default createMemoryAuth;
