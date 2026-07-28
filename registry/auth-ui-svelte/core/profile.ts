/** Profile flow: update display name (and optional avatar URL) via `updateUser`. */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import type { FormController } from "./types";
import { required } from "./validators";

type ProfileField = "image" | "name";

interface ProfileOptions {
    /**
     * Seed the fields instead of reading the session. Optional: with neither set
     * the controller prefills from `getSession` itself.
     *
     * Prefer leaving these unset. They are *initial* values, so a caller that
     * feeds them a live session value — the obvious `defaultName={session.data
     * ?.user.name}` — rebuilds the controller every time the session object
     * changes, including the refresh a successful save triggers. The form resets
     * and the success banner disappears the instant it is earned.
     */
    initialImage?: string;
    initialName?: string;
}

const createProfileController = (context: ControllerContext, options: ProfileOptions = {}): FormController<ProfileField> => {
    const seeded = options.initialImage !== undefined || options.initialName !== undefined;

    return createFormController<ProfileField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: {
            image: { initial: options.initialImage ?? "" },
            name: { initial: options.initialName ?? "", validate: (value, _values, localization) => required(value, localization.nameRequired) },
        },
        // Read the user the same way `organization-settings.ts` reads the org:
        // the engine owns the loading flag and seeds both fields in one
        // transition, so no view ever renders a half-filled form — and no caller
        // has to thread a session value through a controller dependency.
        prefill: seeded
            ? undefined
            : async (context_) => {
                  const session = await context_.authClient.getSession();
                  const user = session.data?.user;

                  return { image: user?.image ?? "", name: user?.name ?? "" };
              },
        submit: async (values, context_) => {
            const image = values.image.trim();

            assertOk(await context_.authClient.updateUser({ image: image === "" ? undefined : image, name: values.name.trim() }));

            return { successMessage: context_.localization.profileSaved };
        },
    });
};

export type { ProfileField, ProfileOptions };
export { createProfileController };
