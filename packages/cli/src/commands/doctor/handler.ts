import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { WranglerConfig } from "@cirrus/config";
import { DEV_VARS_FILE, findWranglerFile, isPlaceholderValue, parseDevVariableEntries, readWranglerJsonc, validateWranglerConfig } from "@cirrus/config";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
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
            fix: "Run `cirrus init` (or `cirrus dev`) to scaffold and reconcile wrangler.jsonc.",
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
        findings.push({ fix: "Run `cirrus dev` to auto-reconcile, or add the binding manually.", level: "fail", message: shardError });
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
            fix: "Run `cirrus dev` to auto-generate secrets, or fill them in by hand.",
            level: "warn",
            message: `${DEV_VARS_FILE} has unfilled secret value(s): ${unfilled.join(", ")}.`,
        });
    }
};

/** `CIRRUS_ADMIN_TOKEN` not set → INFO (studio/admin RPCs need it, but it's optional locally). */
const checkAdminToken = (findings: Finding[]): void => {
    const token = process.env.CIRRUS_ADMIN_TOKEN;

    if (token === undefined || token.trim() === "") {
        findings.push({
            fix: "Set CIRRUS_ADMIN_TOKEN (env or `.dev.vars`) to enable admin RPCs / studio.",
            level: "info",
            message: "CIRRUS_ADMIN_TOKEN is not set.",
        });
    } else {
        findings.push({ level: "pass", message: "CIRRUS_ADMIN_TOKEN is set." });
    }
};

/**
 * Pure, testable preflight core: run the read-only project checks against `cwd`
 * and return the aggregated findings + the exit code (1 if any hard FAIL). Does
 * no printing — the `execute` wrapper renders the report. Each check skips
 * gracefully when its input isn't present.
 */
const runDoctor = (options: RunDoctorOptions): DoctorResult => {
    const cwd = options.cwd ?? process.cwd();
    const findings: Finding[] = [];

    const { parsed, path } = readWrangler(cwd);

    checkWrangler(parsed, path, findings);
    checkD1Placeholders(parsed, findings);
    checkEmailDestination(parsed, findings);
    checkDevVariables(cwd, findings);
    checkAdminToken(findings);

    const code = findings.some((finding) => finding.level === "fail") ? 1 : 0;

    return { code, findings };
};

const LEVEL_LABEL: Record<FindingLevel, string> = { fail: "FAIL", info: "INFO", pass: "PASS", warn: "WARN" };

/** Print the doctor report, then a one-line summary; routes FAIL→error, WARN→warn, else info. */
const renderReport = (result: DoctorResult, logger: Logger): void => {
    logger.info("cirrus doctor — project preflight");

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

/** `cirrus doctor` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<DoctorOptions> = defineHandler<DoctorOptions>(({ cwd, logger }) => {
    const result = runDoctor({ cwd, logger });

    renderReport(result, logger);

    return { code: result.code };
});

export { execute, runDoctor };
export type { DoctorResult, Finding, FindingLevel, RunDoctorOptions };
