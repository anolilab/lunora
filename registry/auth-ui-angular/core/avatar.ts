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

                if (file.type !== "" && !ACCEPTED_TYPES.has(file.type)) {
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
