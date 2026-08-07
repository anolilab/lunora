import { describe, expect, it } from "vitest";

import { indexTransferredPaths, resolveStoragePath } from "../../src/commands/data-transfer/storage-path-index";

const transfer = (...entries: [string, string][]): Map<string, string> => new Map(entries);

describe("indexTransferredPaths", () => {
    it("resolves the bucket-qualified path the listing produced", () => {
        expect.assertions(1);

        const index = indexTransferredPaths(transfer(["avatars/u1.png", "blobs/aa11"]));

        expect(resolveStoragePath("avatars/u1.png", index)).toBe("blobs/aa11");
    });

    it("resolves a bucket-relative name when only one bucket carries it", () => {
        expect.assertions(2);

        const index = indexTransferredPaths(transfer(["avatars/u1.png", "blobs/aa11"], ["docs/report.pdf", "blobs/bb22"]));

        expect(resolveStoragePath("u1.png", index)).toBe("blobs/aa11");
        expect(resolveStoragePath("report.pdf", index)).toBe("blobs/bb22");
    });

    it("refuses a bucket-relative name two buckets share rather than guess", () => {
        expect.assertions(3);

        const index = indexTransferredPaths(transfer(["avatars/logo.png", "blobs/aa11"], ["brand/logo.png", "blobs/bb22"]));

        // Picking either would rewrite half the rows at the wrong object; an
        // unresolved path is reported and the operator qualifies the column.
        expect(resolveStoragePath("logo.png", index)).toBeUndefined();
        expect(resolveStoragePath("avatars/logo.png", index)).toBe("blobs/aa11");
        expect(resolveStoragePath("brand/logo.png", index)).toBe("blobs/bb22");
    });

    it("never lets a relative name shadow an object literally keyed by it", () => {
        expect.assertions(1);

        const index = indexTransferredPaths(transfer(["u1.png", "blobs/root"], ["avatars/u1.png", "blobs/nested"]));

        expect(resolveStoragePath("u1.png", index)).toBe("blobs/root");
    });

    it("resolves a getPublicUrl() value, which is what most apps store", () => {
        expect.assertions(1);

        const index = indexTransferredPaths(transfer(["avatars/u1.png", "blobs/aa11"]));

        expect(resolveStoragePath("https://abc.supabase.co/storage/v1/object/public/avatars/u1.png", index)).toBe("blobs/aa11");
    });

    it("resolves a signed URL, dropping its token query", () => {
        expect.assertions(1);

        const index = indexTransferredPaths(transfer(["docs/q3 report.pdf", "blobs/bb22"]));

        expect(resolveStoragePath("https://abc.supabase.co/storage/v1/object/sign/docs/q3%20report.pdf?token=ey.aa.bb", index)).toBe("blobs/bb22");
    });

    it("resolves an authenticated URL", () => {
        expect.assertions(1);

        const index = indexTransferredPaths(transfer(["private/x.bin", "blobs/cc33"]));

        expect(resolveStoragePath("https://abc.supabase.co/storage/v1/object/authenticated/private/x.bin", index)).toBe("blobs/cc33");
    });

    it("tolerates a leading slash on either side of the lookup", () => {
        expect.assertions(1);

        const index = indexTransferredPaths(transfer(["avatars/u1.png", "blobs/aa11"]));

        expect(resolveStoragePath("/avatars/u1.png", index)).toBe("blobs/aa11");
    });

    it("leaves an unrelated string unresolved", () => {
        expect.assertions(2);

        const index = indexTransferredPaths(transfer(["avatars/u1.png", "blobs/aa11"]));

        expect(resolveStoragePath("hello world", index)).toBeUndefined();
        expect(resolveStoragePath("https://example.com/avatars/u1.png", index)).toBeUndefined();
    });

    it("survives a malformed percent-escape in a URL", () => {
        expect.assertions(1);

        const index = indexTransferredPaths(transfer(["docs/100%.pdf", "blobs/dd44"]));

        expect(resolveStoragePath("https://abc.supabase.co/storage/v1/object/public/docs/100%.pdf", index)).toBe("blobs/dd44");
    });
});
