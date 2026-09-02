import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { discoverSchema, schemaFromIr } from "@lunora/codegen";
import { seedPlan } from "@lunora/seed";
import { join } from "@visulima/path";
import { Project } from "ts-morph";

import { targetsRemoteWorker } from "../../util/admin-token";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { resolveProductionWorkerUrl } from "../../util/resolve-target";
import { tuiConfirm } from "../../util/tui-prompts";
import type { StreamingFetchLike } from "../data-transfer";
import { runImportCommand } from "../data-transfer";
import { runResetCommand } from "../reset/handler";
import type { SeedOptions } from "./index";

interface SeedCommandOptions {
    batchSize?: number;
    /** Inject a custom confirmer (tests, non-TTY callers). Returns `true` on confirmation. */
    confirm?: (prompt: string) => Promise<boolean>;
    /** Rows per table (default 10). */
    count?: number;
    cwd?: string;
    /** Print the NDJSON instead of inserting. */
    dryRun?: boolean;
    fetchImpl?: StreamingFetchLike;
    logger: Logger;
    /** Epoch-ms reference for time-valued columns; pin with `seed` for byte-identical rows. */
    now?: number;
    prod?: boolean;
    /** Wipe local `.wrangler/state` before seeding (local dev only). */
    reset?: boolean;
    /** Deterministic seed — same value yields identical rows (default 0). */
    seed?: number;
    /** Seed only this table; its FK-parent tables are seeded automatically so foreign keys resolve. */
    table?: string;
    token?: string;
    url?: string;
    /** Skip the production-insert confirmation prompt. Required when stdin is not a TTY. */
    yes?: boolean;
}

interface SeedCommandResult {
    code: number;
    /** Rows the import step skipped because their `_id` already existed (re-run collisions). */
    conflicts: number;
    /** Total rows generated across every seeded table. */
    generated: number;
    /** Rows inserted by the import step; `0` on `--dry-run` or failure. */
    inserted: number;
    /** The generated NDJSON (always populated; printed verbatim on `--dry-run`). */
    ndjson: string;
}

/**
 * JSON replacer that keeps seeded `v.bigint` / `v.bytes` values serializable:
 * a bigint becomes a number (the generator's range is small and safe) and an
 * `ArrayBuffer` becomes a byte array. Every other generated value is already
 * JSON-native (string / number / boolean / null / nested object / array).
 */
const ndjsonReplacer = (_key: string, value: unknown): unknown => {
    if (typeof value === "bigint") {
        return Number(value);
    }

    if (value instanceof ArrayBuffer) {
        return [...new Uint8Array(value)];
    }

    return value;
};

/** A non-inserting failure result (no rows generated). */
const seedFailure = (code: number): SeedCommandResult => {
    return { code, conflicts: 0, generated: 0, inserted: 0, ndjson: "" };
};

/**
 * Validate the seed preconditions that don't need the parsed schema: the schema
 * file must exist, and `--reset` (local `.wrangler/state` only) is incompatible
 * with a remote/production target. Returns a failure result to short-circuit on,
 * or `undefined` when the run may proceed.
 */
const guardSeedTargets = (options: SeedCommandOptions, schemaPath: string): SeedCommandResult | undefined => {
    if (!existsSync(schemaPath)) {
        options.logger.error(`schema not found: ${schemaPath} — run \`vis generate lunora-table --name=<name>\` to create one`);

        return seedFailure(1);
    }

    // `--reset` clears local `.wrangler/state` only; it cannot touch a remote
    // deployment, so refuse it the moment a remote target is in play.
    if (options.reset === true && targetsRemoteWorker({ prod: options.prod, url: options.url })) {
        options.logger.error("--reset only clears local .wrangler/state and cannot be combined with --prod or a remote --url");

        return seedFailure(1);
    }

    return undefined;
};

/**
 * Write the generated NDJSON to a temp file, stream it through the existing
 * `runImportCommand` (whose `{table, doc}` envelopes pass straight through),
 * surface any skipped rows as conflicts, then clean up regardless of outcome.
 */
const insertSeedRows = async (ndjson: string, generated: number, cwd: string, options: SeedCommandOptions): Promise<SeedCommandResult> => {
    // Create the scratch file inside a freshly-minted private dir (0700, random
    // suffix) rather than a predictable PID+timestamp name in the shared tmpdir —
    // that pattern (CWE-377) lets a local attacker pre-create the path as a
    // symlink and clobber/capture the write.
    const scratchDirectory = await mkdtemp(join(tmpdir(), "lunora-seed-"));
    const temporaryFile = join(scratchDirectory, "rows.ndjson");

    await writeFile(temporaryFile, ndjson, "utf8");

    try {
        const result = await runImportCommand({
            batchSize: options.batchSize,
            cwd,
            fetchImpl: options.fetchImpl,
            file: temporaryFile,
            logger: options.logger,
            prod: options.prod,
            token: options.token,
            url: options.url,
            // seed has already confirmed the target itself (`confirmRemoteSeedTarget`),
            // so the import leg must not demand a second `--yes` the caller has no
            // way to pass through.
            yes: true,
        });

        const conflicts = result.body?.conflicts ?? 0;

        if (conflicts > 0) {
            // Seeding is deterministic: a re-run with the same `--seed` regenerates
            // the same `_id`s, which the import path skips as conflicts. Point the
            // user at the two ways to get a clean insert.
            options.logger.warn(
                `${String(conflicts)} row(s) skipped — their _id already exists. Seeding is deterministic; re-run with --reset to wipe local state first, or a different --seed for fresh ids.`,
            );
        }

        return { code: result.code, conflicts, generated, inserted: result.inserted, ndjson };
    } finally {
        await rm(scratchDirectory, { force: true, recursive: true }).catch(() => {});
    }
};

