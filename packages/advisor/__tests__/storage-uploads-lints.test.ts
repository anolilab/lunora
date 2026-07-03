import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import storageGenerateUploadUrlNoContentTypePin from "../src/lints/static/storage-generate-upload-url-no-content-type-pin";
import storagePresignedUrlForPrivateContent from "../src/lints/static/storage-presigned-url-for-private-content";
import storageUploadWithoutContentTypeAllowlist from "../src/lints/static/storage-upload-without-content-type-allowlist";
import storageUploadWithoutMaxSize from "../src/lints/static/storage-upload-without-max-size";
import type { AdvisorStorageUpload } from "../src/storage-uploads";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

const rows: AdvisorStorageUpload[] = [
    // upload with no guards → flagged by both allowlist and max-size.
    { analyzable: true, exportName: "save", file: "upload", line: 3, method: "upload", presentKeys: [] },
    // store fully guarded → flagged by neither.
    { analyzable: true, exportName: "safe", file: "store", line: 5, method: "store", presentKeys: ["allowedContentTypes", "maxSize"] },
    // non-analyzable upload (opaque options object) → skipped by both.
    { analyzable: false, exportName: "opaque", file: "opaque", line: 7, method: "upload", presentKeys: [] },
    // generateUploadUrl with no contentType pin → flagged by the pin lint.
    { analyzable: true, exportName: "mint", file: "sign", line: 9, method: "generateUploadUrl", presentKeys: [] },
    // generateUploadUrl WITH contentType → not flagged.
    { analyzable: true, exportName: "pinned", file: "sign", line: 11, method: "generateUploadUrl", presentKeys: ["contentType"] },
    // native S3 presigned URL → flagged by the presigned lint.
    { analyzable: true, exportName: "native", file: "presign", line: 13, method: "getPresignedUrl", presentKeys: [] },
    // worker-signed URL with a near-ceiling TTL → flagged by the presigned lint.
    {
        analyzable: true,
        expiresInSeconds: 604_800,
        exportName: "longlived",
        file: "presign",
        line: 15,
        method: "getSignedUrl",
        presentKeys: ["expiresInSeconds"],
    },
    // worker-signed URL with a short TTL → not flagged.
    { analyzable: true, expiresInSeconds: 300, exportName: "shortlived", file: "presign", line: 17, method: "getSignedUrl", presentKeys: ["expiresInSeconds"] },
];

describe("storage_upload_without_content_type_allowlist", () => {
    it("flags only the analyzable upload/store call missing allowedContentTypes", () => {
        expect.assertions(3);

        const findings = storageUploadWithoutContentTypeAllowlist.run({ schema: schema(), storageUploads: rows });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "WARN",
            metadata: { exportName: "save", file: "upload", line: 3, method: "upload" },
            name: "storage_upload_without_content_type_allowlist",
        });
        expect(findings[0]?.detail).toContain("allowedContentTypes");
    });

    it("returns [] when storageUploads is undefined", () => {
        expect.assertions(1);

        expect(storageUploadWithoutContentTypeAllowlist.run({ schema: schema() })).toHaveLength(0);
    });
});

describe("storage_upload_without_max_size", () => {
    it("flags only the analyzable upload/store call missing maxSize", () => {
        expect.assertions(3);

        const findings = storageUploadWithoutMaxSize.run({ schema: schema(), storageUploads: rows });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "WARN",
            metadata: { exportName: "save", file: "upload", line: 3, method: "upload" },
            name: "storage_upload_without_max_size",
        });
        expect(findings[0]?.detail).toContain("maxSize");
    });

    it("returns [] when storageUploads is undefined", () => {
        expect.assertions(1);

        expect(storageUploadWithoutMaxSize.run({ schema: schema() })).toHaveLength(0);
    });
});

describe("storage_generate_upload_url_no_content_type_pin", () => {
    it("flags only the generateUploadUrl call missing a contentType pin", () => {
        expect.assertions(3);

        const findings = storageGenerateUploadUrlNoContentTypePin.run({ schema: schema(), storageUploads: rows });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "WARN",
            metadata: { exportName: "mint", file: "sign", line: 9 },
            name: "storage_generate_upload_url_no_content_type_pin",
        });
        expect(findings[0]?.detail).toContain("contentType");
    });

    it("returns [] when storageUploads is undefined", () => {
        expect.assertions(1);

        expect(storageGenerateUploadUrlNoContentTypePin.run({ schema: schema() })).toHaveLength(0);
    });
});

describe("storage_presigned_url_for_private_content", () => {
    it("flags a native presigned URL and a near-ceiling signed URL, but not a short-TTL signed URL", () => {
        expect.assertions(3);

        const findings = storagePresignedUrlForPrivateContent.run({ schema: schema(), storageUploads: rows });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({ metadata: { exportName: "native", method: "getPresignedUrl" }, name: "storage_presigned_url_for_private_content" });
        expect(findings[1]).toMatchObject({ metadata: { exportName: "longlived", method: "getSignedUrl" }, name: "storage_presigned_url_for_private_content" });
    });

    it("returns [] when storageUploads is undefined", () => {
        expect.assertions(1);

        expect(storagePresignedUrlForPrivateContent.run({ schema: schema() })).toHaveLength(0);
    });
});
