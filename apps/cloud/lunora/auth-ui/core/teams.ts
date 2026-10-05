/**
 * Teams inside an organization: list, create, rename, remove.
 *
 * Teams are an *option* of better-auth's one `organization` plugin, not a plugin
 * of their own, so no plugin id reveals them. `uiConfig()` reports them from the
 * resolved table map instead, and the card reads `context.organization.teams` —
 * which is why this controller gates on that rather than on a flow flag.
 */
import type { ControllerContext } from "./config";
import type { ResourceState } from "./create-resource-controller";
import { createResourceController } from "./create-resource-controller";
import { assertOk } from "./map-error";
import type { AuthTeam, Controller } from "./types";

interface TeamsActions {
    create: (name: string) => Promise<void>;
    refetch: () => Promise<void>;
    remove: (teamId: string) => Promise<void>;
    rename: (teamId: string, name: string) => Promise<void>;
}

type TeamsController = Controller<ResourceState<AuthTeam>, TeamsActions>;

interface TeamsOptions {
    autoLoad?: boolean;
    /** Defaults to the active organization. */
    organizationId?: string;
}

const createTeamsController = (context: ControllerContext, options: TeamsOptions = {}): TeamsController => {
    const query = options.organizationId === undefined ? undefined : { organizationId: options.organizationId };

    const resource = createResourceController<AuthTeam>(
        context,
        async (context_) => {
            return { items: assertOk(await context_.authClient.organization.listTeams(query === undefined ? undefined : { query })).data ?? [] };
        },
        { autoLoad: options.autoLoad },
    );

    return {
        actions: {
            create: (name: string) =>
                resource.mutate(async () =>
                    assertOk(await context.authClient.organization.createTeam({ name: name.trim(), organizationId: options.organizationId })),
                ),
            refetch: resource.refetch,
            remove: (teamId: string) =>
                resource.mutate(async () => assertOk(await context.authClient.organization.removeTeam({ organizationId: options.organizationId, teamId }))),
            rename: (teamId: string, name: string) =>
                resource.mutate(async () => assertOk(await context.authClient.organization.updateTeam({ data: { name: name.trim() }, teamId }))),
        },
        destroy: resource.destroy,
        getState: resource.getState,
        subscribe: resource.subscribe,
    };
};

export type { TeamsActions, TeamsController, TeamsOptions };
export { createTeamsController };
