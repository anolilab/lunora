/**
 * Coverage for `@lunora/angular/upload`.
 *
 * The full resumable client-to-server flow — progress, pause/resume, resume
 * after a dropped connection, RLS enforcement — is proven against the real
 * `@visulima/storage-client` adapter in `@lunora/storage`'s
 * `upload-handler.test.ts` (and transitively via `@lunora/client/upload`).
 * Here we assert the Angular layer only: that `upload()` mounts with the
 * documented signal surface and correctly wires the adapter's callback-based
 * lifecycle into signals — mirroring `@lunora/react/upload`'s test scope,
 * which defers the real network flow the same way.
 */
import { describe, expect, it, vi } from "vitest";

import { createFakeDestroyRef } from "./fake-client";

type ProgressCallback = ((progress: number, offset: number) => void) | undefined;
type ResultCallback = ((result: { key: string }) => void) | undefined;
type ErrorCallback = ((error: Error) => void) | undefined;

interface FakeAdapter {
    abort: ReturnType<typeof vi.fn>;
    isPaused: () => boolean;
    onError: ErrorCallback;
    onFinish: ResultCallback;
    onProgress: ProgressCallback;
    onStart: (() => void) | undefined;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    setOnError: (callback: ErrorCallback) => void;
    setOnFinish: (callback: ResultCallback) => void;
    setOnProgress: (callback: ProgressCallback) => void;
    setOnStart: (callback: (() => void) | undefined) => void;
    upload: ReturnType<typeof vi.fn>;
}

const createFakeAdapter = (): FakeAdapter => {
    const adapter: FakeAdapter = {
        abort: vi.fn<() => void>(),
        isPaused: () => false,
        onError: undefined,
        onFinish: undefined,
        onProgress: undefined,
        onStart: undefined,
        pause: vi.fn<() => void>(),
        resume: vi.fn<() => Promise<void>>(async () => undefined),
        setOnError: (callback) => {
            adapter.onError = callback;
        },
        setOnFinish: (callback) => {
            adapter.onFinish = callback;
        },
        setOnProgress: (callback) => {
            adapter.onProgress = callback;
        },
        setOnStart: (callback) => {
            adapter.onStart = callback;
        },
        upload: vi.fn<(file: File) => Promise<{ key: string }>>(async () => {
            return { key: "uploads/test" };
        }),
    };

    return adapter;
};

let fakeAdapter: FakeAdapter;

// `FakeAdapter` is deliberately narrower than the real `TusAdapter`/
// `ChunkedRestAdapter` union (no `clear`/`getOffset` — `upload.ts`'s own
// `ResumableUploadAdapter` doesn't use them either), so the typed
// `vi.mock(import(...), factory)` form's structural check against the real
// module doesn't apply cleanly here; the untyped string form says exactly
// what's being replaced without the mismatch.
// eslint-disable-next-line vitest/prefer-import-in-mock -- see above
vi.mock("@lunora/client/upload", () => {
    return {
        createUpload: (): FakeAdapter => fakeAdapter,
    };
});

// Imported after the mock so `upload.ts`'s `import { createUpload }` binds to
// the fake above rather than the real TUS/chunked-REST network adapter.
const { upload } = await import("../src/upload");

const flushAsync = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

