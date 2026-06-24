/**
 * Auth-feature D1 helpers shared by `lunora init`'s offer and `lunora add auth`.
 *
 * The base `auth` (email + password) manifest ships a `d1_databases` binding
 * with placeholder `database_name` and `database_id` values. The id can only
 * come from `wrangler d1 create`, but the name is a free user choice — so the
 * front doors prompt for the name and leave the id placeholder (with the
 * existing reminder to create the DB). All auth variants (Clerk / Auth0 / the
 * plugins) pull in the base `auth` item via `requires`, so this applies to any
 * auth selection; it no-ops on manifests without a D1 binding.
 */
import type { TextPrompt } from "../../util/tui-prompts";
import type { RegistryManifest } from "../registry/types";
import { setBindingField } from "../registry/types";
import toKebabSlug from "./slug";

/** The D1 binding name the base `auth` item declares. */
const DB_BINDING = "DB";

/** The database-name prompt shared by both front doors. */
const AUTH_DB_PROMPT = "Name your D1 database (run `wrangler d1 create` to get its id, then put it in wrangler.jsonc)";

/**
 * Coerce arbitrary text into a valid D1 database name, or `undefined` when
 * nothing valid can be salvaged. D1 names are permissive; we normalize to a
 * lowercase kebab slug (1–64 chars) so the written value is always safe.
 */
const sanitizeDatabaseName = (input: string): string | undefined => toKebabSlug(input, 1, 64);

/** A safe fallback when the project name yields nothing usable. */
const FALLBACK_DATABASE_NAME = "lunora-db";

/**
 * The default database name offered in the prompt: the project name suffixed
 * with `-db`, sanitized. Falls back to {@link FALLBACK_DATABASE_NAME}.
 */
const deriveDatabaseName = (projectName: string): string => sanitizeDatabaseName(`${projectName}-db`) ?? FALLBACK_DATABASE_NAME;

/**
 * Prompt for the database name (defaulting to the project-derived name) and
 * sanitize the answer, falling back to the default. Shared by both front doors
 * so the prompt + default + sanitize flow can't drift between them.
 */
const promptDatabaseName = async (text: TextPrompt, projectName: string): Promise<string> => {
    const fallback = deriveDatabaseName(projectName);

    return sanitizeDatabaseName(await text(AUTH_DB_PROMPT, { default: fallback, placeholder: fallback })) ?? fallback;
};

/**
 * Return a copy of `manifest` with the `DB` D1 binding's `database_name` set to
 * `name` (the `database_id` placeholder is left untouched — only `wrangler d1
 * create` can fill it). No-ops on items without a matching binding.
 */
const withAuthDatabaseName = (manifest: RegistryManifest, name: string): RegistryManifest =>
    setBindingField(manifest, "d1_databases", { key: "binding", value: DB_BINDING }, "database_name", name);

export { AUTH_DB_PROMPT, deriveDatabaseName, promptDatabaseName, sanitizeDatabaseName, withAuthDatabaseName };
