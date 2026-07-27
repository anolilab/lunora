import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { WranglerConfig } from "@lunora/config";
import {
    DEV_VARS_FILE,
    discoverSchemaInfo,
    findWranglerFile,
    inferLunoraBindings,
    isPlaceholderValue,
    parseDevVariableEntries,
    readWranglerJsonc,
    validateWranglerConfig,
} from "@lunora/config";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { createMetadataIndexArgs, metadataTypeFor } from "../../util/vectorize-metadata";
import type { DoctorOptions } from "./index";

/** Severity of a single doctor check. `fail` drives a non-zero exit; `warn`/`info`/`pass` don't. */
type FindingLevel = "fail" | "info" | "pass" | "warn";

interface Finding {
    /** Optional remediation hint printed under a non-pass finding. */
    fix?: string;
    level: FindingLevel;
    /** Short, single-line summary shown in the report. */
    message: string;
}

interface DoctorResult {
    /** Process exit code: 1 when any finding is `fail`, else 0. */
    code: number;
    findings: ReadonlyArray<Finding>;
}

interface RunDoctorOptions {
    cwd?: string;
    logger: Logger;
}

/** Keys whose name looks like a secret — same heuristic the dev-vars scaffolder uses. */
const SECRET_KEY_PATTERN = /(?:KEY|PASSWORD|SECRET|TOKEN)$/u;

/** A D1 `database_id` placeholder that still needs `wrangler d1 create` run. */
const isD1PlaceholderId = (databaseId: string): boolean => {
    const value = databaseId.trim();

    if (value === "") {
        return true;
    }

    const lower = value.toLowerCase();

    return lower.includes("replace") || (lower.startsWith("<") && lower.endsWith(">"));
};

/**
 * Read + parse the wrangler config for the project, or `undefined` when absent
 * or unparseable. The doctor surfaces those two cases distinctly, so the caller
 * inspects `path` independently.
 */
const readWrangler = (cwd: string): { parsed: WranglerConfig | undefined; path: string | undefined } => {
    const path = findWranglerFile(cwd);

    if (path === undefined) {
        return { parsed: undefined, path: undefined };
    }

    const { parsed } = readWranglerJsonc<WranglerConfig>(path);

    return { parsed, path };
};

/** Check `wrangler.jsonc` is present and declares the SHARD DO binding (via the shared config validator). */
const checkWrangler = (parsed: WranglerConfig | undefined, path: string | undefined, findings: Finding[]): void => {
    if (path === undefined) {
        findings.push({
            fix: "Run `lunora init` (or `lunora dev`) to scaffold and reconcile wrangler.jsonc.",
            level: "fail",
            message: "wrangler.jsonc not found.",
        });

        return;
    }

    if (parsed === undefined) {
        findings.push({ fix: `Check ${path} is valid JSONC.`, level: "fail", message: `Could not parse ${path}.` });

        return;
    }

    const report = validateWranglerConfig(parsed);
    const shardError = report.errors.find((error) => error.includes("SHARD"));

    if (shardError === undefined) {
        findings.push({ level: "pass", message: "wrangler.jsonc present with a SHARD durable-object binding." });
    } else {
        findings.push({ fix: "Run `lunora dev` to auto-reconcile, or add the binding manually.", level: "fail", message: shardError });
    }
};

/**
 * A `.vectorize({ metadata })` declaration without its Vectorize metadata index
 * → WARN.
 *
 * Cloudflare only filters on a metadata property that has been indexed, and a
 * missing index is silent: `filter` simply matches nothing. `lunora deploy`
 * provisions them, so this exists for the case where someone deploys with
 * wrangler directly — and to name the exact command.
 */