describe(upload, () => {
    it("mounts with idle status, zero progress, and no result/error", () => {
        expect.assertions(6);

        fakeAdapter = createFakeAdapter();
        const destroy = createFakeDestroyRef();

        const handle = upload({ destroyRef: destroy.asDestroyRef, endpoint: "https://test.local/upload" });

        expect(handle.status()).toBe("idle");
        expect(handle.progress()).toBe(0);
        expect(handle.result()).toBeUndefined();
        expect(handle.error()).toBeUndefined();
        expect(handle.isPaused()).toBe(false);
        expect(handle.start).toBeTypeOf("function");
    });

    it("wires the adapter's start/progress/finish callbacks into the status/progress/result signals", () => {
        expect.assertions(4);

        fakeAdapter = createFakeAdapter();
        const destroy = createFakeDestroyRef();

        const handle = upload({ destroyRef: destroy.asDestroyRef, endpoint: "https://test.local/upload" });

        fakeAdapter.onStart?.();

        expect(handle.status()).toBe("uploading");

        fakeAdapter.onProgress?.(42, 4200);

        expect(handle.progress()).toBe(42);

        fakeAdapter.onFinish?.({ key: "uploads/test" });

        expect(handle.status()).toBe("success");
        expect(handle.result()).toStrictEqual({ key: "uploads/test" });
    });

    it("wires the adapter's error callback into the error/status signals", () => {
        expect.assertions(2);

        fakeAdapter = createFakeAdapter();
        const destroy = createFakeDestroyRef();

        const handle = upload({ destroyRef: destroy.asDestroyRef, endpoint: "https://test.local/upload" });

        fakeAdapter.onError?.(new Error("upload failed"));

        expect(handle.status()).toBe("error");
        expect(handle.error()?.message).toBe("upload failed");
    });

    it("start() delegates to the adapter's upload(file)", async () => {
        expect.assertions(2);

        fakeAdapter = createFakeAdapter();
        const destroy = createFakeDestroyRef();

        const handle = upload({ destroyRef: destroy.asDestroyRef, endpoint: "https://test.local/upload" });
        const file = new File(["hello"], "hello.txt");

        await expect(handle.start(file)).resolves.toStrictEqual({ key: "uploads/test" });
        expect(fakeAdapter.upload).toHaveBeenCalledWith(file);
    });

    it("pause()/resume() delegate to the adapter and flip isPaused/status", async () => {
        expect.assertions(4);

        fakeAdapter = createFakeAdapter();
        const destroy = createFakeDestroyRef();

        const handle = upload({ destroyRef: destroy.asDestroyRef, endpoint: "https://test.local/upload" });

        // `pause()` is a no-op unless an upload is in flight — drive the
        // adapter's start callback first so `status() === "uploading"` before
        // pausing (see the `pause()`/`resume()` in-flight guard added below).
        fakeAdapter.onStart?.();

        handle.pause();

        expect(fakeAdapter.pause).toHaveBeenCalledTimes(1);
        expect(handle.isPaused()).toBe(true);
        expect(handle.status()).toBe("paused");

        handle.resume();
        await flushAsync();

        expect(handle.isPaused()).toBe(false);
    });

    it("aborts the adapter when the owning DestroyRef fires", () => {
        expect.assertions(1);

        fakeAdapter = createFakeAdapter();
        const destroy = createFakeDestroyRef();

        upload({ destroyRef: destroy.asDestroyRef, endpoint: "https://test.local/upload" });

        destroy.destroy();

        expect(fakeAdapter.abort).toHaveBeenCalledTimes(1);
    });

    it("retry after error clears the previous attempt's terminal signals", () => {
        expect.assertions(5);

        fakeAdapter = createFakeAdapter();
        const destroy = createFakeDestroyRef();

        const handle = upload({ destroyRef: destroy.asDestroyRef, endpoint: "https://test.local/upload" });
        const file1 = new File(["one"], "one.txt");
        const file2 = new File(["two"], "two.txt");

        handle.start(file1).catch(() => undefined);
        fakeAdapter.onStart?.();
        fakeAdapter.onProgress?.(50, 5000);
        fakeAdapter.onError?.(new Error("network drop"));

        expect(handle.status()).toBe("error");
        expect(handle.error()?.message).toBe("network drop");

        // A fresh `start()` is a new attempt — it must clear the stale error,
        // result, and progress from the failed attempt immediately, not wait
        // for the adapter's own `onStart` tick.
        handle.start(file2).catch(() => undefined);

        expect(handle.error()).toBeUndefined();
        expect(handle.result()).toBeUndefined();
        expect(handle.progress()).toBe(0);
    });

    it("success after retry carries no stale error", () => {
        expect.assertions(3);

        fakeAdapter = createFakeAdapter();
        const destroy = createFakeDestroyRef();

        const handle = upload({ destroyRef: destroy.asDestroyRef, endpoint: "https://test.local/upload" });
        const file1 = new File(["one"], "one.txt");
        const file2 = new File(["two"], "two.txt");

        handle.start(file1).catch(() => undefined);
        fakeAdapter.onError?.(new Error("network drop"));

        handle.start(file2).catch(() => undefined);
        fakeAdapter.onFinish?.({ key: "uploads/two" });

        expect(handle.status()).toBe("success");
        expect(handle.result()).toStrictEqual({ key: "uploads/two" });
        expect(handle.error()).toBeUndefined();
    });

    it("restart after success clears the previous result and progress", () => {
        expect.assertions(2);

        fakeAdapter = createFakeAdapter();
        const destroy = createFakeDestroyRef();

        const handle = upload({ destroyRef: destroy.asDestroyRef, endpoint: "https://test.local/upload" });
        const file1 = new File(["one"], "one.txt");
        const file2 = new File(["two"], "two.txt");

        handle.start(file1).catch(() => undefined);
        fakeAdapter.onProgress?.(100, 10_000);
        fakeAdapter.onFinish?.({ key: "uploads/one" });

        handle.start(file2).catch(() => undefined);

        expect(handle.result()).toBeUndefined();
        expect(handle.progress()).toBe(0);
    });

    it("pause()/resume() are no-ops outside an in-flight upload", () => {
        expect.assertions(6);

        fakeAdapter = createFakeAdapter();
        const destroy = createFakeDestroyRef();

        const handle = upload({ destroyRef: destroy.asDestroyRef, endpoint: "https://test.local/upload" });

        // Fresh handle: idle. Neither action has anything to act on.
        handle.pause();

        expect(fakeAdapter.pause).not.toHaveBeenCalled();
        expect(handle.status()).toBe("idle");
        expect(handle.isPaused()).toBe(false);

        handle.resume();

        expect(fakeAdapter.resume).not.toHaveBeenCalled();

        // Terminal (success) state: pause() must not stamp "paused" over it.
        handle.start(new File(["one"], "one.txt")).catch(() => undefined);
        fakeAdapter.onFinish?.({ key: "uploads/one" });

        handle.pause();

        expect(fakeAdapter.pause).not.toHaveBeenCalled();
        expect(handle.status()).toBe("success");
    });
});
