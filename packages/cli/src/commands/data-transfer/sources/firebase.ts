/**
 * Firebase source reader: Firestore documents in the REST/RPC JSON encoding.
 *
 * **What this reads, and what it deliberately does not.** `gcloud firestore
 * export` writes LevelDB-log files wrapping protobuf entities — a binary format
 * needing a protobuf decoder, not the JSON the plan assumed. What *is* JSON, and
 * what every Firestore read path (REST `documents.list`, the Admin SDK's
 * `toJSON`, the common community export tools) produces, is the typed-value
 * encoding decoded here: `{ stringValue }`, `{ integerValue: "42" }`,
 * `{ timestampValue }`, `{ mapValue: { fields } }`, and so on. That encoding is
 * the fiddly part worth owning; producing it is a documented one-liner.
 *
 * Two container shapes are accepted, because both are what people actually have:
 *
 * - a directory of `<collection>.json` / `<collection>.ndjson` files, and
 * - a single JSON file of `{ "<collection>": { "<docId>": { …fields } } }`.
 */
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline";

import { LunoraError } from "@lunora/errors";

import type { Logger } from "../../../util/logger";
import { readAuthDump } from "./auth";
import type { DumpFile } from "./dump-directory";
import { listDumpFiles, readDumpFiles } from "./dump-directory";
import type { ImportSourceMapping, TableMapping } from "./mapping";
import { applyReshape } from "./reshape";

/** A Firestore typed value, as the REST/RPC JSON encoding writes it. */
interface FirestoreValue {
    arrayValue?: { values?: FirestoreValue[] };
    booleanValue?: boolean;
    bytesValue?: { data?: number[]; type?: string } | number[] | string;
    doubleValue?: number | string;
    geoPointValue?: { latitude?: number; longitude?: number };
    integerValue?: number | string;
    mapValue?: { fields?: Record<string, FirestoreValue> };
    nullValue?: null;
    referenceValue?: string;
    stringValue?: string;
    timestampValue?: { nanos?: number; seconds?: number | string } | string;
}

/** The document id is the last segment of `projects/…/documents/<collection>/<id>`. */
const COLLECTION_FILE_RE = /\.(?:nd)?json$/i;

const documentIdFromName = (name: string): string => {
    const segments = name.split("/").filter((segment) => segment.length > 0);

    return segments[segments.length - 1] ?? name;
};

/** Protobuf `Timestamp` → epoch milliseconds; `NaN` when the parts are unusable. */
const protoTimestampToMs = (timestamp: { nanos?: number; seconds?: number | string }): number => {
    const seconds = Number(timestamp.seconds ?? 0);
    const nanos = Number(timestamp.nanos ?? 0);

    return Number.isFinite(seconds) && Number.isFinite(nanos) ? seconds * 1000 + Math.floor(nanos / 1_000_000) : Number.NaN;
};

/** A JSON-rendered Buffer (`{ type: "Buffer", data }`) or a byte array → base64. */
const bytesToBase64 = (value: { data?: number[]; type?: string } | number[], path: string): string => {
    const bytes = Array.isArray(value) ? value : value.data;

    if (!Array.isArray(bytes)) {
        throw new LunoraError("INTERNAL", `${path}: \`bytesValue\` ${JSON.stringify(value)} is neither base64 nor a byte array`);
    }

    return Buffer.from(bytes).toString("base64");
};

/**
 * Decode one typed value to plain JSON.
 *
 * `integerValue` arrives as a *string* precisely because it may exceed
 * `Number.MAX_SAFE_INTEGER`. It is kept as a string when it would not survive
 * the conversion — silently rounding a 64-bit id is the same data loss the
 * Supabase reshape rule refuses.
 */

