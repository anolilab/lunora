/**
 * `@lunora/angular/upload` — end-user file-upload signals.
 *
 * The admin `uploadStorageObject` path on `LunoraClient` is a one-shot PUT gated
 * by an `adminToken` — right for the Studio file browser, wrong for end users.
 * This module gives end-user browsers progress, pause/resume, large-file
 * resumable uploads and per-part retry by wrapping `@lunora/client/upload` (the
 * framework-neutral core, itself a re-export of `@visulima/storage-client` —
 * Lunora does not hand-roll the uploader) in Angular signals. Point {@link upload}
 * at a route backed by `@lunora/storage/upload`'s RLS-gated handler — end-user
 * uploads gated by _your_ per-user policy, not an `adminToken`.
 *
 * Unlike the React/Vue/Solid/Svelte adapters, this one is hand-written rather
 * than a re-export: `@visulima/storage-client` ships no `/angular` entry. It
 * wraps the TUS / chunked-REST surface (identical shape on both — progress,
 * pause, resume, abort) that `createUpload` defaults to; batch multipart
 * uploads have a different shape (`uploadBatch`, per-item abort) and aren't
 * wrapped here — call `createMultipartAdapter` (re-exported below) directly
 * for that.
 */
import type { Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { ChunkedRestAdapter, CreateUploadOptions, TusAdapter, UploadProtocol, UploadResult } from "@lunora/client/upload";
import { createUpload } from "@lunora/client/upload";

/**
 * The resumable-adapter surface {@link upload} drives — `TusAdapter` and
 * `ChunkedRestAdapter` share the members this module calls (`abort`, `isPaused`,
 * `pause`, `resume`, `setOnError`/`setOnFinish`/`setOnProgress`/`setOnStart`,
 * `upload`) identically, so the union stands in directly instead of a bespoke
 * interface drifting from the real types. `MultipartAdapter` has a different
 * shape (`uploadBatch`, per-item abort) and is intentionally excluded from
 * {@link UploadOptions.protocol}, so it never enters this union.
 */
type ResumableUploadAdapter = ChunkedRestAdapter | TusAdapter;

/** The lifecycle of an {@link upload} primitive. */
export type UploadStatus = "error" | "idle" | "paused" | "success" | "uploading";

/**
 * `UploadOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface UploadOptions extends Omit<CreateUploadOptions, "protocol"> {
    /** `DestroyRef` whose `onDestroy` aborts any upload still in flight. Defaults to `inject(DestroyRef)`. */
    destroyRef?: DestroyRef;

    /** Which resumable protocol to speak. Default `"tus"`. Multipart isn't wrapped here — call `createMultipartAdapter` directly. */
    protocol?: Exclude<UploadProtocol, "multipart">;
}

/**
 * `UploadApi` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface UploadApi {
    /** Abort the in-flight upload. Safe to call at any point, including after success. */
    abort: () => void;

    /** The upload error, or `undefined`. */
    error: Signal<Error | undefined>;

    /** Whether the upload is currently paused. */
    isPaused: Signal<boolean>;

    /** Pause the in-flight upload (TUS / chunked-REST only support this mid-upload). A no-op unless `status() === "uploading"`. */
    pause: () => void;

    /** Upload progress, as the adapter reports it (0–100). */
    progress: Signal<number>;

    /** The resolved upload result, or `undefined` before it finishes. */
    result: Signal<UploadResult | undefined>;

    /** Resume a paused upload. A no-op unless `status() === "paused"`. */
    resume: () => void;

    /** Start (or restart) the upload for `file`. Also resolves/rejects with the same result the `result`/`error` signals settle to. */
    start: (file: File) => Promise<UploadResult>;

    /** The upload lifecycle. */
    status: Signal<UploadStatus>;
}

/**
 * Drive a resumable (TUS / chunked-REST) upload as Angular signals: `progress`,
 * `status`, `result` and `error`, plus `start` / `pause` / `resume` / `abort`
 * actions. Defaults to TUS — the resumable path that survives pause/resume and
 * a dropped connection.
 *
 * Call from an injection context (component/service field or constructor):
 * ```ts
 * protected readonly upload = upload({ endpoint: "/api/upload" });
 * onFileSelected(file: File) {
 *     this.upload.start(file).catch(() => undefined); // errors also land in `error`
 * }
 * ```
 * @experimental
 */