const checkVectorMetadataIndexes = (cwd: string, findings: Finding[]): void => {
    const { info } = discoverSchemaInfo(cwd, "lunora");

    for (const declaration of info?.vectorMetadata ?? []) {
        const type = metadataTypeFor(declaration.kind);

        if (type === undefined) {
            findings.push({
                fix: "Filter on a string, number or boolean column, or drop it from `metadata`.",
                level: "warn",
                message: `vector index "${declaration.index}" declares metadata "${declaration.property}", whose type Vectorize cannot filter on.`,
            });

            continue;
        }

        findings.push({
            fix: `wrangler ${createMetadataIndexArgs({ index: declaration.index, property: declaration.property, type }).join(" ")}`,
            level: "info",
            message: `vector index "${declaration.index}" filters on metadata "${declaration.property}" — that needs a Vectorize metadata index (\`lunora deploy\` creates it).`,
        });
    }
};

/** Any D1 `database_id` still a placeholder → FAIL (the binding can't resolve). */
const checkD1Placeholders = (parsed: WranglerConfig | undefined, findings: Finding[]): void => {
    if (parsed === undefined) {
        return;
    }

    const databases = ((parsed as { d1_databases?: ReadonlyArray<{ binding?: string; database_id?: string }> }).d1_databases ?? []).filter(Boolean);

    for (const database of databases) {
        const databaseId = typeof database.database_id === "string" ? database.database_id : "";

        if (isD1PlaceholderId(databaseId)) {
            const label = typeof database.binding === "string" && database.binding.length > 0 ? database.binding : "<unnamed>";

            findings.push({
                fix: "Run `wrangler d1 create <name>` and paste the returned database_id into wrangler.jsonc.",
                level: "fail",
                message: `D1 binding "${label}" has a placeholder database_id ("${databaseId || "<empty>"}").`,
            });
        }
    }
};

/** A `send_email` binding with a placeholder `destination_address` → WARN. */
const checkEmailDestination = (parsed: WranglerConfig | undefined, findings: Finding[]): void => {
    if (parsed === undefined) {
        return;
    }

    const bindings = ((parsed as { send_email?: ReadonlyArray<{ destination_address?: string; name?: string }> }).send_email ?? []).filter(Boolean);

    for (const binding of bindings) {
        const destination = typeof binding.destination_address === "string" ? binding.destination_address : "";

        if (destination !== "" && isPlaceholderValue(destination)) {
            const label = typeof binding.name === "string" && binding.name.length > 0 ? binding.name : "send_email";

            findings.push({
                fix: "Set destination_address to a verified Cloudflare Email Routing address.",
                level: "warn",
                message: `send_email binding "${label}" has a placeholder destination_address ("${destination}").`,
            });
        }
    }
};

/** `.dev.vars` secret-looking keys whose values are still placeholders → WARN. */
const checkDevVariables = (cwd: string, findings: Finding[]): void => {
    const devVariablesPath = join(cwd, DEV_VARS_FILE);

    if (!existsSync(devVariablesPath)) {
        return;
    }

    let content: string;

    try {
        content = readFileSync(devVariablesPath, "utf8");
    } catch {
        return;
    }

    const unfilled = parseDevVariableEntries(content)
        .filter((entry) => SECRET_KEY_PATTERN.test(entry.key) && isPlaceholderValue(entry.value))
        .map((entry) => entry.key);

    if (unfilled.length > 0) {
        findings.push({
            fix: "Run `lunora dev` to auto-generate secrets, or fill them in by hand.",
            level: "warn",
            message: `${DEV_VARS_FILE} has unfilled secret value(s): ${unfilled.join(", ")}.`,
        });
    }
};

/** `LUNORA_ADMIN_TOKEN` not set → INFO (studio/admin RPCs need it, but it's optional locally). */
const checkAdminToken = (findings: Finding[]): void => {
    const token = process.env.LUNORA_ADMIN_TOKEN;

    if (token === undefined || token.trim() === "") {
        findings.push({
            fix: "Set LUNORA_ADMIN_TOKEN (env or `.dev.vars`) to enable admin RPCs / studio.",
            level: "info",
            message: "LUNORA_ADMIN_TOKEN is not set.",
        });
    } else {
        findings.push({ level: "pass", message: "LUNORA_ADMIN_TOKEN is set." });
    }
};

/**
 * Each declared container must be exported by the worker entry — wrangler
 * rejects a `containers[].class_name` the worker doesn't export. Inference
 * already computes the export status, so surface it proactively here (the
 * generator auto-wires it, but a hand-declared container or an unrecognized
 * entry can still miss it). Skips cleanly when no containers are declared.
 */
