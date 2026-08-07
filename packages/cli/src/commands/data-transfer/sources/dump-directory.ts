/**
 * The shape both foreign dumps share: a directory of per-table files, resolved
 * against the operator's mapping.
 *
 * Supabase and Firebase differ only in which files they claim and how a file's
 * bytes decode. Everything around that — matching mapping-named files, excluding
 * the auth dump, erroring on an empty directory, sorting for deterministic
 * output, seeding the parity tally, emitting the auth rows first — was written
 * twice and had already drifted once, losing the `\N` NULL handling on one side.
 */
import { basename, join } from "node:path";

import { LunoraError } from "@lunora/errors";

import type { Logger } from "../../../util/logger";
import type { ImportSourceMapping } from "./mapping";

/** One source file in a dump directory, resolved to the table it feeds. */
interface DumpFile {
    file: string;
    table: string;
}

interface ListDumpOptions {
    /** Files the mapping claims for auth, which are never application tables. */
    authFiles: ReadonlySet<string>;
    /** Message when the directory holds nothing this reader recognises. */
    emptyMessage: string;
    /** Does this filename belong to this source? */
    matches: (name: string) => boolean;
    /** Strip the extension to get the default table name. */
    tableNameOf: (name: string) => string;
}

/**
 * Resolve the files in a dump directory to their tables.
 *
 * A mapping entry may name its file explicitly; anything unnamed falls back to
 * the filename stem, so a dump of twenty tables needs a mapping only for the
 * columns that actually need one.
 */
const listDumpFiles = async (
    directory: string,
    mapping: ImportSourceMapping | undefined,
    options: ListDumpOptions,
    readDirectory: (path: string) => Promise<{ isFile: () => boolean; name: string }[]>,
): Promise<DumpFile[]> => {
    const entries = await readDirectory(directory).catch(() => undefined);

    if (entries === undefined) {
        throw new LunoraError("INTERNAL", `${directory} is not a readable directory`);
    }

    const claimed = new Map<string, string>();

    for (const [table, tableMapping] of Object.entries(mapping?.tables ?? {})) {
        if (tableMapping.file !== undefined) {
            // A mapping `file` is operator-supplied and joined onto a path, so it
            // is matched by basename rather than trusted as a path fragment.
            claimed.set(basename(tableMapping.file), table);
        }
    }

    const found = entries
        .filter((entry) => entry.isFile() && options.matches(entry.name) && !options.authFiles.has(entry.name))
        .map((entry) => {
            return { file: join(directory, entry.name), table: claimed.get(entry.name) ?? options.tableNameOf(entry.name) };
        });

    if (found.length === 0) {
        throw new LunoraError("INTERNAL", `${directory} ${options.emptyMessage}`);
    }

    // A mapping entry names a table the operator expects to migrate. If its file
    // is absent from the directory — or present but filtered out, e.g. the wrong
    // extension — dropping it silently means that table simply never arrives,
    // and `--verify` still passes because it compares what WAS imported.
    const resolved = new Set(found.map((entry) => basename(entry.file)));
    const unresolved = [...claimed].filter(([file]) => !resolved.has(file));

    if (unresolved.length > 0) {
        throw new LunoraError(
            "INTERNAL",
            `${directory}: the mapping names ${String(unresolved.length)} file(s) that are not importable from this directory — ` +
                `${unresolved.map(([file, table]) => `\`${file}\` (table \`${table}\`)`).join(", ")}. ` +
                `Check the name and that the file is one this source reads.`,
        );
    }

    return found.toSorted((a, b) => a.table.localeCompare(b.table));
};

/**
 * Stream a dump as `{ table, doc }` NDJSON, tallying rows per table.
 *
 * The per-file decoder is the only thing a source contributes; the tally, the
 * progress line, and the empty-table seeding are the same either way.
 */
const readDumpFiles = async function* (
    files: ReadonlyArray<DumpFile>,
    logger: Logger,
    sourceRows: Map<string, number>,
    readDocuments: (file: DumpFile) => AsyncIterable<Record<string, unknown>>,
): AsyncGenerator<string> {
    for (const dumpFile of files) {
        // Seed the tally so an empty table still appears in the parity report —
        // absent-vs-zero is "never read" vs "nothing to import".
        if (!sourceRows.has(dumpFile.table)) {
            sourceRows.set(dumpFile.table, 0);
        }

        logger.info(`reading ${basename(dumpFile.file)} → ${dumpFile.table}`);

        // eslint-disable-next-line no-await-in-loop -- draining one file's documents before the next is the streaming contract
        for await (const document of readDocuments(dumpFile)) {
            sourceRows.set(dumpFile.table, (sourceRows.get(dumpFile.table) ?? 0) + 1);

            yield `${JSON.stringify({ doc: document, table: dumpFile.table })}\n`;
        }
    }
};

export type { DumpFile, ListDumpOptions };
export { listDumpFiles, readDumpFiles };
