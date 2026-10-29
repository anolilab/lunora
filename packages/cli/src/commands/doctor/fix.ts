import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    DEV_VARS_FILE,
    generateSecretValue,
    inferLunoraBindings,
    isMintableSecretKey,
    isPlaceholderValue,
    mintableSecretKeysFor,
    parseDevVariableEntries,
    resolveSchemaDirectory,
    secretSourcesFromBindings,
    upsertDevVariableLine,
    writeDevVariablesFileAtomically,
} from "@lunora/config";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";

import { isSecretKeyName } from "../../../../../shared/secret-key";
import { resolveAdminBearer } from "../../util/admin-token";
import { detectPackageManager, toolchainExecArgs } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import { defaultSpawner } from "../../util/spawn";

/** A `database_id` that is empty or an angle-bracket template such as `<replace-with-d1-create-id>`. */
const isTemplateD1Id = (databaseId: string): boolean => {
    const value = databaseId.trim();

    return value === "" || (value.startsWith("<") && value.endsWith(">"));
};

const REPLACE_STAND_IN = /replace[-_\s]?(?:with|me)(?![a-z])/iu;

/**
 * A `database_id` a celld project never finished: empty, an angle-bracket template, or a replace-with / replace-me
 * stand-in such as `REPLACE_WITH_ID`. A word that merely starts with "replace" (`replacement-orders`) is an identity.
 */
const isUnfinishedD1Id = (databaseId: string): boolean => isTemplateD1Id(databaseId) || REPLACE_STAND_IN.test(databaseId);

/** A D1 `database_id` placeholder that still needs `wrangler d1 create` run. */
const isD1PlaceholderId = (databaseId: string): boolean => isTemplateD1Id(databaseId) || databaseId.trim().toLowerCase().includes("replace");

const LINE_BREAK = /\r?\n/u;

interface WranglerRunnerResult {
    code: number;
    stderr: string;
    stdout: string;
}

/** Runs `wrangler <args>` in the project. Injected in tests so no Cloudflare call is made. */
type WranglerRunner = (args: ReadonlyArray<string>, cwd: string) => Promise<WranglerRunnerResult>;

interface DoctorFixOptions {
    /** The wrangler config the D1 placeholders live in, as `findWranglerFile` returns it. */
    configPath: string | undefined;
    cwd: string;
    /** Report what would change without creating a resource or writing a file. */
    dryRun: boolean;
    logger: Logger;
    /** Injected wrangler runner; defaults to the project's package manager running wrangler. */
    runner?: WranglerRunner;
}

interface DoctorFixResult {
    /** One line per change applied (or that would be applied under `dryRun`). */
    applied: string[];
    /** One line per finding `--fix` could not resolve, with the reason. */
    skipped: string[];
}

interface D1Placeholder {
    binding: string;
    index: number;
    name: string | undefined;
}

