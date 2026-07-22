/**
 * Coverage for the `@lunora/react/upload` hook re-exports (Phase 2 of the
 * client upload SDK).
 *
 * The full resumable client↔server flow — progress, pause/resume, resume after a
 * dropped connection, RLS enforcement — is proven against the real
 * `@visulima/storage-client` adapter in `@lunora/storage`'s
 * `upload-handler.test.ts`. Here we assert the React layer: that the upload hooks
 * are re-exported and mount with the documented control surface, so a Lunora app
 * gets `useUpload` & friends from `@lunora/react/upload` (or the package root)
 * with no extra `QueryClientProvider` wiring.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RestrictionError, UploadControl, UploadError, useChunkedRestUpload, useMultipartUpload, useTusUpload, useUpload } from "../src/upload";

const ENDPOINT = "https://test.local/upload";

describe("@lunora/react/upload", () => {
    it("re-exports the control handle and typed errors", () => {
        expect.hasAssertions();

        expect(typeof UploadControl).toBe("function");
        expect(UploadError.prototype).toBeInstanceOf(Error);
        expect(RestrictionError.prototype).toBeInstanceOf(Error);

        // The control handle exposes the pause/resume/abort surface the upload
        // hooks steer.
        const control = new UploadControl();

        expect(typeof control.pause).toBe("function");
        expect(typeof control.resume).toBe("function");
        expect(typeof control.abort).toBe("function");
    });

    it("mounts useUpload with the auto-selecting upload API", () => {
        expect.hasAssertions();

        const { result } = renderHook(() => useUpload({ endpointTus: ENDPOINT }));

        expect(typeof result.current.upload).toBe("function");
        expect(result.current.isUploading).toBe(false);
        expect(result.current.progress).toBe(0);
    });

    it("mounts useTusUpload with progress + pause/resume controls (no QueryClientProvider needed)", () => {
        expect.hasAssertions();

        // Rendering with no provider proves the reconciliation claim: the upload
        // hooks never touch TanStack Query, so they work outside a QueryClient.
        const { result } = renderHook(() => useTusUpload({ endpoint: ENDPOINT }));

        expect(typeof result.current.upload).toBe("function");
        expect(typeof result.current.pause).toBe("function");
        expect(typeof result.current.resume).toBe("function");
        expect(result.current.progress).toBe(0);
        expect(result.current.isUploading).toBe(false);
    });

    it("mounts useMultipartUpload and useChunkedRestUpload", () => {
        expect.hasAssertions();

        const { result: multipart } = renderHook(() => useMultipartUpload({ endpoint: ENDPOINT }));
        const { result: chunked } = renderHook(() => useChunkedRestUpload({ endpoint: ENDPOINT }));

        expect(typeof multipart.current.upload).toBe("function");
        expect(typeof chunked.current.upload).toBe("function");
        expect(chunked.current.progress).toBe(0);
    });
});
