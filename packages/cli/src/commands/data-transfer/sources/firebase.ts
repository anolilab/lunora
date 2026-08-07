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
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { LunoraError } from "@lunora/errors";

import type { Logger } from "../../../util/logger";
import type { ImportSourceMapping, TableMapping } from "./mapping";
import { applyReshape } from "./reshape";

/** One collection's file in a Firestore export directory. */
interface FirestoreCollectionFile {
    file: string;
    table: string;
}

/** A Firestore typed value, as the REST/RPC JSON encoding writes it. */
interface FirestoreValue {
    arrayValue?: { values?: FirestoreValue[] };
    booleanValue?: boolean;
    bytesValue?: string;
    doubleValue?: number | string;
    geoPointValue?: { latitude?: number; longitude?: number };
    integerValue?: number | string;
    mapValue?: { fields?: Record<string, FirestoreValue> };
    nullValue?: null;
    referenceValue?: string;
    stringValue?: string;
    timestampValue?: string;
}

/** The document id is the last segment of `projects/…/documents/<collection>/<id>`. */
const COLLECTION_FILE_RE = /\.(?:nd)?json$/i;

const documentIdFromName = (name: string): string => {
    const segments = name.split("/").filter((segment) => segment.length > 0);

    return segments[segments.length - 1] ?? name;
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
        const parsed = Date.parse(value.timestampValue);

        if (Number.isNaN(parsed)) {
            throw new LunoraError("INTERNAL", `${path}: \`timestampValue\` ${JSON.stringify(value.timestampValue)} is not an RFC-3339 timestamp`);
        }

        return parsed;
    }

    if (value.bytesValue !== undefined) {
        // Already base64 in the wire encoding, and base64 is what survives the
        // NDJSON hop unchanged.
        return value.bytesValue;
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
    const wrapped = raw["fields"] !== undefined && typeof raw["fields"] === "object";
    const decoded = wrapped
        ? decodeFields(raw["fields"] as Record<string, FirestoreValue>, path)
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
const listFirestoreCollections = async (directory: string, mapping: ImportSourceMapping | undefined): Promise<FirestoreCollectionFile[]> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);

    if (entries === undefined) {
        throw new LunoraError("INTERNAL", `${directory} is not a readable directory of Firestore collection exports`);
    }

    const claimed = new Map<string, string>();

    for (const [table, tableMapping] of Object.entries(mapping?.tables ?? {})) {
        if (tableMapping.file !== undefined) {
            claimed.set(tableMapping.file, table);
        }
    }

    const found = entries
        .filter((entry) => entry.isFile() && COLLECTION_FILE_RE.test(entry.name))
        .map((entry) => {
            return { file: join(directory, entry.name), table: claimed.get(entry.name) ?? entry.name.replace(COLLECTION_FILE_RE, "") };
        });

    if (found.length === 0) {
        throw new LunoraError("INTERNAL", `${directory} holds no .json/.ndjson collection files`);
    }

    return found.toSorted((a, b) => a.table.localeCompare(b.table));
};

/** Every document in one collection file, in either container shape. */
const readCollectionDocuments = async (file: string): Promise<{ fallbackId?: string; raw: Record<string, unknown> }[]> => {
    const text = await readFile(file, "utf8");

    if (file.toLowerCase().endsWith(".ndjson")) {
        return text
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line, index) => {
                try {
                    return { raw: JSON.parse(line) as Record<string, unknown> };
                } catch (error: unknown) {
                    throw new LunoraError(
                        "INTERNAL",
                        `${basename(file)} line ${String(index + 1)}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`,
                        {
                            cause: error,
                        },
                    );
                }
            });
    }

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

/**
 * Stream a Firestore export as the `{ table, doc }` NDJSON the admin import
 * endpoint accepts.
 */
const readFirestoreExport = async function* (
    collections: ReadonlyArray<FirestoreCollectionFile>,
    mapping: ImportSourceMapping | undefined,
    logger: Logger,
    sourceRows: Map<string, number>,
): AsyncGenerator<string> {
    for (const collection of collections) {
        if (!sourceRows.has(collection.table)) {
            sourceRows.set(collection.table, 0);
        }

        logger.info(`reading ${basename(collection.file)} → ${collection.table}`);

        // eslint-disable-next-line no-await-in-loop -- one collection file at a time
        const documents = await readCollectionDocuments(collection.file);
        const tableMapping = mapping?.tables?.[collection.table];

        for (const [index, entry] of documents.entries()) {
            const document = toDocument(entry.raw, entry.fallbackId, tableMapping, `${collection.table}[${String(index)}]`);

            sourceRows.set(collection.table, (sourceRows.get(collection.table) ?? 0) + 1);

            yield `${JSON.stringify({ doc: document, table: collection.table })}\n`;
        }
    }
};

export type { FirestoreCollectionFile, FirestoreValue };
export { decodeValue, documentIdFromName, listFirestoreCollections, readFirestoreExport, toDocument };