const defaultRunner = async (args: ReadonlyArray<string>, cwd: string): Promise<WranglerRunnerResult> => {
    // `wrangler` is a project dependency, so it runs through the project's package manager.
    const { args: execArgs, command } = toolchainExecArgs(detectPackageManager(cwd), { args, tool: "wrangler" });

    try {
        const result = await defaultSpawner({ args: execArgs, captureStderr: true, captureStdoutSilently: true, command, cwd });

        return { code: result.code, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
    } catch (error: unknown) {
        return { code: 1, stderr: error instanceof Error ? error.message : String(error), stdout: "" };
    }
};

/**
 * The D1 databases on the account, by name → uuid, from `wrangler d1 list --json`.
 * `undefined` when the list cannot be read, so a caller never creates a second
 * database because the first lookup failed.
 */
const listD1Databases = async (runner: WranglerRunner, cwd: string): Promise<Map<string, string> | undefined> => {
    const result = await runner(["d1", "list", "--json"], cwd);

    if (result.code !== 0) {
        return undefined;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(result.stdout);
    } catch {
        return undefined;
    }

    if (!Array.isArray(parsed)) {
        return undefined;
    }

    const databases = new Map<string, string>();

    for (const entry of parsed as ReadonlyArray<{ name?: unknown; uuid?: unknown }>) {
        if (typeof entry.name === "string" && typeof entry.uuid === "string") {
            databases.set(entry.name, entry.uuid);
        }
    }

    return databases;
};

/** The `d1_databases` entries whose `database_id` is still a placeholder, by their index in the array. */
const placeholdersIn = (text: string): D1Placeholder[] => {
    const parsed = parseJsonc(text) as { d1_databases?: unknown } | undefined;
    const databases = Array.isArray(parsed?.d1_databases) ? parsed.d1_databases : [];

    return databases.flatMap((entry, index): D1Placeholder[] => {
        if (entry === null || typeof entry !== "object") {
            return [];
        }

        const database = entry as { binding?: unknown; database_id?: unknown; database_name?: unknown };
        const databaseId = typeof database.database_id === "string" ? database.database_id : "";

        if (!isD1PlaceholderId(databaseId)) {
            return [];
        }

        return [
            {
                binding: typeof database.binding === "string" && database.binding !== "" ? database.binding : "<unnamed>",
                index,
                name: typeof database.database_name === "string" && database.database_name !== "" ? database.database_name : undefined,
            },
        ];
    });
};

/**
 * The uuid to write for one placeholder: the existing database of that name, or
 * a new one created first. `undefined` (with the reason recorded in `result`) when
 * the id cannot be known. Under `dryRun` a create is described, never run.
 */
const resolveD1Id = async (
    placeholder: D1Placeholder & { name: string },
    options: DoctorFixOptions,
    runner: WranglerRunner,
    result: DoctorFixResult,
): Promise<string | undefined> => {
    const existing = await listD1Databases(runner, options.cwd);

    if (existing === undefined) {
        result.skipped.push(
            `D1 "${placeholder.binding}": could not run \`wrangler d1 list --json\`. Check that wrangler is installed in this project and logged in (\`wrangler login\`), then retry.`,
        );

        return undefined;
    }

    const found = existing.get(placeholder.name);

    if (found !== undefined) {
        return found;
    }

    if (options.dryRun) {
        result.applied.push(`would run \`wrangler d1 create ${placeholder.name}\` and write its id into ${placeholder.binding}`);

        return undefined;
    }

    const created = await runner(["d1", "create", placeholder.name], options.cwd);

    if (created.code !== 0) {
        const reason = created.stderr.trim() || `exit ${String(created.code)}`;

        result.skipped.push(`D1 "${placeholder.binding}": \`wrangler d1 create ${placeholder.name}\` failed: ${reason}`);

        return undefined;
    }

    // Read the id back from the list: the create output is prose, not a contract.
    const listed = await listD1Databases(runner, options.cwd);
    const readBack = listed?.get(placeholder.name);

    if (readBack === undefined) {
        result.skipped.push(`D1 "${placeholder.binding}": created ${placeholder.name} but could not read back its id.`);
    }

    return readBack;
};

/**
 * Replace each placeholder `database_id` with the uuid of the D1 database of the
 * same `database_name`, creating the database first when the account has none.
 * An existing database is reused, never recreated. Edits go through `jsonc-parser`
 * so the comments in `wrangler.jsonc` survive.
 */
const fixD1Placeholders = async (options: DoctorFixOptions, result: DoctorFixResult): Promise<void> => {
    if (options.configPath === undefined) {
        return;
    }

    const runner = options.runner ?? defaultRunner;
    const text = readFileSync(options.configPath, "utf8");
    const placeholders = placeholdersIn(text);
    let edited = text;

    for (const placeholder of placeholders) {
        if (placeholder.name === undefined) {
            result.skipped.push(`D1 "${placeholder.binding}" has no database_name, so there is no database to create or reuse.`);

            continue;
        }

        // Sequential on purpose: each database must exist before the next lookup.
        // eslint-disable-next-line no-await-in-loop -- one wrangler call at a time, by design.
        const uuid = await resolveD1Id({ ...placeholder, name: placeholder.name }, options, runner, result);

        if (uuid !== undefined) {
            const edits = modify(edited, ["d1_databases", placeholder.index, "database_id"], uuid, {
                formattingOptions: { eol: "\n", insertSpaces: true, tabSize: 4 },
            });

            edited = applyEdits(edited, edits);
            result.applied.push(`${placeholder.binding}: database_id set to the id of D1 "${placeholder.name}"`);
        }
    }

    if (!options.dryRun && edited !== text) {
        writeFileSync(options.configPath, edited);
    }
};

/**
 * `.dev.vars` holds plaintext secrets, so it is written only when git already
 * ignores it. Git answers that for any ignore file in the tree (a root `.gitignore`
 * of a monorepo, a `/.dev.vars` pattern); outside a repository, the project's own
 * `.gitignore` must carry the exact line. Unknown is a refusal, never a write.
 */
const devVariablesIsIgnored = (cwd: string): boolean => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` must resolve from PATH (install location varies); args are fixed and no shell is involved
    const check = spawnSync("git", ["check-ignore", "-q", DEV_VARS_FILE], { cwd, stdio: "ignore" });

    if (check.status === 0) {
        return true;
    }

    if (check.status === 1) {
        return false;
    }

    const gitignore = join(cwd, ".gitignore");

    return (
        existsSync(gitignore) &&
        readFileSync(gitignore, "utf8")
            .split(LINE_BREAK)
            .some((line) => line.trim() === DEV_VARS_FILE)
    );
};

/**
 * The keys this project's role may mint. A worker that only constructs the client takes the host's relay key, so it is not minted one.
 * When the bindings cannot be read, every registry key stays mintable, as before, and the fallback is reported.
 */
const mintableKeysFor = async (cwd: string, result: DoctorFixResult): Promise<ReadonlySet<string> | undefined> => {
    try {
        return mintableSecretKeysFor(secretSourcesFromBindings(await inferLunoraBindings({ projectRoot: cwd, schemaDir: resolveSchemaDirectory(cwd) })));
    } catch {
        result.skipped.push(`${DEV_VARS_FILE}: could not read the project's bindings, so the relay key was not checked against its role.`);

        return undefined;
    }
};

