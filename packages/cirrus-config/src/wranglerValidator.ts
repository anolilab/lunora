/**
 * Shared wrangler.jsonc validator used by both the Vite plugin
 * (`@cirrus/vite`) and the CLI (`@cirrus/cli`).
 *
 * Two entry points are provided:
 *  - `validateWranglerConfig(wrangler, schemaInfo)` — pure: takes a parsed
 *    object plus an optional schema descriptor and returns a structured
 *    `{ valid, errors, warnings }` result.
 *  - `validateWranglerProject({ projectRoot, schemaDir })` — file-system
 *    aware: locates `wrangler.jsonc`/`wrangler.json`, parses it, discovers
 *    the project's schema, and returns the existing
 *    `{ problems, wranglerPath }` shape kept for backward compatibility.
 */
import { existsSync, readFileSync } from "node:fs";

import { discoverSchema } from "@cirrus/codegen";
import type { ParseError } from "jsonc-parser";
import { parse as parseJsonc } from "jsonc-parser";
import { Project } from "ts-morph";

import { join } from "./path.js";

export const REQUIRED_COMPATIBILITY_DATE: string = "2026-04-07";

export const REQUIRED_FLAG: string = "web_socket_auto_reply_to_close";

interface WranglerDurableObjectBinding {
    class_name?: string;
    name?: string;
}

export interface WranglerConfig {
    compatibility_date?: string;
    compatibility_flags?: ReadonlyArray<string>;
    d1_databases?: ReadonlyArray<{ binding?: string }>;
    durable_objects?: { bindings?: ReadonlyArray<WranglerDurableObjectBinding> };
    r2_buckets?: ReadonlyArray<{ binding?: string }>;
}

export interface SchemaInfo {
    /** Whether the cirrus schema declares any `.global()` table. */
    hasGlobalTable: boolean;
}

export interface WranglerValidationReport {
    errors: string[];
    valid: boolean;
    warnings: string[];
}

/**
 * Pure validator: given a parsed `WranglerConfig` object and an optional
 * `SchemaInfo`, produce a structured report. Performs no I/O.
 */
export const validateWranglerConfig = (wrangler: WranglerConfig | undefined, schema?: SchemaInfo): WranglerValidationReport => {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!wrangler || typeof wrangler !== "object") {
        errors.push("wrangler config is not a valid object");

        return { errors, valid: false, warnings };
    }

    const durableObjectBindings = wrangler.durable_objects?.bindings ?? [];
    const shardBinding = durableObjectBindings.find((binding) => binding.name === "SHARD" && binding.class_name === "ShardDO");

    if (!shardBinding) {
        errors.push('durable_objects.bindings must include { "name": "SHARD", "class_name": "ShardDO" }');
    }

    const compatibilityDate = wrangler.compatibility_date ?? "";

    if (compatibilityDate < REQUIRED_COMPATIBILITY_DATE) {
        errors.push(`compatibility_date must be >= "${REQUIRED_COMPATIBILITY_DATE}" (got "${compatibilityDate || "<missing>"}")`);
    }

    // `web_socket_auto_reply_to_close` became the default on 2026-04-07, which
    // is the same date REQUIRED_COMPATIBILITY_DATE enforces — so requiring it
    // explicitly is redundant and workerd now warns when it's set. Listing the
    // flag is still accepted, so we don't error if it's present.
    const flags = wrangler.compatibility_flags ?? [];

    if (compatibilityDate && compatibilityDate < REQUIRED_COMPATIBILITY_DATE && !flags.includes(REQUIRED_FLAG)) {
        errors.push(`compatibility_flags must include "${REQUIRED_FLAG}"`);
    }

    if (schema?.hasGlobalTable) {
        const d1Bindings = wrangler.d1_databases ?? [];
        const dbBinding = d1Bindings.find((binding) => binding.binding === "DB");

        if (!dbBinding) {
            errors.push('schema declares .global() tables; d1_databases must include a binding named "DB"');
        }
    }

    return { errors, valid: errors.length === 0, warnings };
};

/**
 * Convenience alias matching the original task-spec signature
 * `validateWrangler(wranglerJson, schema)` returning
 * `{ valid, errors, warnings }`.
 */
export const validateWrangler: typeof validateWranglerConfig = validateWranglerConfig;

export interface WranglerProjectValidationOptions {
    projectRoot: string;
    schemaDir?: string;
}

export interface WranglerProjectValidationResult {
    problems: ReadonlyArray<string>;
    report: WranglerValidationReport;
    wranglerPath: string | undefined;
}

const findWranglerFile = (projectRoot: string): string | undefined => {
    const candidates = ["wrangler.jsonc", "wrangler.json"];

    for (const candidate of candidates) {
        const fullPath = join(projectRoot, candidate);

        if (existsSync(fullPath)) {
            return fullPath;
        }
    }

    return undefined;
};

/**
 * File-system aware variant: reads `wrangler.jsonc`/`wrangler.json` from
 * the given project root, discovers the schema (if any), and delegates to
 * `validateWranglerConfig`. Returns the legacy
 * `{ problems, wranglerPath }` shape plus the structured `report`.
 */
export const validateWranglerProject = (options: WranglerProjectValidationOptions): WranglerProjectValidationResult => {
    const schemaDir = options.schemaDir ?? "cirrus";
    const wranglerPath = findWranglerFile(options.projectRoot);

    if (!wranglerPath) {
        const message = `wrangler.jsonc not found in ${options.projectRoot}; create one declaring at least the SHARD durable object binding.`;

        return {
            problems: [message],
            report: { errors: [message], valid: false, warnings: [] },
            wranglerPath: undefined,
        };
    }

    const text = readFileSync(wranglerPath, "utf8");
    const parseErrors: ParseError[] = [];
    const wrangler = parseJsonc(text, parseErrors, { allowTrailingComma: true }) as WranglerConfig | undefined;

    if (parseErrors.length > 0 || !wrangler || typeof wrangler !== "object") {
        const message = `failed to parse ${wranglerPath} as JSONC.`;

        return {
            problems: [message],
            report: { errors: [message], valid: false, warnings: [] },
            wranglerPath,
        };
    }

    const schemaPath = join(options.projectRoot, schemaDir, "schema.ts");
    const warnings: string[] = [];
    let schemaInfo: SchemaInfo | undefined;

    if (existsSync(schemaPath)) {
        try {
            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const schema = discoverSchema(project, schemaPath);

            schemaInfo = { hasGlobalTable: schema.tables.some((table) => table.shardMode === "global") };
        } catch (schemaError: unknown) {
            // Surface a warning rather than swallowing silently — codegen
            // will report the actionable error elsewhere, but a complete
            // miss here is hard to debug.
            const message = schemaError instanceof Error ? schemaError.message : String(schemaError);

            warnings.push(`schema parse failed at ${schemaPath}: ${message}`);
        }
    }

    const report = validateWranglerConfig(wrangler, schemaInfo);

    if (warnings.length > 0) {
        report.warnings.push(...warnings);
    }

    return {
        problems: report.errors,
        report,
        wranglerPath,
    };
};
