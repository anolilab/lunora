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
                  // `assertOk`: an errored read throws into the form engine's
                  // catch instead of blanking both fields with `""`.
                  const session = assertOk(await context_.authClient.getSession());
                  const user = session.data?.user;
                  const values: Partial<Record<ProfileField, string>> = {};

                  /*
                   * Only keys that are actually present — seeding `""` for an
                   * absent value would blank a field (see `sign-up.ts`).
                   *
                   * `typeof … === "string"`, not `!== undefined`: better-auth
                   * sends `image: null` for a user who has never set an avatar,
                   * and the form engine seeds anything that is not `undefined`.
                   * A `null` in a field value binds to a controlled input as
                   * uncontrolled and makes `submit`'s `.trim()` throw, so the
                   * form could never be saved. `null` means absent here.
                   */
                  if (typeof user?.image === "string") {
                      values.image = user.image;
                  }

                  if (typeof user?.name === "string") {
                      values.name = user.name;
                  }

                  return values;
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
