/**
 * Avatar upload: turn a picked `File` into the URL `user.image` stores.
 *
 * better-auth has no opinion about where the bytes live — `image` is a string
 * column — so this package doesn't either. The app supplies
 * `avatar.upload` (R2 via `@lunora/storage`, an S3 signed PUT, anything), and
 * this is the bit around it that every port would otherwise re-implement: size
 * check, type check, upload, save, error mapping.
 *
 * Without an `upload` handler the profile card falls back to a URL field, so
 * this whole path is opt-in.
 */
import type { ControllerContext } from "./config";
import { assertOk, mapAuthError } from "./map-error";
import { createStore } from "./store";
import type { Controller, FlowStatus } from "./types";

/** Image types worth accepting from a file picker. */
const ACCEPTED_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);

/** The `accept` attribute for the file input, kept in sync with {@link ACCEPTED_TYPES}. */
const ACCEPT_ATTRIBUTE = [...ACCEPTED_TYPES].join(",");

interface AvatarUploadState {
    error?: string;
    /** The stored URL after a successful upload, so the view can show it at once. */
    imageUrl?: string;
    status: FlowStatus;
}

interface AvatarUploadActions {
    /** Clear the avatar entirely. */
    remove: () => Promise<void>;
    upload: (file: File) => Promise<void>;
}

type AvatarUploadController = Controller<AvatarUploadState, AvatarUploadActions>;

/** Human-readable size for the too-big message, in whole MB. */
const megabytes = (bytes: number): string => `${String(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MB`;

/** One byte run a signature requires at a given offset into the file. */
interface MagicRun {
    bytes: ReadonlyArray<number>;
    offset: number;
}

/**
 * Magic-number signatures for the {@link ACCEPTED_TYPES} formats. Most formats
 * are one contiguous run at offset 0; WebP and AVIF need two non-contiguous
 * runs (a container header, then a fixed marker further in), so a signature is
 * a list of runs that must ALL match — never just the first, or a signature
 * would accept any RIFF-family file (WAV, AVI, …) as WebP.
 */
const MAGIC_SIGNATURES: ReadonlyArray<ReadonlyArray<MagicRun>> = [
    [{ bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0 }], // PNG
    [{ bytes: [0xff, 0xd8, 0xff], offset: 0 }], // JPEG
    [{ bytes: [0x47, 0x49, 0x46, 0x38], offset: 0 }], // GIF ("GIF8")
    [
        { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // "RIFF"…
        { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 }, // …"WEBP" at byte 8
    ],
    [
        { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // "ftyp" after the box-size prefix…
        { bytes: [0x61, 0x76, 0x69], offset: 8 }, // …"avi" brand at byte 8 (covers both "avif" and "avis")
    ],
];

/**
 * Sniffs the first bytes of a file for a known image format's magic number,
 * for the case `file.type` is empty — a drag-and-drop from some file managers,
 * a camera-roll export, anything the OS's extension-to-MIME table has no entry
 * for. An empty `type` used to bypass the check entirely, letting arbitrary
 * bytes through under any file name.
 *
 * This is still only a client-side courtesy, exactly like the `ACCEPTED_TYPES`
 * check it extends: the server must re-validate every upload regardless of
 * what either check reports.
 */
const sniffImageType = async (file: File): Promise<boolean> => {
    const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const runMatches = (run: MagicRun): boolean => run.bytes.every((byte, index) => header[run.offset + index] === byte);

    return MAGIC_SIGNATURES.some((signature) => signature.every((run) => runMatches(run)));
};

const createAvatarUploadController = (context: ControllerContext, options: { initialImage?: string } = {}): AvatarUploadController => {
    const store = createStore<AvatarUploadState>({ imageUrl: options.initialImage, status: "idle" });

    const save = async (image: string | undefined, successStatus: FlowStatus): Promise<void> => {
        assertOk(await context.authClient.updateUser({ image }));
        store.update({ imageUrl: image, status: successStatus });
        context.onSessionChange?.();
    };

    return {
        actions: {
            remove: async () => {
                if (store.get().status === "submitting") {
                    return;
                }

                store.update({ error: undefined, status: "submitting" });

                try {
                    await save(undefined, "success");
                } catch (error) {
                    context.onError?.(error);
                    store.update({ error: mapAuthError(error, context.localization, context.localization.genericError), status: "error" });
                }
            },
            upload: async (file: File) => {
                const { upload } = context.avatar;

                if (upload === undefined) {
                    store.update({ error: context.localization.avatarNoUploader, status: "error" });

                    return;
                }

                const maxSize = context.avatar.maxSize ?? Number.POSITIVE_INFINITY;

                // Check before uploading, not after: the point of a client-side cap
                // is to not spend the user's bandwidth discovering it.
                if (file.size > maxSize) {
                    store.update({ error: `${context.localization.avatarTooLarge} (${megabytes(maxSize)})`, status: "error" });

                    return;
                }

                // An empty `type` isn't a green light — it's the browser saying it
                // doesn't know, which happens for real image files often enough
                // (some file managers' drag-and-drop, camera-roll exports) that
                // sniffing the bytes beats either trusting or rejecting blindly.
                if (file.type === "" ? !(await sniffImageType(file)) : !ACCEPTED_TYPES.has(file.type)) {
                    store.update({ error: context.localization.avatarWrongType, status: "error" });

                    return;
                }

                if (store.get().status === "submitting") {
                    return;
                }

                store.update({ error: undefined, status: "submitting" });

                try {
                    await save(await upload(file), "success");
                } catch (error) {
                    context.onError?.(error);
                    store.update({ error: mapAuthError(error, context.localization, context.localization.avatarUploadFailed), status: "error" });
                }
            },
        },
        destroy: store.clear,
        getState: store.get,
        subscribe: store.subscribe,
    };
};

export type { AvatarUploadActions, AvatarUploadController, AvatarUploadState };
export { ACCEPT_ATTRIBUTE, ACCEPTED_TYPES, createAvatarUploadController };
