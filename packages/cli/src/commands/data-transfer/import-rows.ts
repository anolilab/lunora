/**
 * Turning one source line into one wire row.
 *
 * Three shapes reach the import endpoint and they differ only here: a
 * `{ table, doc }` envelope passed through untouched, the same envelope with its
 * storage references rewritten, and a bare document wrapped under `--table`.
 */
import { LunoraError } from "@lunora/errors";

import type { StorageRemapReport } from "./storage-mapping";
import { remapStorageReferences } from "./storage-mapping";

interface RowTransformConfig {
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
    const { report, storageColumns, storageIdMap, table } = config;

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

    const remapEnvelope = (trimmed: string, lineNumber: number, migrated: Map<string, string>): string => {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;

        if (typeof parsed["table"] !== "string") {
            throw new LunoraError("INTERNAL", `line ${String(lineNumber)}: import envelope is missing a string \`table\``);
        }

        if (parsed["doc"] !== null && typeof parsed["doc"] === "object" && !Array.isArray(parsed["doc"])) {
            const remap = remapStorageReferences(parsed["doc"] as Record<string, unknown>, migrated, parsed["table"], storageColumns);

            // Rebuild from the parsed envelope so any field beyond
            // `{ table, doc }` survives the rewrite.
            parsed["doc"] = remap.document;
            report.rewritten += remap.rewritten;
            report.ambiguous.push(...remap.ambiguous);
            report.unmigrated.push(...remap.unmigrated);
        }

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

        // Every envelope is parsed when a storage map exists — a storage id can
        // sit in a plain column, which no substring of the line announces.
        return storageIdMap === undefined ? trimmed : remapEnvelope(trimmed, lineNumber, storageIdMap);
    };
};

export type { RowTransformConfig };
export { createRowTransformer };
