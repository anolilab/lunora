import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { DEV_VARS_FILE, discoverSchemaInfo, inferLunoraBindings, isPlaceholderValue, parseDevVariableEntries } from "@lunora/config";
import type { WranglerConfig } from "@lunora/config/cloudflare";
import { collectExportGaps, findWranglerFile, readWranglerJsonc, validateWranglerConfig } from "@lunora/config/cloudflare";

import { isSecretKeyName } from "../../../../../shared/secret-key";
import { describeAdminTokenSource, resolveAdminBearer } from "../../util/admin-token";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { isJsonFormat, loggerForFormat, printJson, validateOutputFormat } from "../../util/output-format";
import isInsideDirectory from "../../util/path-containment";
import { createMetadataIndexArgs, metadataTypeFor } from "../../util/vectorize-metadata";
import type { DoctorOptions } from "./index";

/** Severity of a single doctor check. `fail` drives a non-zero exit; `warn`/`info`/`pass` don't. */
type FindingLevel = "fail" | "info" | "pass" | "warn";

/**
 * Every diagnostic code `lunora doctor` can emit, sorted.
 *
 * The codes — not the English messages — are the contract behind `--format
 * json`: an agent or CI job branches on `finding.code`, so a copy-edit to a
 * message must never rename a diagnostic. Adding, renaming or removing an entry
 * here is a public-API change; the docs table in `packages/cli/docs/index.mdx`
 * is asserted against this list, so the two cannot drift.
 */
const DOCTOR_CODES = [
    "admin-token-missing",
    "admin-token-set",
    "cli-shadowed",
    "d1-placeholder-id",
    "declared-export-missing",
    "declared-export-ok",
    "dev-vars-missing-secret",
    "email-destination-placeholder",
    "vector-metadata-index-required",
    "vector-metadata-unfilterable",
    "version-counter-spread",
    "version-skew-channels",
    "version-skew-cores",
    "wrangler-missing",
    "wrangler-shard-binding-missing",
    "wrangler-shard-binding-ok",
    "wrangler-unparseable",
] as const;

/** A stable identifier for one doctor diagnostic. See {@link DOCTOR_CODES}. */
type DoctorCode = (typeof DOCTOR_CODES)[number];

interface Finding {
    /** Stable machine-readable identifier for this diagnostic. */
    code: DoctorCode;
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
    /** `true` when nothing failed — redundant with `code`, and the field a shell-free consumer reaches for first. */
    ok: boolean;
    /** Finding count per level. */
    summary: Record<FindingLevel, number>;
}

interface RunDoctorOptions {
    cwd?: string;