/** Validate that `--table`, when given, names a table the schema defines; returns a failure result when unknown, else `undefined`. */
const validateSeedTable = (options: SeedCommandOptions, ir: { tables: ReadonlyArray<{ name: string }> }): SeedCommandResult | undefined => {
    if (options.table === undefined || ir.tables.some((table) => table.name === options.table)) {
        return undefined;
    }

    const available = ir.tables.map((table) => table.name).join(", ");

    options.logger.error(`unknown table "${options.table}" — schema defines: ${available || "(no tables)"}`);

    return seedFailure(1);
};

/**
 * Gate a non-local seed target behind explicit confirmation — seeding fake rows
 * into a deployment pollutes real data. "Remote" is decided by the resolved
 * target, not by `--prod` — see {@link targetsRemoteWorker}. Confirmation is an
 * explicit --yes or, on a TTY, an interactive prompt; the sibling admin
 * commands (`migrate up/down`, `backup pitr --restore`, `import`) gate the same
 * way but accept only --yes, so do not describe this as identical to them.
 * Returns a failure {@link SeedCommandResult} when the seed must NOT proceed
 * (refused / aborted), or `undefined` when it is safe to continue.
 */
const confirmRemoteSeedTarget = async (options: SeedCommandOptions, generated: number): Promise<SeedCommandResult | undefined> => {
    const targetsRemote = targetsRemoteWorker({ prod: options.prod, url: options.url });

    if (!targetsRemote || options.yes === true) {
        return undefined;
    }

    if (!process.stdin.isTTY && options.confirm === undefined) {
        options.logger.error("seed: refusing to insert into a non-local target without confirmation — re-run with --yes");

        return seedFailure(1);
    }

    const confirmer = options.confirm ?? tuiConfirm;
    const confirmed = await confirmer(`This will insert ${String(generated)} generated row(s) into ${options.url ?? "the production worker"}. Continue?`);

    if (!confirmed) {
        options.logger.info("seed: aborted");

        return seedFailure(1);
    }

    return undefined;
};

/**
 * Generate deterministic seed data from `lunora/schema.ts` and either print it
 * (`--dry-run`) or bulk-insert it through the existing import pipeline.
 *
 * The CLI never executes the user's schema module; it lifts the schema
 * statically via `@lunora/codegen`'s `discoverSchema` and bridges the IR into
 * the runtime shape `@lunora/seed` introspects ({@link schemaFromIr}). The plan
 * is pure and deterministic — the same `--seed` always yields identical rows.
 */
const runSeedCommand = async (options: SeedCommandOptions): Promise<SeedCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const schemaPath = join(cwd, "lunora", "schema.ts");

    const guard = guardSeedTargets(options, schemaPath);

    if (guard !== undefined) {
        return guard;
    }

    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const ir = discoverSchema(project, schemaPath);

    const unknownTable = validateSeedTable(options, ir);

    if (unknownTable !== undefined) {
        return unknownTable;
    }

    const schema = schemaFromIr(ir);
    const plan = seedPlan(schema, {
        defaultCount: options.count ?? 10,
        // Omitted → `seedPlan` stamps the current clock. Passing it pins the one
        // input `--seed` does not cover, which is what makes a run replayable.
        now: options.now,
        only: options.table === undefined ? undefined : [options.table],
        seed: options.seed ?? 0,
    });

    const lines: string[] = [];

    for (const { rows, table } of plan) {
        for (const row of rows) {
            lines.push(JSON.stringify({ doc: row, table }, ndjsonReplacer));
        }
    }

    const ndjson = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    const generated = lines.length;

    if (options.dryRun === true) {
        if (ndjson.length > 0) {
            process.stdout.write(ndjson);
        }

        options.logger.info(`generated ${String(generated)} row(s) across ${String(plan.length)} table(s) — dry run, nothing inserted`);

        return { code: 0, conflicts: 0, generated, inserted: 0, ndjson };
    }

    // Checked BEFORE the wipe: `--reset --count 0` used to destroy the local dev
    // database and only then warn there was nothing to insert — exiting 0.
    if (generated === 0) {
        options.logger.warn("no rows generated — nothing to insert");

        return { code: 0, conflicts: 0, generated: 0, inserted: 0, ndjson };
    }

    if (options.reset === true) {
        // `yes` is forwarded, not hard-coded: `--reset` deletes `.wrangler/state`
        // exactly as `lunora reset` does, and passing `true` unconditionally
        // bypassed that command's own confirmation.
        const reset = await runResetCommand({ confirm: options.confirm, cwd, logger: options.logger, yes: options.yes });

        if (reset.code !== 0) {
            return { code: reset.code, conflicts: 0, generated, inserted: 0, ndjson };
        }
    }

    const aborted = await confirmRemoteSeedTarget(options, generated);

    if (aborted !== undefined) {
        return aborted;
    }

    return insertSeedRows(ndjson, generated, cwd, options);
};

/** `lunora seed` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<SeedOptions> = defineHandler<SeedOptions>(async ({ cwd, logger, options }) => {
    const result = await runSeedCommand({
        batchSize: options.batchSize,
        count: options.count,
        cwd,
        dryRun: options.dryRun === true,
        logger,
        prod: options.prod === true,
        reset: options.reset === true,
        now: options.now,
        seed: options.seed,
        table: options.table,
        token: options.token,
        // Resolve the link here (only under --prod) so seed's own remote/confirm
        // logic and the downstream import both see the same effective target.
        url: resolveProductionWorkerUrl({ cwd, prod: options.prod === true, url: options.url }),
        yes: options.yes === true,
    });

    return { code: result.code };
});

export { execute, runSeedCommand };
export type { SeedCommandOptions, SeedCommandResult };
