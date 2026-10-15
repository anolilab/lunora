import { internal } from "../../../lunora/_generated/internal";
import { createGitHubApp } from "../../github/app";
import type { BuildRecordResult } from "../../github/webhook";
import { handleGitHubWebhook } from "../../github/webhook";
import type { RouterEnv } from "./shared";
import { jsonError, requireContext } from "./shared";

type ProjectResolution = { organizationId: string; projectId: string; slug: string }; // secret-scanner:allow -- domain field name

/** `POST /v1/github/webhook` — verify + resolve the connected project (§2.3). */
export const handleWebhookRoute = (request: Request, environment: RouterEnv): Promise<Response> => {
    if (!environment.GITHUB_WEBHOOK_SECRET) {
        return Promise.resolve(jsonError(500, "github webhook secret not configured"));
    }

    // Throws `MissingContextError` without the context; the route table's `withContext` answers that as the same 500.
    const context = requireContext(environment);

    // For the preview path filter's compare call and a skipped build's commit
    // status; absent credentials leave previews building unfiltered and skips
    // unreported rather than failing the webhook.
    const githubApp = createGitHubApp({ appId: environment.GITHUB_APP_ID, privateKeyPem: environment.GITHUB_APP_PRIVATE_KEY });

    return handleGitHubWebhook(request, {
        ...(githubApp === null ? {} : { listChangedFiles: githubApp.listChangedFiles, postCommitStatus: githubApp.postCommitStatus }),
        // installation created/deleted → link/unlink the org (GAPS.md A4).
        onInstallation: async (intent) => {
            await (intent.action === "created"
                ? context.runMutation(internal.github_installations.record, {
                      accountLogin: intent.accountLogin,
                      installationId: intent.installationId,
                      ...(intent.installedByGithubId === undefined ? {} : { installedByGithubId: intent.installedByGithubId }),
                      ...(intent.installedByLogin === undefined ? {} : { installedByLogin: intent.installedByLogin }),
                  })
                : context.runMutation(internal.github_installations.remove, { installationId: intent.installationId }));
        },
        // PR upsert → server-side preview build (same pipeline, GAPS.md A3).
        onPreviewBuild: (intent) =>
            context.runMutation<BuildRecordResult>(internal.builds.recordPush, {
                branch: intent.branch,
                changes: intent.changes,
                commitSha: intent.commitSha,
                deliveryId: intent.deliveryId,
                fromFork: intent.fromFork,
                installationId: intent.installationId,
                pullRequest: intent.pullRequest,
                repository: intent.repository,
                trigger: "pull_request",
            }),
        // default-branch push → record a build (dedup by commit SHA, GAPS.md A3).
        onPush: (intent) =>
            context.runMutation<BuildRecordResult>(internal.builds.recordPush, {
                before: intent.before,
                branch: intent.branch,
                changes: intent.changes,
                commitSha: intent.commitSha,
                deliveryId: intent.deliveryId,
                installationId: intent.installationId,
                repository: intent.repository,
                trigger: "push",
            }),
        resolveProject: (repository) => context.runMutation<null | ProjectResolution>(internal.projects.byGithubRepo, { repository }),
        secret: environment.GITHUB_WEBHOOK_SECRET,
    });
};
