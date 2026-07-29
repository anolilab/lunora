/**
 * Organization logo upload — the org-side counterpart to `avatar.ts`.
 *
 * Same shape and the same reasoning: better-auth stores `organization.logo` as a
 * string, so where the bytes live is the app's decision and comes in through
 * `avatar.upload`. Without an upload handler `&lt;OrganizationSettingsCard>`'s URL
 * field is still the fallback, and this card doesn't render.
 *
 * It is a separate controller rather than a parameter on the avatar one because
 * the save call differs — `organization.update` against a specific org, not
 * `updateUser` — and folding both into one would mean a controller that takes a
 * discriminator and branches on it in three places.
 */
import { ACCEPTED_TYPES } from "./avatar";
import type { ControllerContext } from "./config";
import { assertOk, mapAuthError } from "./map-error";
import { createStore } from "./store";
import type { Controller, FlowStatus } from "./types";

interface LogoUploadState {
    error?: string;
    /** The stored URL after a successful upload, so the view can show it at once. */
    logoUrl?: string;
    status: FlowStatus;
}

interface LogoUploadActions {
    remove: () => Promise<void>;
    upload: (file: File) => Promise<void>;
}

type LogoUploadController = Controller<LogoUploadState, LogoUploadActions>;

interface LogoUploadOptions {
    initialLogo?: string;
    /** Defaults to the active organization. */
    organizationId?: string;
}

const megabytes = (bytes: number): string => `${String(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MB`;

const createOrganizationLogoController = (context: ControllerContext, options: LogoUploadOptions = {}): LogoUploadController => {
    const store = createStore<LogoUploadState>({ logoUrl: options.initialLogo, status: "idle" });

    const save = async (logo: string | undefined): Promise<void> => {
        assertOk(await context.authClient.organization.update({ data: { logo }, organizationId: options.organizationId }));
        store.update({ logoUrl: logo, status: "success" });
    };

    const guard = async (run: () => Promise<void>, fallback: string): Promise<void> => {
        if (store.get().status === "submitting") {
            return;
        }

        store.update({ error: undefined, status: "submitting" });

        try {
            await run();
        } catch (error) {
            context.onError?.(error);
            store.update({ error: mapAuthError(error, context.localization, fallback), status: "error" });
        }
    };

    return {
        actions: {
            remove: () => guard(async () => save(undefined), context.localization.genericError),
            upload: async (file: File) => {
                const { upload } = context.avatar;

                if (upload === undefined) {
                    store.update({ error: context.localization.avatarNoUploader, status: "error" });

                    return;
                }

                const maxSize = context.avatar.maxSize ?? Number.POSITIVE_INFINITY;

                // Checked before uploading, for the same reason as the avatar: a
                // client-side cap exists so the user doesn't spend the bandwidth
                // discovering it.
                if (file.size > maxSize) {
                    store.update({ error: `${context.localization.avatarTooLarge} (${megabytes(maxSize)})`, status: "error" });

                    return;
                }

                if (file.type !== "" && !ACCEPTED_TYPES.has(file.type)) {
                    store.update({ error: context.localization.avatarWrongType, status: "error" });

                    return;
                }

                await guard(async () => save(await upload(file)), context.localization.avatarUploadFailed);
            },
        },
        destroy: store.clear,
        getState: store.get,
        subscribe: store.subscribe,
    };
};

export type { LogoUploadActions, LogoUploadController, LogoUploadOptions, LogoUploadState };
export { createOrganizationLogoController };
