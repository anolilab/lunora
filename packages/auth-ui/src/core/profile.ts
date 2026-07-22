/** Profile flow: update display name (and optional avatar URL) via `updateUser`. */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import type { FormController } from "./types";
import { required } from "./validators";

type ProfileField = "image" | "name";

interface ProfileOptions {
    /** Prefill from the app's current session (it already has the user). */
    initialImage?: string;
    initialName?: string;
}

const createProfileController = (context: ControllerContext, options: ProfileOptions = {}): FormController<ProfileField> =>
    createFormController<ProfileField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: {
            image: { initial: options.initialImage ?? "" },
            name: { initial: options.initialName ?? "", validate: (value, _values, localization) => required(value, localization.nameRequired) },
        },
        submit: async (values, context_) => {
            const image = values.image.trim();

            assertOk(await context_.authClient.updateUser({ image: image === "" ? undefined : image, name: values.name.trim() }));

            return { successMessage: context_.localization.profileSaved };
        },
    });

export type { ProfileField, ProfileOptions };
export { createProfileController };
