/**
 * What `lunora import` was pointed at — a Convex export snapshot, a Supabase CSV
 * dump, a Firestore export, or a plain NDJSON file — plus the readers that turn
 * each into the `{ table, doc }` NDJSON the admin import endpoint accepts.
 */
import { stat } from "node:fs/promises";

import { LunoraError } from "@lunora/errors";

import type { Logger } from "../../util/logger";
import type { ConvexSnapshot, ConvexSnapshotTable } from "../convex-snapshot";
import { listConvexSnapshotTables, readSnapshotLines, resolveConvexSnapshot } from "../convex-snapshot";
import type { ImportCommandOptions } from "./import";
import type { FirestoreCollectionFile } from "./sources/firebase";
import { listFirestoreCollections } from "./sources/firebase";
import type { ImportSourceMapping } from "./sources/mapping";
import { readImportSourceMapping } from "./sources/mapping";
import type { SupabaseTableFile } from "./sources/supabase";
import { listSupabaseTables } from "./sources/supabase";
import { readStorageMetadata } from "./storage-blobs";

/**
 * Convex's own file table. Its rows describe stored BLOBS, not application
 * data — the bytes sit next to the JSONL as separate files and belong in R2,
 * so importing the rows alone would create dangling references.
 */
const CONVEX_STORAGE_TABLE = "_storage";

/**
 * Convex system tables are `_`-prefixed (`_storage`, `_scheduled_functions`,
 * `_modules`, …). None of them are application data, and none of them exist on
 * the target: streaming them in would create rows nothing reads, and `--verify`
 * would then demand row parity for a table the endpoint rejected.
 */
const isConvexSystemTable = (table: string): boolean => table.startsWith("_");

/**
 * Stream one `documents.jsonl` as `{ table, doc }` NDJSON lines, tallying what
 * it emitted into `sourceRows`.
 *
 * The tally rides along with the read rather than coming from a separate
 * counting pass: this generator already yields exactly the rows that reach the
 * import endpoint, so counting here is both one pass cheaper and strictly more
 * honest — `--verify` then compares "inserted" against what was actually sent,
 * not against a number derived by re-reading the source under slightly
 * different rules.
 */