const checkContainers = async (cwd: string, findings: Finding[]): Promise<void> => {
    let containers: Awaited<ReturnType<typeof inferLunoraBindings>>["containers"];

    try {
        ({ containers } = await inferLunoraBindings({ projectRoot: cwd }));
    } catch {
        return; // inference is best-effort; other checks own the real failures.
    }

    for (const container of containers) {
        if (container.exported) {
            findings.push({ level: "pass", message: `container "${container.exportName}" is exported by the worker entry.` });
        } else {
            findings.push({
                fix: 'Add `export * from "./lunora/_generated/containers"` to your worker entry (or re-run `vis generate lunora-container`).',
                level: "fail",
                message: `container "${container.exportName}" is declared but ${container.className} is not exported by the worker entry.`,
            });
        }
    }
};

/** A parsed `1.0.0-alpha.31`-style Lunora version. `channel` is `""` for a stable release. */
interface LunoraVersion {
    channel: string;
    /** `major.minor.patch`. */
    core: string;
    /** The pre-release counter (`31`), or `undefined` for a stable release. */
    counter: number | undefined;
    raw: string;
}

/** Leading range operators (`^`, `~`, `>=`, …) stripped before parsing. */
const VERSION_RANGE_PREFIX = /^[\^~><= ]+/u;

/** `major.minor.patch` with an optional `-channel.counter` pre-release tail. */
const LUNORA_VERSION_PATTERN = /^(?<core>\d+\.\d+\.\d+)(?:-(?<channel>[a-z]+)\.(?<counter>\d+))?$/u;

/** Strip a range prefix (`^`, `~`, `>=`) and parse. Returns `undefined` for a non-pinnable spec (`workspace:*`, a URL, `*`). */
const parseLunoraVersion = (spec: string): LunoraVersion | undefined => {
    const cleaned = spec.replace(VERSION_RANGE_PREFIX, "").trim();
    const match = LUNORA_VERSION_PATTERN.exec(cleaned);

    if (!match?.groups) {
        return undefined;
    }

    const { channel, core, counter } = match.groups;

    return {
        channel: channel ?? "",
        core: core ?? "",
        counter: counter === undefined ? undefined : Number.parseInt(counter, 10),
        raw: cleaned,
    };
};

/**
 * Flag an incoherent set of `@lunora/*` versions.
 *
 * Lunora publishes every package independently, so an app's manifest holds a set of
 * unrelated-looking versions (`lunorash@1.0.0-alpha.98`, `@lunora/react@…alpha.31`,
 * `@lunora/db@…alpha.27`) and **nothing tells the adopter which combination is
 * coherent**. During an alpha the packages move together; a set spanning several
 * release waves usually means a partial `pnpm update`, and the resulting bug looks
 * like a framework bug.
 *
 * The check is deliberately conservative — it can't know the real compatibility
 * matrix, so it only warns, and only on the two signals that are unambiguous: mixed
 * major.minor.patch cores, or mixed pre-release channels. Same-channel counter drift
 * is normal and is reported as INFO with the spread, so a reader can judge it.
 */
