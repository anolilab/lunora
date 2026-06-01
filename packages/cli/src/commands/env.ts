import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "../util/logger.js";
import type { SpawnDescriptor, Spawner } from "../util/spawn.js";
import { defaultSpawner } from "../util/spawn.js";

type EnvSubcommand = "get" | "list" | "push" | "set" | "unset";

interface EnvCommandOptions {
    cwd?: string;
    /** Required for `set`. Required (positional) for `get`/`unset`. */
    key?: string;
    logger: Logger;
    prod?: boolean;
    spawner?: Spawner;
    subcommand: EnvSubcommand;
    /** Required for `set`. */
    value?: string;
    /** When true, `push` proceeds without an explicit confirmation prompt. */
    yes?: boolean;
}

interface EnvCommandResult {
    code: number;
    /** For `push`, the descriptors that were spawned. */
    descriptors: ReadonlyArray<SpawnDescriptor>;
}

const DEV_VARS_FILE = ".dev.vars";

const KEY_PATTERN = /^[A-Za-z_]\w*$/u;

const NEWLINE_SPLIT = /\r?\n/u;

const NEWLINE_PRESENT = /[\r\n]/u;

interface ParsedLine {
    key: string;
    quoted: boolean;
    value: string;
}

const parseDevVariables = (content: string): Map<string, ParsedLine> => {
    const map = new Map<string, ParsedLine>();

    for (const rawLine of content.split(NEWLINE_SPLIT)) {
        const line = rawLine.trim();

        if (line === "" || line.startsWith("#")) {
            continue;
        }

        const eq = line.indexOf("=");

        if (eq <= 0) {
            continue;
        }

        const key = line.slice(0, eq).trim();

        if (!KEY_PATTERN.test(key)) {
            continue;
        }

        let value = line.slice(eq + 1).trim();
        let quoted = false;

        if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
            quoted = true;
            value = value.slice(1, -1);
        }

        map.set(key, { key, quoted, value });
    }

    return map;
};

