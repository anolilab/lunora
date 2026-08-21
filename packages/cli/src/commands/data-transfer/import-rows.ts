/**
 * Turning one source line into one wire row.
 *
 * Three shapes reach the import endpoint and they differ only here: a
 * `{ table, doc }` envelope passed through untouched, the same envelope with its
 * storage references rewritten, and a bare document wrapped under `--table`.
 */
import { LunoraError } from "@lunora/errors";

import type { StorageRemapReport } from "./storage-remap";
import { remapStorageReferences } from "./storage-remap";

/**
 * A validated `{ table, doc }` import envelope. `table` is `string` because
 * {@link createRowTransformer}'s parser has already thrown for anything else —
 * carrying that proof in the type is what keeps the rewrite half from
 * re-checking it.
 */
interface ImportEnvelope {
    [key: string]: unknown;
    doc?: unknown;
    table: string;
}

interface RowTransformConfig {
    /**
     * A foreign source's path rewrite, applied to the same parsed document as
     * the Convex storage-id rewrite.
     *
     * It is a hook rather than a second transform wrapped around this one so a
     * row is parsed and serialised exactly once: the wrapper form re-parsed
     * every line this function had just serialised, on the one path (a foreign
     * import with `--with-storage`) that already moves the most data.
     */
    remapDocument?: (document: Record<string, unknown>, table: string) => Record<string, unknown>;
    /** Accumulates what the storage rewrite found across the whole run. */
    report: StorageRemapReport;
    /** Columns the mapping file says hold storage ids. */
    storageColumns?: Record<string, string[]>;
    /** `storageId → R2 key`, present only when blobs were migrated. */
    storageIdMap?: Map<string, string>;
    /** Set by `--table`: wrap each bare document under this table name. */
    table?: string;
}

/**
 * Build the line→row transform for one run. Returns `undefined` for a blank
 * line, which the caller skips.
 */
const createRowTransformer = (config: RowTransformConfig): ((line: string, lineNumber: number) => string | undefined) => {
    const { remapDocument, report, storageColumns, storageIdMap, table } = config;

    const wrapBareDocument = (trimmed: string, lineNumber: number): string => {
        // `--table` wraps each bare doc — the source is `{...}\n{...}\n`, not
        // `{table,doc}` envelopes. Guard the parse so a malformed line surfaces a
        // row-scoped error instead of an unhandled rejection.
        let parsedDocument: unknown;

        try {
            parsedDocument = JSON.parse(trimmed);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            throw new LunoraError("INTERNAL", `invalid JSON on line ${String(lineNumber)}: ${message}`, { cause: error });
        }

        // No storage remap on this path: `--table` is rejected alongside a Convex
        // export, and the map only exists for one.
        return JSON.stringify({ doc: parsedDocument, table });
    };

    const parseEnvelope = (trimmed: string, lineNumber: number): ImportEnvelope => {
        let parsed: Record<string, unknown>;

        try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch (error: unknown) {
            // Without this the operator gets a bare `Unexpected token …` with no
            // way to find the offending line in a multi-GB NDJSON file, while
            // every other failure on this path names its line.
            throw new LunoraError(
                "INTERNAL",
                `line ${String(lineNumber)}: import envelope is not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
                {
                    cause: error,
                },
            );
        }

        if (typeof parsed["table"] !== "string") {
            throw new LunoraError("INTERNAL", `line ${String(lineNumber)}: import envelope is missing a string \`table\``);
        }

        return parsed as ImportEnvelope;
    };

    const remapEnvelope = (parsed: ImportEnvelope): string => {
        if (parsed.doc !== null && typeof parsed.doc === "object" && !Array.isArray(parsed.doc)) {
            let document = parsed.doc as Record<string, unknown>;

            if (storageIdMap !== undefined) {
                const remap = remapStorageReferences(document, storageIdMap, parsed.table, storageColumns);

                document = remap.document;
                report.rewritten += remap.rewritten;
                report.ambiguous.push(...remap.ambiguous);
                report.unmigrated.push(...remap.unmigrated);
            }

            // Rebuild from the parsed envelope so any field beyond
            // `{ table, doc }` survives the rewrite.
            return JSON.stringify({ ...parsed, doc: remapDocument === undefined ? document : remapDocument(document, parsed.table) });
        }

        // Reached when `doc` is absent, null or an array: nothing to rewrite,
        // but this is the remap path, which re-serialises either way.
        return JSON.stringify(parsed);
    };

    return (line: string, lineNumber: number): string | undefined => {
        const trimmed = line.trim();

        if (trimmed.length === 0) {
            return undefined;
        }

        if (table !== undefined) {
            return wrapBareDocument(trimmed, lineNumber);
        }

        // Every envelope is parsed, so a corrupted line fails with its line
        // number instead of as a whole-batch server error. With no rewrite
        // configured the ORIGINAL string goes through — re-serialising an
        // unmodified line would churn key order/whitespace for nothing.
        const parsed = parseEnvelope(trimmed, lineNumber);

        return storageIdMap === undefined && remapDocument === undefined ? trimmed : remapEnvelope(parsed);
    };
};

export type { RowTransformConfig };
export { createRowTransformer };
