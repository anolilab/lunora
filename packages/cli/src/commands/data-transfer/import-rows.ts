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

    const remapEnvelope = (trimmed: string, lineNumber: number): string => {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;

        if (typeof parsed["table"] !== "string") {
            throw new LunoraError("INTERNAL", `line ${String(lineNumber)}: import envelope is missing a string \`table\``);
        }

        if (parsed["doc"] !== null && typeof parsed["doc"] === "object" && !Array.isArray(parsed["doc"])) {
            let document = parsed["doc"] as Record<string, unknown>;

            if (storageIdMap !== undefined) {
                const remap = remapStorageReferences(document, storageIdMap, parsed["table"], storageColumns);

                document = remap.document;
                report.rewritten += remap.rewritten;
                report.ambiguous.push(...remap.ambiguous);
                report.unmigrated.push(...remap.unmigrated);
            }

            // Rebuild from the parsed envelope so any field beyond
            // `{ table, doc }` survives the rewrite.
            parsed["doc"] = remapDocument === undefined ? document : remapDocument(document, parsed["table"]);
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

        // Every envelope is parsed when a rewrite is configured — a storage id or
        // an object path can sit in a plain column, which no substring of the
        // line announces. With neither, the line goes through untouched.
        return storageIdMap === undefined && remapDocument === undefined ? trimmed : remapEnvelope(trimmed, lineNumber);
    };
};

export type { RowTransformConfig };
export { createRowTransformer };
