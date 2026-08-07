/**
 * Streaming one entry out of a ZIP archive.
 *
 * `adm-zip` reads an entry by inflating it whole into a `Buffer` — fine for a
 * blob the importer is about to upload anyway, fatal for a `documents.jsonl`
 * that can be gigabytes. The directory-snapshot path already streams its tables
 * line by line; this is what lets the ZIP path do the same, so a snapshot's
 * shape stops deciding whether the import fits in memory.
 *
 * The archive's central directory has already been parsed by `adm-zip`, which
 * is where the entry's local-header offset comes from. All that is left is to
 * skip the local header (whose name/extra lengths may legitimately differ from
 * the central copy, so they are read from the local header itself) and pipe the
 * entry's byte range through `zlib`.
 */
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

import type { IZipEntry } from "adm-zip";

/** `PK\x03\x04` — the local file header signature. */
const LOCAL_HEADER_SIGNATURE = 0x04_03_4b_50;
const LOCAL_HEADER_BYTES = 30;
const LOCAL_NAME_LENGTH_OFFSET = 26;
const LOCAL_EXTRA_LENGTH_OFFSET = 28;

/** Compression methods this reader can stream. */
const STORED = 0;
const DEFLATED = 8;

/**
 * Byte range of one entry's compressed data, read from its local file header.
 *
 * The local header is authoritative for the name and extra-field lengths: a
 * writer may store different extra fields locally than centrally, and taking the
 * central lengths would start the read a few bytes into the payload.
 */
const readDataRange = async (zipPath: string, offset: number): Promise<number> => {
    const handle = await open(zipPath, "r");

    try {
        const header = Buffer.alloc(LOCAL_HEADER_BYTES);
        const { bytesRead } = await handle.read(header, 0, LOCAL_HEADER_BYTES, offset);

        if (bytesRead < LOCAL_HEADER_BYTES || header.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
            throw new Error(`${zipPath}: no local file header at offset ${String(offset)} — the archive is truncated or corrupt`);
        }

        return offset + LOCAL_HEADER_BYTES + header.readUInt16LE(LOCAL_NAME_LENGTH_OFFSET) + header.readUInt16LE(LOCAL_EXTRA_LENGTH_OFFSET);
    } finally {
        await handle.close();
    }
};

/**
 * A `Readable` of one entry's decompressed bytes.
 *
 * Returns `undefined` for an empty entry, which has no byte range to read and
 * whose caller wants an empty stream rather than a zero-length file read.
 */
const openZipEntryStream = async (zipPath: string, entry: IZipEntry): Promise<Readable | undefined> => {
    const { compressedSize, encrypted, method, offset } = entry.header;

    if (encrypted) {
        throw new Error(`${entry.entryName} is encrypted — decrypt the archive before importing`);
    }

    if (method !== STORED && method !== DEFLATED) {
        throw new Error(`${entry.entryName} uses unsupported compression method ${String(method)} — re-create the archive with standard deflate`);
    }

    if (compressedSize === 0) {
        return undefined;
    }

    const start = await readDataRange(zipPath, offset);
    const compressed = createReadStream(zipPath, { end: start + compressedSize - 1, start });

    if (method === STORED) {
        return compressed;
    }

    const inflate = createInflateRaw();

    // `pipe` alone drops a read error on the floor: the inflater would simply
    // end, and a truncated table would import as a short one.
    compressed.on("error", (error) => inflate.destroy(error));

    return compressed.pipe(inflate);
};

export default openZipEntryStream;