const serializeDevVariables = (map: Map<string, ParsedLine>): string => {
    const lines: string[] = [];

    for (const entry of map.values()) {
        // Always quote to preserve whitespace and special characters round-trip.
        // Newlines are rejected at write time (env set), so single-line escaping
        // of backslash + double-quote is sufficient here.
        const escaped = entry.value.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`);

        lines.push(`${entry.key}="${escaped}"`);
    }

    return `${lines.join("\n")}\n`;
};

const redact = (value: string): string => {
    if (value.length <= 4) {
        return "****";
    }

    return `${value.slice(0, 4)}${"*".repeat(Math.min(8, value.length - 4))}`;
};

const loadDevVariables = (devVariablesPath: string): Map<string, ParsedLine> => {
    if (!existsSync(devVariablesPath)) {
        return new Map();
    }

    return parseDevVariables(readFileSync(devVariablesPath, "utf8"));
};

interface EnvContext {
    devVariablesPath: string;
    logger: Logger;
    options: EnvCommandOptions;
}

const runEnvList = (context: EnvContext): EnvCommandResult => {
    const map = loadDevVariables(context.devVariablesPath);

    if (map.size === 0) {
        context.logger.info(`${DEV_VARS_FILE}: (empty)`);

        return { code: 0, descriptors: [] };
    }

    for (const entry of map.values()) {
        context.logger.info(`${entry.key}=${redact(entry.value)}`);
    }

    return { code: 0, descriptors: [] };
};

const runEnvGet = (context: EnvContext): EnvCommandResult => {
    const { devVariablesPath, logger, options } = context;

    if (!options.key) {
        logger.error("env get requires a key. Usage: cirrus env get <KEY>");

        return { code: 1, descriptors: [] };
    }

    const entry = loadDevVariables(devVariablesPath).get(options.key);

    if (!entry) {
        logger.error(`env: ${options.key} is not set in ${DEV_VARS_FILE}`);

        return { code: 1, descriptors: [] };
    }

    // Get prints the full value (caller asked for it explicitly).
    process.stdout.write(`${entry.value}\n`);

    return { code: 0, descriptors: [] };
};

const runEnvSet = (context: EnvContext): EnvCommandResult => {
    const { devVariablesPath, logger, options } = context;

    if (!options.key) {
        logger.error("env set requires a key. Usage: cirrus env set <KEY> <VALUE>");

        return { code: 1, descriptors: [] };
    }

    if (!KEY_PATTERN.test(options.key)) {
        logger.error(`env: invalid key "${options.key}" — must match [A-Za-z_][A-Za-z0-9_]*`);

        return { code: 1, descriptors: [] };
    }

    if (options.value === undefined) {
        logger.error("env set requires a value. Usage: cirrus env set <KEY> <VALUE>");

        return { code: 1, descriptors: [] };
    }

    // `.dev.vars` is a line-oriented format and parseDevVars splits on
    // newlines; a value containing CR/LF would corrupt the round-trip and
    // could inject spurious vars. Reject rather than silently mangle.
    if (NEWLINE_PRESENT.test(options.value)) {
        logger.error(`env: value for "${options.key}" contains a newline, which .dev.vars cannot represent`);

        return { code: 1, descriptors: [] };
    }

    const map = loadDevVariables(devVariablesPath);

    map.set(options.key, { key: options.key, quoted: true, value: options.value });
    writeFileSync(devVariablesPath, serializeDevVariables(map), "utf8");
    logger.success(`env: set ${options.key} (${redact(options.value)}) in ${DEV_VARS_FILE}`);

    return { code: 0, descriptors: [] };
};

const runEnvUnset = (context: EnvContext): EnvCommandResult => {
    const { devVariablesPath, logger, options } = context;

    if (!options.key) {
        logger.error("env unset requires a key. Usage: cirrus env unset <KEY>");

        return { code: 1, descriptors: [] };
    }

    const map = loadDevVariables(devVariablesPath);

    if (!map.delete(options.key)) {
        logger.warn(`env: ${options.key} was not set in ${DEV_VARS_FILE}`);

        return { code: 0, descriptors: [] };
    }

    writeFileSync(devVariablesPath, serializeDevVariables(map), "utf8");
    logger.success(`env: unset ${options.key} in ${DEV_VARS_FILE}`);

    return { code: 0, descriptors: [] };
};

const runEnvPush = async (context: EnvContext): Promise<EnvCommandResult> => {
    const { devVariablesPath, logger, options } = context;

    if (!options.yes) {
        logger.error("env push uploads secrets to Cloudflare. Re-run with --yes to confirm.");

        return { code: 1, descriptors: [] };
    }

    const map = loadDevVariables(devVariablesPath);

    if (map.size === 0) {
        logger.warn(`${DEV_VARS_FILE}: nothing to push (empty)`);

        return { code: 0, descriptors: [] };
    }

    const spawner = options.spawner ?? defaultSpawner;
    const descriptors: SpawnDescriptor[] = [];

    for (const entry of map.values()) {
        const args: string[] = ["exec", "wrangler", "secret", "put", entry.key];

        if (options.prod) {
            args.push("--env", "production");
        }

        const descriptor: SpawnDescriptor = {
            args,
            command: "pnpm",
            cwd: options.cwd ?? process.cwd(),
            // `wrangler secret put <name>` reads the value from stdin. We
            // pipe it through the spawner's `input` channel so the secret
            // never lands on the command line, in env, or in shell history.
            input: entry.value,
        };

        descriptors.push(descriptor);
        logger.info(`pushing ${entry.key} -> wrangler secret${options.prod ? " (production)" : ""}`);

        // eslint-disable-next-line no-await-in-loop -- secrets push sequentially so a failure aborts.
        const result = await spawner(descriptor);

        if (result.code !== 0) {
            logger.error(`env push: failed at ${entry.key} (exit ${String(result.code)})`);

            return { code: result.code, descriptors };
        }
    }

    logger.success(`env: pushed ${String(map.size)} secret(s)`);

    return { code: 0, descriptors };
};

const runEnvCommand = async (options: EnvCommandOptions): Promise<EnvCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const context: EnvContext = {
        devVariablesPath: join(cwd, DEV_VARS_FILE),
        logger: options.logger,
        options,
    };

    switch (options.subcommand) {
        case "get": {
            return runEnvGet(context);
        }
        case "list": {
            return runEnvList(context);
        }
        case "push": {
            return runEnvPush(context);
        }
        case "set": {
            return runEnvSet(context);
        }
        case "unset": {
            return runEnvUnset(context);
        }
        default: {
            options.logger.error(`env: unknown subcommand "${options.subcommand as string}"`);

            return { code: 1, descriptors: [] };
        }
    }
};

export type { EnvCommandOptions, EnvCommandResult, EnvSubcommand };
export { runEnvCommand };
