import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import openZipEntryStream from "../../src/commands/zip-entry-stream";

const collect = async (stream: Readable | undefined): Promise<string> => {
    if (stream === undefined) {
        return "";
    }

    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks).toString("utf8");
};

describe("openZipEntryStream", () => {
    let workDir: string;

    beforeEach(async () => {
        workDir = await mkdtemp(join(tmpdir(), "lunora-zip-"));
    });

    afterEach(async () => {
        await rm(workDir, { force: true, recursive: true });
    });

    /** Write an archive and return its path plus the reopened entry list. */
    const buildZip = async (entries: [string, Buffer][], store = false): Promise<{ path: string; zip: AdmZip }> => {
        const zip = new AdmZip();

        for (const [name, data] of entries) {
            zip.addFile(name, data);
        }

        if (store) {
            for (const entry of zip.getEntries()) {
                entry.header.method = 0;
            }
        }

        const path = join(workDir, "snapshot.zip");

        await writeFile(path, zip.toBuffer());

        return { path, zip: new AdmZip(path) };
    };

    it("streams a deflated entry byte-for-byte", async () => {
        expect.assertions(1);

        // Larger than one inflate chunk, so a single-chunk read would truncate.
        const payload = Buffer.from(`${"x".repeat(200_000)}\nlast\n`);
        const { path, zip } = await buildZip([["t/documents.jsonl", payload]]);

        await expect(collect(await openZipEntryStream(path, zip.getEntry("t/documents.jsonl")!))).resolves.toBe(payload.toString("utf8"));
    });

    it("rejects an entry whose bytes do not match its CRC", async () => {
        expect.assertions(1);

        // The archive carries the checksum its writer computed. Without the
        // comparison a corrupted entry imports as data, with row counts that
        // still match — so `--verify` reports nothing either.
        const payload = Buffer.from("a\nb\nc\n");
        const { path, zip } = await buildZip([["t/documents.jsonl", payload]]);
        const entry = zip.getEntry("t/documents.jsonl")!;

        entry.header.crc = entry.header.crc === 0 ? 1 : 0;

        await expect(collect(await openZipEntryStream(path, entry))).rejects.toThrow(/failed its CRC check/u);
    });

    it("streams a stored (uncompressed) entry", async () => {
        expect.assertions(1);

        const payload = Buffer.from("a\nb\nc\n");
        const { path, zip } = await buildZip([["t/documents.jsonl", payload]], true);

        await expect(collect(await openZipEntryStream(path, zip.getEntry("t/documents.jsonl")!))).resolves.toBe("a\nb\nc\n");
    });

    it("reads the second entry from its own local header, not the first's", async () => {
        expect.assertions(1);

        // The local-header offset arithmetic is what this guards: a wrong skip
        // reads the neighbouring entry's bytes and inflates to garbage.
        const { path, zip } = await buildZip([
            ["a/documents.jsonl", Buffer.from("first\n")],
            ["b/documents.jsonl", Buffer.from("second\n")],
        ]);

        await expect(collect(await openZipEntryStream(path, zip.getEntry("b/documents.jsonl")!))).resolves.toBe("second\n");
    });

    it("returns undefined for an empty entry rather than a zero-length read", async () => {
        expect.assertions(1);

        const { path, zip } = await buildZip([["t/documents.jsonl", Buffer.alloc(0)]]);

        await expect(openZipEntryStream(path, zip.getEntry("t/documents.jsonl")!)).resolves.toBeUndefined();
    });

    it("rejects an unsupported compression method instead of emitting garbage", async () => {
        expect.assertions(1);

        const { path, zip } = await buildZip([["t/documents.jsonl", Buffer.from("a\n")]]);
        const entry = zip.getEntry("t/documents.jsonl")!;

        entry.header.method = 14;

        await expect(openZipEntryStream(path, entry)).rejects.toThrow(/unsupported compression method 14/);
    });

    it("rejects an encrypted entry", async () => {
        expect.assertions(1);

        const { path, zip } = await buildZip([["t/documents.jsonl", Buffer.from("a\n")]]);
        const entry = zip.getEntry("t/documents.jsonl")!;

        Object.defineProperty(entry.header, "encrypted", { value: true });

        await expect(openZipEntryStream(path, entry)).rejects.toThrow(/is encrypted/);
    });

    it("reports a corrupt local header rather than streaming the wrong bytes", async () => {
        expect.assertions(1);

        const { path, zip } = await buildZip([["t/documents.jsonl", Buffer.from("a\n")]]);
        const entry = zip.getEntry("t/documents.jsonl")!;

        entry.header.offset = 4;

        await expect(openZipEntryStream(path, entry)).rejects.toThrow(/no local file header/);
    });
});