const decodeValue = (value: FirestoreValue, path: string): unknown => {
    if ("nullValue" in value) {
        // eslint-disable-next-line unicorn/no-null -- a Firestore nullValue is JSON `null`; `undefined` would drop the field
        return null;
    }

    if (value.stringValue !== undefined) {
        return value.stringValue;
    }

    if (value.booleanValue !== undefined) {
        return value.booleanValue;
    }

    if (value.integerValue !== undefined) {
        const raw = String(value.integerValue);
        const parsed = Number(raw);

        return Number.isSafeInteger(parsed) ? parsed : raw;
    }

    if (value.doubleValue !== undefined) {
        return Number(value.doubleValue);
    }

    if (value.timestampValue !== undefined) {
        // Two encodings reach here. REST (`documents.list`) writes RFC-3339; the
        // Admin SDK's `_fieldsProto` — what the documented dump script reads —
        // writes the protobuf Timestamp, `{ seconds, nanos }`. Accepting only
        // the first made that script fail on every collection with a `createdAt`.
        //
        // Both truncate to milliseconds, and Firestore stores microseconds. That
        // is deliberate rather than overlooked: the target column is a Lunora
        // timestamp, which IS milliseconds, and returning the RFC-3339 string for
        // the sub-millisecond rows would make the column's type depend on its
        // data — number for most rows, string for a few — which no schema can
        // describe. An app that needs the rest should carry it in its own column.
        const parsed = typeof value.timestampValue === "string" ? Date.parse(value.timestampValue) : protoTimestampToMs(value.timestampValue);

        if (Number.isNaN(parsed)) {
            throw new LunoraError(
                "INTERNAL",
                `${path}: \`timestampValue\` ${JSON.stringify(value.timestampValue)} is neither an RFC-3339 string nor a \`{ seconds, nanos }\` protobuf timestamp`,
            );
        }

        return parsed;
    }

    if (value.bytesValue !== undefined) {
        // Base64 in the REST encoding, and base64 is what survives the NDJSON hop
        // unchanged. The Admin SDK holds a Buffer instead, which `JSON.stringify`
        // renders as `{ type: "Buffer", data: [...] }` — decoded back to base64
        // here so both dump shapes land on the same value.
        return typeof value.bytesValue === "string" ? value.bytesValue : bytesToBase64(value.bytesValue, path);
    }

    if (value.geoPointValue !== undefined) {
        return { latitude: value.geoPointValue.latitude ?? 0, longitude: value.geoPointValue.longitude ?? 0 };
    }

    if (value.referenceValue !== undefined) {
        // A plain string matches `v.id()`'s string-validating semantics; the last
        // segment is the referenced document's id, which is what a foreign key
        // needs to line up with the ids this importer preserves.
        return documentIdFromName(value.referenceValue);
    }

    if (value.arrayValue !== undefined) {
        return (value.arrayValue.values ?? []).map((entry, index) => decodeValue(entry, `${path}[${String(index)}]`));
    }

    if (value.mapValue !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- decodeValue and decodeFields are mutually recursive; one of the pair has to be named second
        return decodeFields(value.mapValue.fields ?? {}, path);
    }

    throw new LunoraError("INTERNAL", `${path}: unrecognised Firestore value ${JSON.stringify(value).slice(0, 80)}`);
};

/** Keys the wrapped (REST `Document`) form may carry alongside `fields`. */
const WRAPPED_DOCUMENT_KEYS = new Set(["createTime", "fields", "name", "readTime", "updateTime"]);

/** A Firestore `Value` is a one-key object whose key names the type (`stringValue`, `mapValue`, …). */
const isFirestoreValue = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const keys = Object.keys(value);

    return keys.length === 1 && keys[0]?.endsWith("Value") === true;
};

/**
 * Whether `raw` is the wrapped REST `Document` (`{ name, fields }`) rather than
 * a bare field map keyed by document id.
 *
 * `name` is the reliable signal — `documents.list` emits it even for a document
 * with no fields. Without one, a `fields` key is ambiguous: a BARE document may
 * itself have a field called `fields`. The tie-break is what that key holds. In
 * the wrapped form it is a map of name → `Value`; in the bare form it IS a
 * single `Value` (a one-key `{ …Value: … }` object). Anything alongside it that
 * is not wrapper metadata settles it as bare.
 */
const isWrappedDocument = (raw: Record<string, unknown>): boolean => {
    if (typeof raw["name"] === "string") {
        return true;
    }

    const { fields } = raw;

    if (typeof fields !== "object" || fields === null) {
        return false;
    }

    return Object.keys(raw).every((key) => WRAPPED_DOCUMENT_KEYS.has(key)) && !isFirestoreValue(fields);
};

/** Decode a `fields` map to a plain object. */
const decodeFields = (fields: Record<string, FirestoreValue>, path: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value, `${path}.${key}`)]));

/**
 * Decode one Firestore document to a Lunora document, preserving its id.
 *
 * Accepts both the wrapped form (`{ name, fields }`, as REST returns) and the
 * bare form (`{ field: value }` keyed by document id, as the community tools
 * write), because an operator will have whichever their tool produced.
 */
const toDocument = (
    raw: Record<string, unknown>,
    fallbackId: string | undefined,
    tableMapping: TableMapping | undefined,
    path: string,
): Record<string, unknown> => {
    // `documents.list` omits `fields` entirely for a document that has none, so
    // the presence of `name` is what identifies the wrapped form. Keying off
    // `fields` sent an empty document down the bare branch, where `decodeValue`
    // ran `"nullValue" in value` against the `name` string and threw
    // "Cannot use 'in' operator" — unactionable for the operator.
    const wrapped = isWrappedDocument(raw);
    const decoded = wrapped
        ? decodeFields((raw["fields"] ?? {}) as Record<string, FirestoreValue>, path)
        : decodeFields(raw as unknown as Record<string, FirestoreValue>, path);

    const name = raw["name"] ?? raw["__name__"];
    const id = typeof name === "string" ? documentIdFromName(name) : fallbackId;

    if (id === undefined) {
        throw new LunoraError("INTERNAL", `${path}: no document id — expected a \`name\`/\`__name__\` resource path, or a document keyed by its id`);
    }

    const types = tableMapping?.types ?? {};

    for (const [column, kind] of Object.entries(types)) {
        const current = decoded[column];

        if (current === undefined) {
            continue;
        }

        // A declared reshape re-reads the decoded value as text, so a field that
        // decoded to a map or array has no text form to reshape — say so rather
        // than handing `[object Object]` to the parser.
        if (current !== null && typeof current !== "boolean" && typeof current !== "number" && typeof current !== "string") {
            throw new LunoraError("INTERNAL", `${path}.${column}: a \`${kind}\` reshape needs a scalar, but this field decoded to an object or array`);
        }

        // eslint-disable-next-line unicorn/no-null -- `null` is the reshape contract's "this cell was NULL"
        decoded[column] = applyReshape(column, kind, current === null ? null : String(current));
    }

    return { ...decoded, _id: id };
};

