/**
 * Organizations flow: list the user's organizations and create / switch / delete
 * them. A thin specialization of the resource engine.
 */
import type { ControllerContext } from "./config";
import type { ResourceState } from "./create-resource-controller";
import { createResourceController } from "./create-resource-controller";
import { assertOk } from "./map-error";
import type { AuthOrganization, Controller } from "./types";

interface OrganizationsActions {
    create: (name: string, slug: string) => Promise<void>;
    refetch: () => Promise<void>;
    remove: (organizationId: string) => Promise<void>;
    setActive: (organizationId: string) => Promise<void>;
}

type OrganizationsController = Controller<ResourceState<AuthOrganization>, OrganizationsActions>;

const createOrganizationsController = (context: ControllerContext, options: { autoLoad?: boolean } = {}): OrganizationsController => {
    const resource = createResourceController<AuthOrganization>(
        context,
        async (context_) => assertOk(await context_.authClient.organization.list()).data ?? [],
        options,
    );

    return {
        actions: {
            create: (name: string, slug: string) => resource.mutate(async () => assertOk(await context.authClient.organization.create({ name, slug }))),
            refetch: resource.refetch,
            remove: (organizationId: string) => resource.mutate(async () => assertOk(await context.authClient.organization.delete({ organizationId }))),
            setActive: (organizationId: string) => resource.mutate(async () => assertOk(await context.authClient.organization.setActive({ organizationId }))),
        },
        destroy: resource.destroy,
        getState: resource.getState,
        subscribe: resource.subscribe,
    };
};

export type { OrganizationsActions, OrganizationsController };
export { createOrganizationsController };