export const upload = (options: UploadOptions): UploadApi => {
    // Rest-destructure rather than enumerate `CreateUploadOptions` fields by hand: the
    // type does the work of stripping the Angular-only `destroyRef`, so a future field
    // added to `CreateUploadOptions` flows through automatically instead of being
    // silently dropped by a stale field list.
    const { destroyRef: explicitDestroyRef, ...createOptions } = options;

    const destroyRef = explicitDestroyRef ?? inject(DestroyRef);

    // Safe: `UploadOptions.protocol` excludes "multipart" at the type level, so
    // `createUpload` can only ever return the resumable (TUS / chunked-REST)
    // member of its union here. `ResumableUploadAdapter` is a subset of
    // `createUpload`'s real return union (`ChunkedRestAdapter | MultipartAdapter |
    // TusAdapter`), so a single assertion narrows it without an `unknown` hop.
    const adapter = createUpload(createOptions) as ResumableUploadAdapter;

    const progress = signal(0);
    const status = signal<UploadStatus>("idle");
    const result = signal<UploadResult | undefined>(undefined);
    const error = signal<Error | undefined>(undefined);
    const isPaused = signal(false);

    adapter.setOnStart(() => {
        status.set("uploading");
    });

    adapter.setOnProgress((value) => {
        progress.set(value);
    });

    adapter.setOnFinish((value) => {
        result.set(value);
        status.set("success");
    });

    adapter.setOnError((uploadError) => {
        error.set(uploadError);
        status.set("error");
    });

    const start = (file: File): Promise<UploadResult> => {
        // A (re)start is a fresh attempt: clear the previous attempt's terminal
        // signals so a retry can't render a stale error/result/progress alongside
        // the new upload's status (see UploadApi.start — "Start (or restart)").
        error.set(undefined);
        result.set(undefined);
        progress.set(0);
        isPaused.set(false);
        status.set("uploading");

        return adapter.upload(file);
    };

    const pause = (): void => {
        // A no-op unless an upload is actually in flight — calling `pause()`
        // from `"idle"`/`"success"`/`"error"` must not stamp `"paused"` over a
        // terminal state that has nothing to pause.
        if (status() !== "uploading") {
            return;
        }

        adapter.pause();
        isPaused.set(true);
        status.set("paused");
    };

    const resume = (): void => {
        // A no-op unless the upload is actually paused — mirrors `pause()`'s guard.
        if (status() !== "paused") {
            return;
        }

        // `adapter.resume()` is async (it may re-probe the upload offset before
        // resuming); route failure into the same `error`/`status` signals a
        // failed `start()` would, rather than an unhandled rejection.
        adapter
            .resume()
            .then(() => {
                isPaused.set(false);
                status.set("uploading");

                return undefined;
            })
            .catch((resumeError: unknown) => {
                error.set(resumeError instanceof Error ? resumeError : new Error(String(resumeError)));
                status.set("error");
            });
    };

    const abort = (): void => {
        adapter.abort();
    };

    destroyRef.onDestroy(abort);

    return {
        abort,
        error: error.asReadonly(),
        isPaused: isPaused.asReadonly(),
        pause,
        progress: progress.asReadonly(),
        result: result.asReadonly(),
        resume,
        start,
        status: status.asReadonly(),
    };
};

// Re-exported so an Angular-only consumer gets everything from one import,
// matching the other framework adapters' `/upload` entries.
export type {
    ChunkedRestAdapter,
    ChunkedRestAdapterOptions,
    FingerprintFunction,
    HeadersResolver,
    MultipartAdapter,
    MultipartAdapterOptions,
    OnBeforeRequest,
    RequestOptions,
    TusAdapter,
    TusAdapterOptions,
    UploadAdapter,
    UploadRestrictions,
    UploadResult,
} from "@lunora/client/upload";
export { createChunkedRestAdapter, createMultipartAdapter, createTusAdapter, createUpload, RestrictionError, UploadError } from "@lunora/client/upload";
// `UploadControl` re-exports type-only out of the rolled-up `@lunora/client/upload`
// declaration bundle (a packem/rollup-dts artifact — the runtime export is a class,
// same as `UploadError`/`RestrictionError`, which roll up fine), so it's re-exported
// from its origin instead, exactly like `@lunora/react/upload` and friends already do.
export { UploadControl } from "@visulima/storage-client";
