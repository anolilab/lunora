/**
 * The GitHub App install flow's two browser routes. `GET /v1/github/install`
 * starts it for an owner or admin; `GET /v1/github/setup` is the Setup URL
 * GitHub returns the browser to, which binds the installation. Both need a
 * session, and the decisions live in `src/github/setup-flow.ts`.
 */
import { api } from "../../../lunora/_generated/api";
import { internal } from "../../../lunora/_generated/internal";
import { currentAuth } from "../../auth";
import { completeInstall, startInstall } from "../../github/setup-flow";
import { randomSecret } from "../keys";
import type { LunoraActionContext, RouterEnv } from "./shared";
import { jsonError, requireContext } from "./shared";

/** Whether `userId` is an owner or admin of `organizationId`, read from the membership list. */
const isOwnerOrAdmin = async (context: LunoraActionContext, organizationId: string, userId: string): Promise<boolean> => {
    const members = await context.runQuery<{ role: string; userId: string }[]>(api.members.list, { organizationId });
    const role = members.find((member) => member.userId === userId)?.role;

    return role === "owner" || role === "admin";
};

/**
 * The GitHub account ids linked to the session's user, from better-auth's account
 * list. Fails closed: with no auth or no session, nothing is linked.
 */
const linkedGitHubAccountIds = async (headers: Headers): Promise<string[]> => {
    const accounts = (await currentAuth()?.api.listUserAccounts({ headers })) ?? [];

    return accounts.filter((account) => account.providerId === "github").map((account) => account.accountId);
};

/** `GET /v1/github/install?organizationId=…` — redirect to the GitHub App's install page, carrying a signed state. */
export const handleGitHubInstallRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const organizationId = new URL(request.url).searchParams.get("organizationId");

    if (!organizationId) {
        return jsonError(400, "organizationId is required");
    }

    const session = await currentAuth()?.api.getSession({ headers: request.headers });
    const userId = session?.user?.id;

    if (!userId) {
        return jsonError(401, "not signed in");
    }

    const outcome = await startInstall({
        allowed: await isOwnerOrAdmin(context, organizationId, userId),
        appSlug: environment.GITHUB_APP_SLUG,
        nonce: randomSecret(),
        now: Date.now(),
        organizationId,
        secret: environment.GITHUB_SETUP_STATE_SECRET,
        userId,
    });

    if (!outcome.ok) {
        return jsonError(outcome.status, outcome.error);
    }

    return Response.redirect(outcome.value, 302);
};

/** `GET /v1/github/setup` (query: installation_id, setup_action, state) — the Setup URL callback that binds the installation. */
export const handleGitHubSetupRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const url = new URL(request.url);
    const session = await currentAuth()?.api.getSession({ headers: request.headers });

    const outcome = await completeInstall({
        bind: (installationId, organizationId, userId) =>
            context.runMutation(internal.github_installations.bind, {
                installationId,
                organizationId,
                userId,
            }),
        installationId: url.searchParams.get("installation_id"),
        isOwnerOrAdmin: (organizationId, userId) => isOwnerOrAdmin(context, organizationId, userId),
        linkedGitHubAccountIds: () => linkedGitHubAccountIds(request.headers),
        now: Date.now(),
        secret: environment.GITHUB_SETUP_STATE_SECRET,
        setupAction: url.searchParams.get("setup_action"),
        stagedInstaller: (installationId) =>
            context.runQuery<null | { installedByGithubId?: number }>(internal.github_installations.stagedInstaller, { installationId }),
        sessionUserId: session?.user?.id,
        state: url.searchParams.get("state"),
    });

    if (!outcome.ok) {
        return jsonError(outcome.status, outcome.error);
    }

    return Response.redirect(new URL(`/orgs/${outcome.value.organizationId}/integrations`, request.url).toString(), 302);
};