/** Enumerate the per-collection files in a Firestore export directory. */
const listFirestoreCollections = async (directory: string, mapping: ImportSourceMapping | undefined): Promise<DumpFile[]> =>
    listDumpFiles(
        directory,
        mapping,
        {
            // The auth dump is not a collection — importing it as one would leak
            // credential material, exactly as on the Supabase side.
            authFiles: new Set(mapping?.auth?.file === undefined ? [] : [basename(mapping.auth.file)]),
            emptyMessage: "holds no .json/.ndjson collection files",
            matches: (name) => COLLECTION_FILE_RE.test(name),
            tableNameOf: (name) => name.replace(COLLECTION_FILE_RE, ""),
        },
        async (path) => readdir(path, { withFileTypes: true }),
    );

/**
 * Every document in an `.ndjson` collection file, one line at a time.
 *
 * The container shapes below (`[...]`, `{ documents: [...] }`, `{ id: {…} }`)
 * are single JSON values and have to be parsed whole. NDJSON does not: reading
 * the file into a string and then building an array of every document held two
 * full copies of a collection that can be tens of gigabytes.
 */
const streamNdjsonDocuments = async function* (file: string): AsyncGenerator<{ fallbackId?: string; raw: Record<string, unknown> }> {
    const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: createReadStream(file, "utf8") });
    let lineNumber = 0;

    try {
        for await (const line of lines) {
            lineNumber += 1;

            const trimmed = line.trim();

            if (trimmed.length === 0) {
                continue;
            }

            try {
                yield { raw: JSON.parse(trimmed) as Record<string, unknown> };
            } catch (error: unknown) {
                throw new LunoraError(
                    "INTERNAL",
                    `${basename(file)} line ${String(lineNumber)}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`,
                    {
                        cause: error,
                    },
                );
            }
        }
    } finally {
        lines.close();
    }
};

/** Every document in one collection file, in either container shape. */
const readCollectionDocuments = async (file: string): Promise<{ fallbackId?: string; raw: Record<string, unknown> }[]> => {
    const text = await readFile(file, "utf8");

    let parsed: unknown;

    try {
        parsed = JSON.parse(text);
    } catch (error: unknown) {
        throw new LunoraError("INTERNAL", `${basename(file)}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    // `{ documents: [...] }` is what REST `documents.list` returns.
    if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { documents?: unknown }).documents)) {
        return (parsed as { documents: Record<string, unknown>[] }).documents.map((raw) => {
            return { raw };
        });
    }

    if (Array.isArray(parsed)) {
        return parsed.map((raw) => {
            return { raw: raw as Record<string, unknown> };
        });
    }

    if (parsed !== null && typeof parsed === "object") {
        // `{ "<docId>": { …fields } }` — the community-tool shape, where the key
        // is the only place the id lives.
        return Object.entries(parsed as Record<string, unknown>).map(([fallbackId, raw]) => {
            return { fallbackId, raw: raw as Record<string, unknown> };
        });
    }

    throw new LunoraError("INTERNAL", `${basename(file)}: expected an object, an array, or \`{ documents: [...] }\``);
};

/** Decode one collection file into documents. */
const readFirestoreCollection = async function* (dumpFile: DumpFile, mapping: ImportSourceMapping | undefined): AsyncGenerator<Record<string, unknown>> {
    const tableMapping = mapping?.tables?.[dumpFile.table];
    const documents = dumpFile.file.toLowerCase().endsWith(".ndjson") ? streamNdjsonDocuments(dumpFile.file) : await readCollectionDocuments(dumpFile.file);
    let index = 0;

    for await (const entry of documents) {
        yield toDocument(entry.raw, entry.fallbackId, tableMapping, `${dumpFile.table}[${String(index)}]`);
        index += 1;
    }
};

/**
 * Stream a Firestore export as the `{ table, doc }` NDJSON the admin import
 * endpoint accepts.
 */
const readFirestoreExport = async function* (
    collections: ReadonlyArray<DumpFile>,
    mapping: ImportSourceMapping | undefined,
    logger: Logger,
    sourceRows: Map<string, number>,
    directory: string,
): AsyncGenerator<string> {
    yield* readAuthDump("firebase", directory, mapping, logger, sourceRows);
    yield* readDumpFiles(collections, logger, sourceRows, (dumpFile) => readFirestoreCollection(dumpFile, mapping));
};

export type { FirestoreValue };
export { decodeValue, documentIdFromName, listFirestoreCollections, readFirestoreExport, toDocument };