// eslint-disable-next-line func-style -- a generator cannot be written as an arrow function; `function*` is the only form.
async function* wrapJsonlLines(snapshot: ConvexSnapshot, tableEntry: ConvexSnapshotTable, sourceRows: Map<string, number>): AsyncGenerator<string> {
    let lineNumber = 0;

    for await (const raw of readSnapshotLines(snapshot, tableEntry)) {
        const line = raw.trim();

        lineNumber += 1;

        if (line.length === 0) {
            continue;
        }

        let document: unknown;

        try {
            document = JSON.parse(line);
        } catch (error: unknown) {
            throw new LunoraError(
                "INTERNAL",
                `${tableEntry.table}/documents.jsonl line ${String(lineNumber)}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }

        sourceRows.set(tableEntry.table, (sourceRows.get(tableEntry.table) ?? 0) + 1);

        yield `${JSON.stringify({ doc: document, table: tableEntry.table })}\n`;
    }
}

/**
 * Stream a Convex export snapshot as the `{ table, doc }` NDJSON the admin
 * import endpoint accepts.
 *
 * **No id remapping.** Convex `_id`s are preserved verbatim: the admin import
 * path inserts with `allowExplicitId`, and `v.id()` validates only that the
 * value is a string. So every Convex id — including every `v.id()` foreign key
 * already pointing at one — carries across unchanged, and a single-pass import
 * is correct.
 *
 * The alternative, remapping to freshly-minted ids, forces two passes (insert
 * with FKs nulled, then patch them back through an id map) to survive
 * self-referential cycles. None of that is needed here.
 */
// eslint-disable-next-line func-style -- a generator cannot be written as an arrow function; `function*` is the only form.
async function* readConvexExport(
    snapshot: ConvexSnapshot,
    tables: ReadonlyArray<ConvexSnapshotTable>,
    logger: Logger,
    storageMigrated: boolean,
    sourceRows: Map<string, number>,
): AsyncGenerator<string> {
    for (const tableEntry of tables) {
        if (isConvexSystemTable(tableEntry.table)) {
            // `_storage` rows describe blobs, so they are never imported as
            // documents either way. What differs is whether the blobs they
            // describe went anywhere: telling an operator to upload the files by
            // hand *after* `--with-storage` already migrated them is worse than
            // saying nothing.
            if (tableEntry.table === CONVEX_STORAGE_TABLE && !storageMigrated) {
                logger.warn(
                    `skipping "${CONVEX_STORAGE_TABLE}" — those rows describe stored files, and their blobs were not migrated. Re-run with --with-storage to upload them and rewrite the references.`,
                );
            }

            continue;
        }

        // Seed the tally so a table that turns out to be empty still appears in
        // the parity report — absent-vs-zero is the difference between "nothing
        // to import" and "never read".
        if (!sourceRows.has(tableEntry.table)) {
            sourceRows.set(tableEntry.table, 0);
        }

        yield* wrapJsonlLines(snapshot, tableEntry, sourceRows);
    }
}

/**
 * What the positional path turned out to be. A discriminated union rather than a
 * bag of optionals: the snapshot and its table list are always both present or
 * both absent, and only a union lets the caller establish that once.
 */
type ImportSource =
    | { kind: "convex"; snapshot: ConvexSnapshot; tables: ReadonlyArray<ConvexSnapshotTable> }
    | { collections: ReadonlyArray<FirestoreCollectionFile>; kind: "firebase"; mapping?: ImportSourceMapping }
    | { kind: "invalid" }
    | { kind: "ndjson" }
    | { kind: "supabase"; mapping?: ImportSourceMapping; tables: ReadonlyArray<SupabaseTableFile> };

/**
 * The sources `--from` accepts.
 *
 * Only the two that cannot be detected. A Convex snapshot announces itself (a
 * directory of `<table>/documents.jsonl`, or a `.zip` of one) and anything else
 * is NDJSON, so naming those would advertise a control this does not implement:
 * `--from ndjson` against a Convex export would have to either refuse it or
 * silently import it as Convex, and the second is what an unhonoured flag
 * actually did.
 */
const IMPORT_SOURCE_NAMES = ["firebase", "supabase"] as const;

type ImportSourceName = (typeof IMPORT_SOURCE_NAMES)[number];

/**
 * Resolve an explicitly-requested `--from supabase` / `--from firebase` source.
 *
 * Both are directories of per-table files, and both read their mapping from the
 * project rather than from the dump — the dump is the vendor's artefact, the
 * mapping is the operator's statement about it.
 */
const resolveForeignSource = async (options: ImportCommandOptions, from: "firebase" | "supabase", cwd: string): Promise<ImportSource> => {
    if (options.withStorage === true && from === "firebase" && options.storageDir === undefined) {
        // Firebase Cloud Storage has no listing endpoint this CLI can reach
        // without owning Google's auth, so the bucket arrives as a local
        // directory. Accepting the flag on its own would migrate nothing.
        options.logger.error("--with-storage on Firebase needs --storage-dir — download the bucket first with `gcloud storage cp -r gs://<bucket> <dir>`.");

        return { kind: "invalid" };
    }

    if (options.table !== undefined) {
        options.logger.error(`--table cannot be combined with --from ${from} — each row's table comes from its source file.`);

        return { kind: "invalid" };
    }

    const mapping = await readImportSourceMapping(cwd, from, options.logger);

    // Same rule the Convex path applies: verifying row counts while every
    // storage reference still points at the platform being torn down is worse
    // than not verifying, because it reports success over broken data.
    const declaresStorageColumns = Object.values(mapping?.tables ?? {}).some((table) => (table.storageColumns ?? []).length > 0);

    if (options.verify === true && options.withStorage !== true && declaresStorageColumns) {
        options.logger.error(
            `--verify with \`storageColumns\` declared requires --with-storage — otherwise every storage path stays unmigrated and only row counts would be checked.`,
        );

        return { kind: "invalid" };
    }

    if (from === "supabase") {
        return { kind: "supabase", mapping, tables: await listSupabaseTables(options.file, mapping) };
    }

    return { collections: await listFirestoreCollections(options.file, mapping), kind: "firebase", mapping };
};

/**
 * Report any storage-aware flag passed against a source that cannot honour it.
 *
 * A plain NDJSON file carries no `_storage` sidecar and no per-table source to
 * count, so `--scan` / `--verify` / `--with-storage` are all inapplicable.
 * Accepting one and doing nothing is how an operator ends up believing the blobs
 * migrated when none did.
 *
 * A path that does not exist at all is deliberately NOT reported here:
 * `resolveImportRequest` stats the file and says so precisely, and
 * "--with-storage requires a Convex export" is a confusing way to learn you
 * typed the path wrong.
 */
const rejectSnapshotFlags = async (options: ImportCommandOptions): Promise<boolean> => {
    const exists = await stat(options.file).then(
        () => true,
        () => false,
    );

    if (!exists) {
        return false;
    }

    for (const [flag, enabled] of [
        ["--scan", options.scan],
        ["--verify", options.verify],
        ["--with-storage", options.withStorage],
    ] as const) {
        if (enabled === true) {
            options.logger.error(`${flag} requires a Convex export directory or .zip snapshot — ${options.file} is not one.`);

            return true;
        }
    }

    return false;
};

/**
 * Refuse `--verify` when it could only ever check half the migration.
 *
 * Row counts over an export whose file references were never migrated is a
 * clean bill of health over broken data — the worst possible output, because it
 * is indistinguishable from a good one.
 */
const rejectUnverifiableStorage = async (
    snapshot: ConvexSnapshot,
    tables: ReadonlyArray<ConvexSnapshotTable>,
    options: ImportCommandOptions,
): Promise<boolean> => {
    const storageTable = tables.find((entry) => entry.table === CONVEX_STORAGE_TABLE);

    if (storageTable === undefined) {
        // No `_storage` at all means the export was taken WITHOUT
        // `--include-file-storage`. That is the likeliest operator mistake,
        // and it used to sail straight through: with no storage table the
        // guard below never fired, no warning was printed, and every
        // `{ $storage }` reference imported verbatim as a nested object that
        // resolves to nothing — under a green "verify" line and exit 0.
        options.logger.error(
            "--verify cannot check file references: this export has no `_storage` table, so it was taken without `--include-file-storage`. Re-export with that flag and pass --with-storage, or drop --verify.",
        );

        return true;
    }

    const blobs = await readStorageMetadata(snapshot, storageTable, options.logger);

    if (blobs.length > 0) {
        options.logger.error(
            `--verify on an export carrying ${String(blobs.length)} stored file(s) requires --with-storage — otherwise every file reference stays unmigrated and only row counts would be checked.`,
        );

        return true;
    }

    return false;
};

/**
 * Decide whether the positional path is a Convex export snapshot (directory or
 * `.zip`) or a plain NDJSON file, and check the flags are coherent with that
 * answer. Both halves live here because "what is this source" and "do these
 * flags mean anything for it" are the same question asked twice.
 */
const resolveImportSource = async (options: ImportCommandOptions, cwd: string): Promise<ImportSource> => {
    if (options.from === "supabase" || options.from === "firebase") {
        return resolveForeignSource(options, options.from, cwd);
    }

    const snapshot = await resolveConvexSnapshot(options.file);
    const tables = snapshot === undefined ? undefined : await listConvexSnapshotTables(snapshot);

    if (snapshot !== undefined && tables === undefined) {
        options.logger.error(
            `${options.file} is a ${snapshot.kind === "zip" ? ".zip" : "directory"} but holds no <table>/documents.jsonl — expected a \`npx convex export --path\` snapshot, or pass an NDJSON file.`,
        );

        return { kind: "invalid" };
    }

    if (snapshot === undefined || tables === undefined) {
        return (await rejectSnapshotFlags(options)) ? { kind: "invalid" } : { kind: "ndjson" };
    }

    if (options.table !== undefined) {
        options.logger.error("--table cannot be combined with a Convex export directory — each row's table comes from its source directory.");

        return { kind: "invalid" };
    }

    // `--verify` over an export that HAS blobs, without migrating them, can only
    // ever report row parity — and would then print a clean bill of health over
    // documents whose every file reference still points at a Convex id that
    // resolves to nothing. Verifying half the migration and calling it verified
    // is worse than not verifying.
    //
    // The check reads the metadata rather than trusting the directory's presence:
    // `--include-file-storage` on an app with no files still emits an empty
    // `_storage/`, and blocking `--verify` over nothing would be noise.
    if (options.verify === true && options.withStorage !== true && (await rejectUnverifiableStorage(snapshot, tables, options))) {
        return { kind: "invalid" };
    }

    return { kind: "convex", snapshot, tables };
};

export type { ImportSource, ImportSourceName };
export { CONVEX_STORAGE_TABLE, IMPORT_SOURCE_NAMES, isConvexSystemTable, readConvexExport, resolveImportSource };