    /**
     * Path of the running `lunora` executable (defaults to `process.argv[1]`).
     * Overridable so the CLI-shadow check is testable without re-launching the
     * process, the same seam `cwd` provides for the filesystem checks.
     */
    executablePath?: string;
    logger: Logger;
}

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
            code: "wrangler-missing",
            fix: "Run `lunora init` (or `lunora dev`) to scaffold and reconcile wrangler.jsonc.",
            level: "fail",
            message: "wrangler.jsonc not found.",
        });

        return;
    }

    if (parsed === undefined) {
        findings.push({ code: "wrangler-unparseable", fix: `Check ${path} is valid JSONC.`, level: "fail", message: `Could not parse ${path}.` });

        return;
    }

    const report = validateWranglerConfig(parsed);
    const shardError = report.errors.find((error) => error.includes("SHARD"));

    if (shardError === undefined) {
        findings.push({ code: "wrangler-shard-binding-ok", level: "pass", message: "wrangler.jsonc present with a SHARD durable-object binding." });
    } else {
        findings.push({
            code: "wrangler-shard-binding-missing",
            fix: "Run `lunora dev` to auto-reconcile, or add the binding manually.",
            level: "fail",
            message: shardError,
        });
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
                code: "vector-metadata-unfilterable",
                fix: "Filter on a string, number or boolean column, or drop it from `metadata`.",
                level: "warn",
                message: `vector index "${declaration.index}" declares metadata "${declaration.property}", whose type Vectorize cannot filter on.`,
            });

            continue;
        }

        findings.push({
            code: "vector-metadata-index-required",
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
                code: "d1-placeholder-id",
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
                code: "email-destination-placeholder",
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
        .filter((entry) => isSecretKeyName(entry.key) && isPlaceholderValue(entry.value))
        .map((entry) => entry.key);

    if (unfilled.length > 0) {
        findings.push({
            code: "dev-vars-missing-secret",
            fix: "Run `lunora dev` to auto-generate secrets, or fill them in by hand.",
            level: "warn",
            message: `${DEV_VARS_FILE} has unfilled secret value(s): ${unfilled.join(", ")}.`,
        });
    }
};

/**
 * No admin bearer resolvable → INFO (studio/admin RPCs need it, but it's
 * optional locally).
 *
 * Resolved through {@link resolveAdminBearer}, the same resolver every admin
 * command uses, so `.dev.vars` counts. Reading only the environment reported
 * `LUNORA_ADMIN_TOKEN is not set` on every `lunora dev`-scaffolded project —
 * `lunora dev` writes the token into `.dev.vars` and never exports it — while
 * this check's own fix text already said "(env or `.dev.vars`)".
 */
const checkAdminToken = (cwd: string, findings: Finding[]): void => {
    const { source } = resolveAdminBearer({ cwd });

    if (source === undefined) {
        findings.push({
            code: "admin-token-missing",
            fix: "Set LUNORA_ADMIN_TOKEN (env or `.dev.vars`) to enable admin RPCs / studio.",
            level: "info",
            message: "LUNORA_ADMIN_TOKEN is not set.",
        });
    } else {
        findings.push({ code: "admin-token-set", level: "pass", message: `LUNORA_ADMIN_TOKEN is set (${describeAdminTokenSource(source)}).` });
    }
};

/**
 * Every declared container, workflow and agent must be exported by the worker
 * entry — wrangler rejects a `class_name` the worker doesn't export, so the
 * failure lands at deploy, on a project where `tsc`, codegen and the tests are
 * all green. Inference already computes the status for all three kinds; this
 * surfaces it proactively (the generators auto-wire it, but a hand-declared
 * entry can still miss it). Skips cleanly when nothing is declared.
 *
 * Containers used to be the only kind checked here, which made the omission
 * invisible: a project could pass `doctor` and still deploy three workflows with
 * no workflow to run. `collectExportGaps` covers all three from one place, so a
 * fourth kind cannot be added to inference and silently skipped here.
 */
const checkDeclaredExports = async (cwd: string, findings: Finding[]): Promise<void> => {
    let inferred: Awaited<ReturnType<typeof inferLunoraBindings>>;

    try {
        inferred = await inferLunoraBindings({ projectRoot: cwd });
    } catch {
        return; // inference is best-effort; other checks own the real failures.
    }

    const gaps = collectExportGaps(inferred);
    const declared = [
        ...inferred.containers.map((entry) => {
            return { ...entry, kind: "container" };
        }),
        ...inferred.workflows.map((entry) => {
            return { ...entry, kind: "workflow" };
        }),
        ...inferred.agents.map((entry) => {
            return { ...entry, kind: "agent" };
        }),
    ];

    for (const entry of declared.filter((candidate) => candidate.exported)) {
        findings.push({ code: "declared-export-ok", level: "pass", message: `${entry.kind} "${entry.exportName}" is exported by the worker entry.` });
    }

    for (const gap of gaps) {
        findings.push({
            code: "declared-export-missing",
            fix: `Add \`export * from "./lunora/_generated/${gap.module}"\` to your worker entry (or re-run \`vis generate lunora-${gap.kind}\`).`,
            level: "fail",
            message: `${gap.kind} "${gap.exportName}" is declared but ${gap.className} is not exported by the worker entry.`,
        });
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
            code: "version-skew-cores",
            fix: 'Run `pnpm update "@lunora/*" lunorash` (or `npm`/`yarn` equivalent) so every Lunora package moves to the same release.',
            level: "warn",
            message: `Lunora packages span ${String(cores.size)} different versions: ${describe(parsed)}.`,
        });

        return;
    }

    if (channels.size > 1) {
        findings.push({
            code: "version-skew-channels",
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
            code: "version-counter-spread",
            level: "info",
            message:
                counters.length === parsed.length && lowest === highest
                    ? `Lunora packages are all at ${[...channels][0] ?? ""}.${String(highest)}.`
                    : `Lunora pre-release counters span ${String(lowest)}–${String(highest)}: ${describe(parsed)}.`,
        });
    }
};

/** The two packages that can install a project-local `lunora` binary. */
const LOCAL_CLI_PACKAGES = [join("@lunora", "cli"), "lunorash"];

