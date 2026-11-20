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

    /**
     * Leave an organization you are a member of. Distinct from `remove`,
     * which deletes it for everyone — the two are one keystroke apart in a menu,
     * so they are never the same action here.
     */
    leave: (organizationId: string) => Promise<void>;
    refetch: () => Promise<void>;
    remove: (organizationId: string) => Promise<void>;
    setActive: (organizationId: string) => Promise<void>;
}

type OrganizationsController = Controller<ResourceState<AuthOrganization>, OrganizationsActions>;

const createOrganizationsController = (context: ControllerContext, options: { autoLoad?: boolean } = {}): OrganizationsController => {
    const resource = createResourceController<AuthOrganization>(
        context,
        async (context_) => {
            return { items: assertOk(await context_.authClient.organization.list()).data ?? [] };
        },
        options,
    );

    return {
        actions: {
            create: (name: string, slug: string) => resource.mutate(async () => assertOk(await context.authClient.organization.create({ name, slug }))),
            leave: (organizationId: string) =>
                resource.mutate(async () => {
                    assertOk(await context.authClient.organization.leave({ organizationId }));
                    // Leaving the active organization leaves the session pointing at
                    // one the user can no longer read, so the app has to re-resolve.
                    context.onSessionChange?.();
                }),
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