const checkVersionSkew = (cwd: string, findings: Finding[]): void => {
    const manifestPath = join(cwd, "package.json");

    if (!existsSync(manifestPath)) {
        return;
    }

    let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
    } catch {
        return; // A malformed manifest is another check's problem.
    }

    const specs = { ...manifest.devDependencies, ...manifest.dependencies };
    const parsed: { name: string; version: LunoraVersion }[] = [];

    for (const [name, spec] of Object.entries(specs)) {
        if (name !== "lunorash" && !name.startsWith("@lunora/")) {
            continue;
        }

        const version = parseLunoraVersion(spec);

        if (version) {
            parsed.push({ name, version });
        }
    }

    if (parsed.length < 2) {
        return;
    }

    const describe = (entries: typeof parsed): string => entries.map((entry) => `${entry.name}@${entry.version.raw}`).join(", ");
    const cores = new Set(parsed.map((entry) => entry.version.core));
    const channels = new Set(parsed.map((entry) => entry.version.channel));

    if (cores.size > 1) {
        findings.push({
            fix: 'Run `pnpm update "@lunora/*" lunorash` (or `npm`/`yarn` equivalent) so every Lunora package moves to the same release.',
            level: "warn",
            message: `Lunora packages span ${String(cores.size)} different versions: ${describe(parsed)}.`,
        });

        return;
    }

    if (channels.size > 1) {
        findings.push({
            fix: "Pick one channel (all stable, or all alpha/beta) and update the odd package out.",
            level: "warn",
            message: `Lunora packages mix release channels (${[...channels].map((channel) => (channel === "" ? "stable" : channel)).join(" + ")}): ${describe(parsed)}.`,
        });

        return;
    }

    const counters = parsed.map((entry) => entry.version.counter).filter((counter): counter is number => counter !== undefined);

    if (counters.length > 1) {
        const lowest = Math.min(...counters);
        const highest = Math.max(...counters);

        // Independent per-package versioning makes counter drift the norm, not a
        // defect — so this is INFO with the spread, not a warning. It's still the
        // number to check first when behavior disagrees with the docs.
        findings.push({
            level: "info",
            message:
                counters.length === parsed.length && lowest === highest
                    ? `Lunora packages are all at ${[...channels][0] ?? ""}.${String(highest)}.`
                    : `Lunora pre-release counters span ${String(lowest)}–${String(highest)}: ${describe(parsed)}.`,
        });
    }
};

/**
 * Pure, testable preflight core: run the read-only project checks against `cwd`
 * and return the aggregated findings + the exit code (1 if any hard FAIL). Does
 * no printing — the `execute` wrapper renders the report. Each check skips
 * gracefully when its input isn't present.
 */
const runDoctor = async (options: RunDoctorOptions): Promise<DoctorResult> => {
    const cwd = options.cwd ?? process.cwd();
    const findings: Finding[] = [];

    const { parsed, path } = readWrangler(cwd);

    checkWrangler(parsed, path, findings);
    checkD1Placeholders(parsed, findings);
    checkEmailDestination(parsed, findings);
    checkDevVariables(cwd, findings);
    checkAdminToken(findings);
    checkVersionSkew(cwd, findings);
    checkVectorMetadataIndexes(cwd, findings);
    await checkContainers(cwd, findings);

    const code = findings.some((finding) => finding.level === "fail") ? 1 : 0;

    return { code, findings };
};

const LEVEL_LABEL: Record<FindingLevel, string> = { fail: "FAIL", info: "INFO", pass: "PASS", warn: "WARN" };

/** Print the doctor report, then a one-line summary; routes FAIL→error, WARN→warn, else info. */
const renderReport = (result: DoctorResult, logger: Logger): void => {
    logger.info("lunora doctor — project preflight");

    for (const finding of result.findings) {
        const line = `[${LEVEL_LABEL[finding.level]}] ${finding.message}`;

        if (finding.level === "fail") {
            logger.error(line);
        } else if (finding.level === "warn") {
            logger.warn(line);
        } else {
            logger.info(line);
        }

        if (finding.fix !== undefined && finding.level !== "pass") {
            logger.info(`       fix: ${finding.fix}`);
        }
    }

    const fails = result.findings.filter((finding) => finding.level === "fail").length;
    const warns = result.findings.filter((finding) => finding.level === "warn").length;

    if (fails > 0) {
        logger.error(`${String(fails)} failure(s), ${String(warns)} warning(s).`);
    } else if (warns > 0) {
        logger.warn(`0 failures, ${String(warns)} warning(s).`);
    } else {
        logger.success("all checks passed.");
    }
};

/** `lunora doctor` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<DoctorOptions> = defineHandler<DoctorOptions>(async ({ cwd, logger }) => {
    const result = await runDoctor({ cwd, logger });

    renderReport(result, logger);

    return { code: result.code };
});

export { execute, runDoctor };
export type { DoctorResult, Finding, FindingLevel, RunDoctorOptions };
