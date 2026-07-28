/**
 * Organization-settings flow: rename the active organization and edit its slug
 * and logo. The current values come from the server, so this is the one flow
 * that declares a `prefill` — the engine owns the loading flag and seeds the
 * fields in a single transition.
 */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import type { FormController } from "./types";
import { required } from "./validators";

type OrganizationSettingsField = "logo" | "name" | "slug";

interface OrganizationSettingsOptions {
    autoLoad?: boolean;
    /** Defaults to the user's active organization. */
    organizationId?: string;
}

const createOrganizationSettingsController = (
    context: ControllerContext,
    options: OrganizationSettingsOptions = {},
): FormController<OrganizationSettingsField> => {
    const { organizationId } = options;

    return createFormController<OrganizationSettingsField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: {
            logo: {},
            name: { validate: (value, _values, localization) => required(value, localization.organizationNameRequired) },
            slug: { validate: (value, _values, localization) => required(value, localization.organizationSlugRequired) },
        },
        prefill:
            options.autoLoad === false
                ? undefined
                : async (context_) => {
                      const organization = assertOk(
                          await context_.authClient.organization.getFullOrganization(organizationId === undefined ? undefined : { organizationId }),
                      ).data;

                      return { logo: organization?.logo ?? "", name: organization?.name ?? "", slug: organization?.slug ?? "" };
                  },
        submit: async (values, context_) => {
            const logo = values.logo.trim();

            assertOk(
                await context_.authClient.organization.update({
                    data: { logo: logo === "" ? undefined : logo, name: values.name.trim(), slug: values.slug.trim() },
                    organizationId,
                }),
            );

            return { successMessage: context_.localization.organizationSaved };
        },
    });
};

export type { OrganizationSettingsField, OrganizationSettingsOptions };
export { createOrganizationSettingsController };
