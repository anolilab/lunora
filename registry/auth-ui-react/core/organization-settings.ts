/**
 * Organization-settings flow: rename the active organization and edit its slug
 * and logo.
 *
 * The form engine has no async prefill (every other flow starts empty), so this
 * controller wraps one: it loads the organization, seeds the fields, and merges
 * a `loading` flag into the state. The merged snapshot is cached rather than
 * rebuilt per call — `getState()` must return a stable reference between changes
 * or React's `useSyncExternalStore` re-renders forever.
 */
import type { ControllerContext } from "./config";
import { createFormController } from "./create-form-controller";
import { assertOk } from "./map-error";
import type { Controller, FormActions, FormState } from "./types";
import { required } from "./validators";

type OrganizationSettingsField = "logo" | "name" | "slug";

interface OrganizationSettingsState extends FormState<OrganizationSettingsField> {
    /** The initial load of the organization is in flight. */
    loading: boolean;
}

interface OrganizationSettingsActions extends FormActions<OrganizationSettingsField> {
    /** Re-read the organization and reseed the fields. */
    refetch: () => Promise<void>;
}

type OrganizationSettingsController = Controller<OrganizationSettingsState, OrganizationSettingsActions>;

interface OrganizationSettingsOptions {
    autoLoad?: boolean;
    /** Defaults to the user's active organization. */
    organizationId?: string;
}

const createOrganizationSettingsController = (context: ControllerContext, options: OrganizationSettingsOptions = {}): OrganizationSettingsController => {
    const { organizationId } = options;

    const form = createFormController<OrganizationSettingsField>(context, {
        fallbackError: (localization) => localization.genericError,
        fields: {
            logo: { initial: "" },
            name: { initial: "", validate: (value, _values, localization) => required(value, localization.organizationNameRequired) },
            slug: { initial: "", validate: (value, _values, localization) => required(value, localization.organizationSlugRequired) },
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

    let loading = options.autoLoad !== false;
    let snapshot: OrganizationSettingsState = { ...form.getState(), loading };
    const listeners = new Set<() => void>();

    const rebuild = (): void => {
        snapshot = { ...form.getState(), loading };

        for (const listener of listeners) {
            listener();
        }
    };

    const unsubscribeForm = form.subscribe(rebuild);

    const refetch = async (): Promise<void> => {
        loading = true;
        rebuild();

        try {
            const organization = assertOk(
                await context.authClient.organization.getFullOrganization(organizationId === undefined ? undefined : { organizationId }),
            ).data;

            // setField notifies per call; the fields land together because
            // `loading` only flips false once, after the last one.
            form.actions.setField("name", organization?.name ?? "");
            form.actions.setField("slug", organization?.slug ?? "");
            form.actions.setField("logo", organization?.logo ?? "");
        } catch (error) {
            context.onError?.(error);
        } finally {
            loading = false;
            rebuild();
        }
    };

    if (options.autoLoad !== false) {
        void refetch();
    }

    return {
        actions: { ...form.actions, refetch },
        destroy: () => {
            unsubscribeForm();
            form.destroy();
            listeners.clear();
        },
        getState: () => snapshot,
        subscribe: (onChange: () => void) => {
            listeners.add(onChange);

            return () => {
                listeners.delete(onChange);
            };
        },
    };
};

export type { OrganizationSettingsActions, OrganizationSettingsController, OrganizationSettingsField, OrganizationSettingsOptions, OrganizationSettingsState };
export { createOrganizationSettingsController };
