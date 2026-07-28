import { existsSync } from "node:fs";
import { join } from "node:path";

import { runCodegen } from "@lunora/codegen";

import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import { renderCodegenHint } from "../../util/codegen-error";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { resolveTargetOrError } from "../../util/deploy-target";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import { isJsonFormat, loggerForFormat, printJson, validateOutputFormat } from "../../util/output-format";
import { runSchemaDriftGate } from "../../util/schema-drift-gate";
import type { Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import { validateWrangler } from "../../util/wrangler-validator";
import type { VerifyOptions } from "./index";

/**
 * Minimal fetch surface the optional health probe needs — a subset of the global
 * `fetch`, injectable so a test can feed a canned response without a network.
 */
type HealthFetch = (url: string) => Promise<{ ok: boolean; status: number }>;

interface VerifyCommandOptions {
    /** Override the schema-drift gate — report breaking drift as a warning instead of an error. */
    allowSchemaDrift?: boolean;
    /** Which API spec(s) codegen would emit. Defaults to codegen's `"openapi"` when omitted. */
    apiSpec?: ApiSpec;
    cwd?: string;
    /** Output format: `pretty` (default) or `json`. */
    format?: string;
    /** Injectable fetch for the health probe; defaults to the global `fetch`. */
    healthFetch?: HealthFetch;

    /**
     * Deployment base URL to probe `/_lunora/health` against. When omitted the
     * health step is skipped entirely, so `verify` stays offline-safe by default.
     */
    healthUrl?: string;

    logger: Logger;
    /** Injectable subprocess runner for the tsc step; defaults to the real spawner. */
    spawner?: Spawner;

    /**
     * Deploy target the drift gate's snapshot is emitted for. Defaults to
     * `"target"` in `lunora.json`, then `"cloudflare"`. Verify never writes, but
     * a snapshot emitted for the wrong target compares against the wrong
     * baseline.
     */
    target?: string;
    /** When false, skip the TypeScript type-check step. Defaults to true. */
    typecheck?: boolean;
}

interface VerifyCommandResult {
    code: number;
    /** Set when the run aborted before validation ran: an invalid `--format`, or an unregistered deploy target. */
    error?: string;
    errors: ReadonlyArray<string>;
    warnings: ReadonlyArray<string>;
    wranglerPath: string | undefined;
}

/**
 * Run `tsc --noEmit` for the project when it ships a `tsconfig.json`. Returns an
 * `{ error }` when type-checking failed, `{ warning }` when it was skipped (no
 * tsconfig), or an empty object on success.
 */
const runTypecheckStep = async (cwd: string, spawner: Spawner): Promise<{ error?: string; warning?: string }> => {
    if (!existsSync(join(cwd, "tsconfig.json"))) {
        return { warning: "no tsconfig.json found — skipping TypeScript type-check" };
    }

    const exec = execArgsFor(detectPackageManager(cwd), "tsc", ["--noEmit", "-p", "tsconfig.json"]);
    const result = await spawner({ args: exec.args, command: exec.command, cwd });

    return result.code === 0 ? {} : { error: `type errors: tsc --noEmit exited ${String(result.code)}` };
};

/** The aggregate health route probed by the optional `--health-url` step. */
const HEALTH_PATH = "/_lunora/health";

/** Join a base URL and the health path without doubling the slash. */
const joinHealthUrl = (base: string): string => (base.endsWith("/") ? base.slice(0, -1) : base) + HEALTH_PATH;

/**
 * Probe a deployment's `GET /_lunora/health` when a `healthUrl` is supplied
 * (opt-in — the step is skipped otherwise, keeping `verify` offline-safe by
 * default). A `2xx` is green; a `503` (a critical dependency down) or any other
 * non-`2xx`, and a transport failure, are red. Returns `{ error }` on red, an
 * empty object on green.
 */
const runHealthProbeStep = async (healthUrl: string, healthFetch: HealthFetch): Promise<{ error?: string }> => {
    const url = joinHealthUrl(healthUrl);

    let response: { ok: boolean; status: number };

    try {
        response = await healthFetch(url);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        return { error: `health probe failed: could not reach ${url} (${message})` };
    }

    if (response.ok) {
        return {};
    }

    return { error: `health probe failed: ${url} returned HTTP ${String(response.status)}` };
};

/**
 * Run the opt-in health probe when a `healthUrl` is supplied, logging a success
 * line on green. Returns the probe error on red, else `undefined`. Kept separate
 * from {@link runVerifyCommand} so its branching doesn't inflate that function's
 * cognitive complexity; the skip (no `healthUrl`) keeps `verify` offline-safe.
 */
const probeHealthIfRequested = async (options: VerifyCommandOptions, logger: Logger): Promise<string | undefined> => {
    if (options.healthUrl === undefined || options.healthUrl === "") {
        return undefined;
    }

    const probe = await runHealthProbeStep(options.healthUrl, options.healthFetch ?? ((url) => fetch(url)));

    if (probe.error === undefined) {
        logger.success(`verify: health probe ok (${joinHealthUrl(options.healthUrl)})`);

        return undefined;
    }

    return probe.error;
};

/** Log the collected errors/warnings and build the command result. */
const reportVerifyResult = (logger: Logger, errors: string[], warnings: string[], wranglerPath: string | undefined): VerifyCommandResult => {
    if (errors.length === 0 && warnings.length === 0) {
        logger.success("verify: project is valid");

        return { code: 0, errors: [], warnings: [], wranglerPath };
    }

    if (warnings.length > 0) {
        logger.warn("verify: warnings:");

        for (const warning of warnings) {
            logger.warn(`  - ${warning}`);
        }
    }

    if (errors.length > 0) {
        logger.error("verify: errors:");

        for (const error of errors) {
            logger.error(`  - ${error}`);

            // Surface the actionable Lunora fix (the same hint the Vite overlay
            // and `lunora dev` show) directly under a recognized codegen error.
            const hint = renderCodegenHint(error);

            if (hint !== undefined) {
                logger.error(hint);
            }
        }

        return { code: 1, errors, warnings, wranglerPath };
    }

    logger.success("verify: project is valid (with warnings)");

    return { code: 0, errors: [], warnings, wranglerPath };
};

/**
 * Validate a Lunora project without mutating any file. First the wrangler
 * config (bindings, compat date, schema-driven D1/Vectorize), then a codegen
 * dry-run that surfaces schema/function parse errors without touching
 * `lunora/_generated/`, then a TypeScript type-check (`tsc --noEmit`) when the
 * project ships a `tsconfig.json`. Exits non-zero if any step reports an error.
 */
const runVerifyCommand = async (options: VerifyCommandOptions): Promise<VerifyCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    // In `--format json` mode every human/progress line goes to stderr so
    // stdout carries only the serialized structured result.
    const logger = loggerForFormat(options.format, options.logger);

    const formatError = validateOutputFormat("verify", options.format);

    if (formatError !== undefined) {
        options.logger.error(formatError);

        return { code: 1, error: formatError, errors: [], warnings: [], wranglerPath: undefined };
    }

    const validation = validateWrangler({ projectRoot: cwd });
    const errors: string[] = [...validation.report.errors];
    const warnings: string[] = [...validation.report.warnings];

    try {
        // `dryRun` keeps `lunora/_generated/` untouched but still returns the
        // current schema snapshot, so the read-only drift gate can run without
        // mutating any file (verify never writes — see `readOnly: true`).
        // Validated even though verify never writes: the drift gate compares a
        // snapshot emitted for this target against the committed baseline, so
        // an unrecognized name silently checks the wrong surface.
        const resolvedTarget = resolveTargetOrError(cwd, options.target);

        if (resolvedTarget.target === undefined) {
            const message = resolvedTarget.error ?? "unknown deploy target";

            logger.error(message);

            return { code: 1, error: message, errors: [message], warnings: [], wranglerPath: undefined };
        }

        const codegen = runCodegen({ apiSpec: options.apiSpec, dryRun: true, projectRoot: cwd, target: resolvedTarget.target });
        const gate = runSchemaDriftGate({ allowDrift: options.allowSchemaDrift === true, codegen, logger, readOnly: true });

        if (gate.blocked) {
            errors.push(gate.reason);
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        errors.push(`codegen failed: ${message}`);
    }

    if (options.typecheck !== false) {
        const typecheck = await runTypecheckStep(cwd, options.spawner ?? defaultSpawner);

        if (typecheck.error !== undefined) {
            errors.push(typecheck.error);
        }

        if (typecheck.warning !== undefined) {
            warnings.push(typecheck.warning);
        }
    }

    // Opt-in health probe: only runs when a deployment URL is given, so the
    // default `verify` never touches the network.
    const healthError = await probeHealthIfRequested(options, logger);

    if (healthError !== undefined) {
        errors.push(healthError);
    }

    const result = reportVerifyResult(logger, errors, warnings, validation.wranglerPath);

    if (isJsonFormat(options.format)) {
        printJson(result);
    }

    return result;
};

/** `lunora verify` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<VerifyOptions> = defineHandler<VerifyOptions>(async ({ cwd, logger, options }) => {
    const result = await runVerifyCommand({
        allowSchemaDrift: options.allowSchemaDrift === true,
        apiSpec: parseApiSpec(options.apiSpec),
        cwd,
        format: options.format,
        healthUrl: options.healthUrl,
        logger,
        target: options.target,
        // `--no-typecheck` is declared as a `no-*` option but cerebro exposes it
        // under the negated `typecheck` key (false when passed, true when absent).
        typecheck: options.typecheck === false ? false : undefined,
    });

    return { code: result.code };
});

export { execute };
export type { HealthFetch, VerifyCommandOptions, VerifyCommandResult };
export { runVerifyCommand };
