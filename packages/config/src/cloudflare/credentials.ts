/**
 * Whether wrangler could authenticate to Cloudflare without a prompt.
 *
 * Dev needs this for one decision: a Workers AI binding has no local emulation,
 * so `wrangler dev` and the Cloudflare Vite plugin open a remote proxy session for
 * it at boot, and without credentials that kills the whole dev server (or, in a
 * TTY, stops it on a browser login). See `withheldWorkersAi`.
 *
 * Wrangler has no public auth API, so this mirrors where it looks: the process
 * environment, the project's `.env` files (wrangler loads those into the
 * environment before it authenticates), then its global config directory, where
 * `wrangler login` leaves a `config/<profile>.toml` (or `.enc` when the key lives
 * in the OS keychain). The check is deliberately one-sided: anything found counts
 * as logged in, and every candidate directory wrangler might resolve on any
 * platform is searched. A false "logged in" only keeps today's behaviour; a false
 * "logged out" would switch Workers AI off for a user who has it.
 *
 * A login file alone can be stale (a keychain-backed `.enc` whose keyring entry is
 * gone or whose ciphertext is invalid), so when the project has its own wrangler it
 * is asked: `wrangler whoami --json` prints `{"loggedIn":false}` from local state
 * alone, before any network call. Only that exact answer counts as logged out;
 * being offline, a timeout, or a missing wrangler all still count as logged in.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import join from "../path";

/** Inputs, injectable so tests never read the real home directory or env. */
interface CloudflareCredentialProbe {
    env?: Record<string, string | undefined>;
    home?: string;
    /** Project whose `.env` files are read; omit to skip them. */
    projectRoot?: string;
}

/** The `.env` files wrangler loads in dev. */
const DOTENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local"] as const;

const TOKEN_KEYS = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"] as const;
const GLOBAL_KEY_KEYS = ["CLOUDFLARE_API_KEY", "CF_API_KEY"] as const;
const EMAIL_KEYS = ["CLOUDFLARE_EMAIL", "CF_EMAIL"] as const;

const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([...TOKEN_KEYS, ...GLOBAL_KEY_KEYS, ...EMAIL_KEYS]);

/** A leading `export ` on a `.env` line. */
const EXPORT_PREFIX = /^export\s+/u;

/** A `.env` file's line break. */
const LINE_BREAK = /\r?\n/u;

/** What `wrangler whoami --json` prints when no usable login exists. */
const LOGGED_OUT = /"loggedIn"\s*:\s*false/u;

/** How long a "logged out" answer is reused, so the workers of one dev start ask once. */
const LOGGED_OUT_TTL_MS = 10_000;

/** Per project, the last answer from `wrangler whoami`. */
const answers = new Map<string, { at: number; loggedOut: boolean }>();

/** A value wrapped in matching single or double quotes. */
const QUOTED_VALUE = /^(["'])(.*)\1$/u;

const isSet = (value: string | undefined): boolean => value !== undefined && value.trim() !== "";

/**
 * Every base directory wrangler's bundled `xdg-app-paths` can put `.wrangler`
 * under: the legacy home directory, `XDG_CONFIG_HOME`, and the per-platform
 * defaults for macOS, Linux and Windows.
 */
const wranglerConfigBases = (env: Record<string, string | undefined>, home: string): string[] =>
    [
        home,
        env["XDG_CONFIG_HOME"],
        join(home, "Library", "Preferences"),
        join(home, ".config"),
        env["APPDATA"] === undefined ? undefined : join(env["APPDATA"], "xdg.config"),
        join(home, "AppData", "Roaming", "xdg.config"),
    ].filter((base): base is string => isSet(base));

const hasEntries = (directory: string): boolean => {
    try {
        return readdirSync(directory).length > 0;
    } catch {
        return false;
    }
};

/** The wrangler entry script the project installed, found the way node resolves a package: nearest `node_modules` upwards. */
const findWrangler = (projectRoot: string): string | undefined => {
    for (let directory = projectRoot; ; directory = dirname(directory)) {
        const script = join(directory, "node_modules", "wrangler", "bin", "wrangler.js");

        if (existsSync(script)) {
            return script;
        }

        if (dirname(directory) === directory) {
            return undefined;
        }
    }
};

/**
 * Whether the project's own wrangler says its on-disk login is unusable. Everything
 * short of that exact answer (no wrangler installed, a timeout, no network) is
 * `false`, so this can only ever switch Workers AI off for a login that is dead.
 * Every answer from a wrangler that ran is remembered, so the probe costs at most
 * one timeout per process rather than one per caller: a working login or a silent
 * one (fail-open, treated as working) for the process, a dead one for a few
 * seconds, so a fresh `wrangler login` is picked up without restarting.
 */
const wranglerSaysLoggedOut = (projectRoot: string, env: Record<string, string | undefined>): boolean => {
    const known = answers.get(projectRoot);

    if (known !== undefined && (!known.loggedOut || Date.now() - known.at < LOGGED_OUT_TTL_MS)) {
        return known.loggedOut;
    }

    const script = findWrangler(projectRoot);

    if (script === undefined) {
        return false;
    }

    const { stdout } = spawnSync(process.execPath, [script, "whoami", "--json"], {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...env, WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
    });
    const loggedOut = LOGGED_OUT.test(stdout);

    // A silent probe (timeout, offline) matches neither pattern: remember it as
    // logged in, or every caller re-pays the timeout.
    answers.set(projectRoot, { at: Date.now(), loggedOut });

    return loggedOut;
};

/**
 * The credential variables that a `.env` file sets to a non-empty value. A plain
 * `KEY=value` reader: an optional `export ` prefix and surrounding quotes are
 * stripped, and comments and blank lines are skipped. An unreadable file counts as
 * empty.
 */
const dotenvCredentialKeys = (projectRoot: string): Set<string> => {
    const keys = new Set<string>();

    for (const file of DOTENV_FILES) {
        let text: string;

        try {
            text = readFileSync(join(projectRoot, file), "utf8");
        } catch {
            continue;
        }

        for (const raw of text.split(LINE_BREAK)) {
            const line = raw.trim().replace(EXPORT_PREFIX, "");
            const equals = line.indexOf("=");

            if (line.startsWith("#") || equals === -1) {
                continue;
            }

            const key = line.slice(0, equals).trim();
            const value = line
                .slice(equals + 1)
                .trim()
                .replace(QUOTED_VALUE, "$2");

            if (CREDENTIAL_KEYS.has(key) && isSet(value)) {
                keys.add(key);
            }
        }
    }

    return keys;
};

const hasCloudflareCredentials = (probe: CloudflareCredentialProbe = {}): boolean => {
    const env = probe.env ?? process.env;
    const fromDotenv = probe.projectRoot === undefined ? new Set<string>() : dotenvCredentialKeys(probe.projectRoot);
    const isSetSomewhere = (key: string): boolean => isSet(env[key]) || fromDotenv.has(key);

    // A token is enough. A global API key only works with the email it belongs to.
    if (
        TOKEN_KEYS.some((key) => isSetSomewhere(key)) ||
        (GLOBAL_KEY_KEYS.some((key) => isSetSomewhere(key)) && EMAIL_KEYS.some((key) => isSetSomewhere(key)))
    ) {
        return true;
    }

    const hasLoginFile = wranglerConfigBases(env, probe.home ?? homedir()).some((base) => hasEntries(join(base, ".wrangler", "config")));

    return hasLoginFile && (probe.projectRoot === undefined || !wranglerSaysLoggedOut(probe.projectRoot, env));
};

export type { CloudflareCredentialProbe };
export { hasCloudflareCredentials };