/** The keys `.dev.vars` needs minted: the admin token when absent, and mintable secrets still at a placeholder. */
const keysToMint = (
    cwd: string,
    content: string,
    entries: ReadonlyArray<{ key: string; value: string }>,
    result: DoctorFixResult,
    mintable: ReadonlySet<string> | undefined,
): string[] => {
    const minted: string[] = [];
    // A key with a real value anywhere in the file is never minted over, even when a later
    // duplicate line is a placeholder. The later line wins at read time, but the real value
    // is still the operator's, and the upsert would drop it.
    // Read every line: parseDevVariableEntries keeps only the last line for a key, which is the placeholder here.
    const realKeys = new Set(
        content.split(LINE_BREAK).flatMap((line) => {
            const [entry] = parseDevVariableEntries(line);

            return entry !== undefined && !isPlaceholderValue(entry.value) ? [entry.key] : [];
        }),
    );

    // The same resolver doctor uses for `admin-token-missing`, so an admin token
    // already exported in the environment is not shadowed by a second one in .dev.vars.
    if (resolveAdminBearer({ cwd }).source === undefined && !realKeys.has("LUNORA_ADMIN_TOKEN")) {
        minted.push("LUNORA_ADMIN_TOKEN");
    }

    for (const entry of entries) {
        if (!isSecretKeyName(entry.key) || !isPlaceholderValue(entry.value) || realKeys.has(entry.key)) {
            continue;
        }

        if (isMintableSecretKey(entry.key, entry.value, mintable)) {
            minted.push(entry.key);
        } else {
            result.skipped.push(`${DEV_VARS_FILE}: ${entry.key} is a provider key and cannot be minted here; fill it in by hand.`);
        }
    }

    return minted;
};

/**
 * Mint the secrets doctor reports as missing in `.dev.vars`. Provider keys that
 * cannot be minted locally are left for the operator and reported. Existing
 * non-placeholder values are never touched.
 */
const fixDevVariables = async (options: DoctorFixOptions, result: DoctorFixResult): Promise<void> => {
    const path = join(options.cwd, DEV_VARS_FILE);
    const content = existsSync(path) ? readFileSync(path, "utf8") : "";
    const minted = keysToMint(options.cwd, content, parseDevVariableEntries(content), result, await mintableKeysFor(options.cwd, result));

    if (minted.length === 0) {
        return;
    }

    if (!devVariablesIsIgnored(options.cwd)) {
        result.skipped.push(`${DEV_VARS_FILE} is not in .gitignore, so no secret is written there. Add \`${DEV_VARS_FILE}\` to .gitignore first.`);

        return;
    }

    if (options.dryRun) {
        result.applied.push(`would mint ${minted.join(", ")} into ${DEV_VARS_FILE}`);

        return;
    }

    let next = content;

    for (const key of minted) {
        next = upsertDevVariableLine(next, key, generateSecretValue());
    }

    writeDevVariablesFileAtomically(path, next);
    result.applied.push(`minted ${minted.join(", ")} into ${DEV_VARS_FILE}`);
};

/**
 * `lunora doctor --fix`: resolve what the preflight can resolve on its own, and
 * say why for the rest. Only the findings doctor already reports are handled
 * (`d1-placeholder-id`, `admin-token-missing`, `dev-vars-missing-secret`); R2 and
 * queue resources have no machine-readable existence check, so they are not
 * created here. Under `dryRun` nothing is created or written.
 */
const applyDoctorFixes = async (options: DoctorFixOptions): Promise<DoctorFixResult> => {
    const result: DoctorFixResult = { applied: [], skipped: [] };

    await fixD1Placeholders(options, result);
    await fixDevVariables(options, result);

    return result;
};

export { applyDoctorFixes, isD1PlaceholderId, isUnfinishedD1Id };
export type { DoctorFixOptions, DoctorFixResult };
