/**
 * The download link on its own: signing, the checks the route makes before it reads a file, and the
 * response it writes. The route's wiring and the export that fills the table are covered in
 * `privacy.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FileLink, StoredFile } from "../lunora/privacy-files";
import { fileResponse, signFileLink } from "../lunora/privacy-files";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const ARCHIVE_KEY = "request-1/export.zip";
const ZIP_BYTES = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x00, 0xff);

const storedZip: StoredFile = { body: Buffer.from(ZIP_BYTES).toString("base64"), encoding: "base64", name: "export.zip" };

/** The query parameters of a link, the way the route reads them from the request URL. */
const linkParams = (path: string): FileLink => {
    const params = new URL(path, "http://localhost").searchParams;

    return { exp: params.get("exp"), key: params.get("key"), sig: params.get("sig") };
};

const read = (file: StoredFile | undefined) => (key: string) => Promise.resolve(key === ARCHIVE_KEY ? file : undefined);

describe("download links", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("serves the archive bytes for a fresh link, with a zip content type and a download filename", async () => {
        expect.assertions(4);

        const link = linkParams(await signFileLink(ARCHIVE_KEY, 600, NOW));
        const response = await fileResponse(link, NOW + 1000, read(storedZip));

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/zip");
        expect(response.headers.get("content-disposition")).toBe('attachment; filename="export.zip"');
        expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(ZIP_BYTES);
    });

    it("refuses a link once its time has passed", async () => {
        expect.assertions(1);

        const link = linkParams(await signFileLink(ARCHIVE_KEY, 60, NOW));

        await expect(fileResponse(link, NOW + 61_000, read(storedZip))).resolves.toMatchObject({ status: 404 });
    });

    it("refuses a link whose key or expiry was edited after signing", async () => {
        expect.assertions(2);

        const link = linkParams(await signFileLink(ARCHIVE_KEY, 600, NOW));

        await expect(fileResponse({ ...link, key: "request-2/export.zip" }, NOW, read(storedZip))).resolves.toMatchObject({ status: 404 });
        await expect(fileResponse({ ...link, exp: String(Number(link.exp) + 3600) }, NOW, read(storedZip))).resolves.toMatchObject({ status: 404 });
    });

    it("refuses a link with no signature, a malformed one, or none at all", async () => {
        expect.assertions(3);

        const link = linkParams(await signFileLink(ARCHIVE_KEY, 600, NOW));

        await expect(fileResponse({ ...link, sig: null }, NOW, read(storedZip))).resolves.toMatchObject({ status: 404 });
        await expect(fileResponse({ ...link, sig: "not-hex" }, NOW, read(storedZip))).resolves.toMatchObject({ status: 404 });
        await expect(fileResponse({ exp: null, key: null, sig: null }, NOW, read(storedZip))).resolves.toMatchObject({ status: 404 });
    });

    it("answers 404 for a valid link to a file that is not stored", async () => {
        expect.assertions(1);

        const link = linkParams(await signFileLink(ARCHIVE_KEY, 600, NOW));

        await expect(fileResponse(link, NOW, read(undefined))).resolves.toMatchObject({ status: 404 });
    });

    it("refuses to sign a link without a secret, and refuses every existing link", async () => {
        expect.assertions(2);

        const link = linkParams(await signFileLink(ARCHIVE_KEY, 600, NOW));

        vi.stubEnv("PRIVACY_FILE_SECRET", "");

        await expect(signFileLink(ARCHIVE_KEY, 600, NOW)).rejects.toMatchObject({ code: "INTERNAL" });
        await expect(fileResponse(link, NOW, read(storedZip))).resolves.toMatchObject({ status: 404 });
    });

    it("sanitises the download filename so a stored name cannot break the header", async () => {
        expect.assertions(1);

        const link = linkParams(await signFileLink(ARCHIVE_KEY, 600, NOW));
        const hostile: StoredFile = { body: "a,b", encoding: "text", name: 'x"; filename=evil\r\n.csv' };
        const response = await fileResponse(link, NOW, read(hostile));

        expect(response.headers.get("content-disposition")).toBe('attachment; filename="x___filename_evil__.csv"');
    });
});