/**
 * A `lunora` from somewhere other than the project's own install → WARN.
 *
 * A globally-installed binary shadowing the project's pinned one produces a
 * report about a project the running CLI may be the wrong version for, and no
 * other check can see it: `checkVersionSkew` reads the manifest, which is
 * exactly the file the shadowing binary is ignoring.
 *
 * The comparison is *containment* — is the running module inside the project's
 * installed CLI package? — rather than a path equality against
 * `node_modules/.bin/lunora`. pnpm writes that bin as a shell shim, not a
 * symlink, so its `realpath` is the shim itself and never equals the running
 * `dist/bin.mjs`; equality would warn on every pnpm project. Containment holds
 * for pnpm's symlinked package dirs, npm/yarn's hoisted ones, and a launch
 * through the bin shim alike.
 */
const checkCliShadow = (cwd: string, executablePath: string | undefined, findings: Finding[]): void => {
    if (executablePath === undefined) {
        return;
    }

    const roots: string[] = [];

    for (const packageName of LOCAL_CLI_PACKAGES) {
        const packagePath = join(cwd, "node_modules", packageName);

        if (!existsSync(packagePath)) {
            continue;
        }

        try {
            roots.push(realpathSync(packagePath));
        } catch {
            // A dangling link is an install problem, not a shadowing one.
        }
    }

    if (roots.length === 0) {
        return; // No project-local install: a global-only project, not a defect.
    }

    let running: string;

    try {
        running = realpathSync(executablePath);
    } catch {
        return;
    }

    if (roots.some((root) => isInsideDirectory(root, running))) {
        return;
    }

    findings.push({
        code: "cli-shadowed",
        fix: "Run the project's own CLI: `pnpm exec lunora …` (or `npx lunora …`).",
        level: "warn",
        message: `the running lunora (${running}) is not the project's own install (${roots.join(", ")}).`,
    });
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
    checkAdminToken(cwd, findings);
    checkVersionSkew(cwd, findings);
    checkVectorMetadataIndexes(cwd, findings);
    checkCliShadow(cwd, options.executablePath ?? process.argv[1], findings);
    await checkDeclaredExports(cwd, findings);

    const summary: Record<FindingLevel, number> = { fail: 0, info: 0, pass: 0, warn: 0 };

    for (const finding of findings) {
        summary[finding.level] += 1;
    }

    const code = summary.fail > 0 ? 1 : 0;

    return { code, findings, ok: code === 0, summary };
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

    const { fail: fails, warn: warns } = result.summary;

    if (fails > 0) {
        logger.error(`${String(fails)} failure(s), ${String(warns)} warning(s).`);
    } else if (warns > 0) {
        logger.warn(`0 failures, ${String(warns)} warning(s).`);
    } else {
        logger.success("all checks passed.");
    }
};

interface DoctorCommandOptions extends RunDoctorOptions {
    /** Output format: `pretty` (default) or `json`. */
    format?: string;
}

/**
 * Run the preflight and emit it in the requested format. `pretty` prints the
 * human report exactly as before; `json` routes that same report to stderr (via
 * {@link loggerForFormat}) and puts a single {@link DoctorResult} document on
 * stdout, so `lunora doctor --format json | …` stays pipeable. The exit code is
 * the same in both formats.
 */
const runDoctorCommand = async (options: DoctorCommandOptions): Promise<DoctorResult> => {
    const formatError = validateOutputFormat("doctor", options.format);

    if (formatError !== undefined) {
        options.logger.error(formatError);

        return { code: 1, findings: [], ok: false, summary: { fail: 0, info: 0, pass: 0, warn: 0 } };
    }

    const logger = loggerForFormat(options.format, options.logger);
    const result = await runDoctor({ ...options, logger });

    renderReport(result, logger);

    if (isJsonFormat(options.format)) {
        printJson(result);
    }

    return result;
};

/** `lunora doctor` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<DoctorOptions> = defineHandler<DoctorOptions>(async ({ cwd, logger, options }) => {
    const result = await runDoctorCommand({ cwd, format: options.format, logger });

    return { code: result.code };
});

export { DOCTOR_CODES, execute, runDoctor, runDoctorCommand };
export type { DoctorCode, DoctorCommandOptions, DoctorResult, Finding, FindingLevel, RunDoctorOptions };
