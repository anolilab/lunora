/**
 * Tables of the generated domains. `scripts/generate.mjs` rewrites this file and
 * writes the domain modules beside it; the committed copy is the empty core-only
 * state, which `node scripts/generate.mjs --domains 0` restores.
 */
import { definePlugin, defineSchemaExtension } from "lunorash/server";

export const domains = definePlugin("dom", { extension: defineSchemaExtension("dom", { tables: {} }) });
