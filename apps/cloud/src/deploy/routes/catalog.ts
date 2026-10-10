/**
 * The app catalog's routes: browse the verified official catalog, and install one
 * app into a project. Thin by design: the verification and the install live in
 * `src/catalog`, and this module maps requests onto them and failure kinds onto
 * HTTP statuses, in one table, so a status is never decided in two places.
 *
 * Installing writes secrets and releases code into a project, so the install route
 * refuses anyone who is not an owner or admin before anything is written.
 */
import { isLunoraError } from "@lunora/errors";

import { api, internal } from "../../../lunora/_generated/api.js";
import { currentAuth } from "../../auth";
import type { InstallPorts, SealedSecret } from "../../catalog/install";
import type { CatalogDeps, CatalogEnv, CatalogInstallRow, InstallAdapters, InstallFailureKind, InstallRequest, InstallTarget } from "../../catalog/service";
import { installApp, listCatalog } from "../../catalog/service";
import { encryptSecret } from "../../secrets/crypto";
import { formatDeployKey, hashDeployKey, randomSecret } from "../keys";
import type { DeployPacer } from "../pacing";
import { startRelease } from "../release-core";
import { deployDeps } from "./deploy";
import type { RouterEnv } from "./shared";
import { jsonError, rejected, requireContext } from "./shared";

/** The catalog keys ride on the control-plane env, which the router's env is a superset of. */
type CatalogRouterEnv = CatalogEnv & RouterEnv;

/** Project statuses that mean a release is still on its way; a catalog install waits for none of them. */
const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set(["building", "provisioning", "queued", "verifying"]);

/** The status each failure kind answers with. The only place a catalog status is decided. */
const STATUS_FOR: Record<InstallFailureKind, number> = {
    busy: 409,
    conflict: 409,
    internal: 500,
    invalidInput: 400,
    notFound: 404,
    unavailable: 503,
    upstream: 502,
    verification: 422,
};

/** The fetch and clock the catalog service reads through. */
const catalogTransport = (environment: CatalogRouterEnv): CatalogDeps => {
    return {
        env: environment,
        fetch: (url) => fetch(url),
        now: () => Date.now(),
    };
};

/** A failure from a Lunora call: its own status when it carries one, otherwise a 500. */
const catalogFailed = (error: unknown, fallback: string): Response => (isLunoraError(error) ? rejected(error, fallback) : jsonError(500, fallback));

/**
 * `GET /v1/catalog?organizationId=ORG` — the verified apps in the official catalog,
 * with the org's live installs of each, and the apps that failed verification with
 * their reasons. Any member may read it.
 */
export const handleCatalogRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const organizationId = new URL(request.url).searchParams.get("organizationId");

    if (!organizationId) {
        return jsonError(400, "organizationId is required");
    }

    try {
        const listing = await listCatalog(
            {
                ...catalogTransport(environment),
                installs: (organization) => context.runQuery<CatalogInstallRow[]>(api.catalog.installs, { organizationId: organization }),
            },
            organizationId,
        );

        return listing.ok ? Response.json({ apps: listing.apps, skipped: listing.skipped }) : jsonError(503, listing.error);
    } catch (error) {
        return catalogFailed(error, "catalog unavailable");
    }
};

/** The body of `POST /v1/catalog/install`, before the session user is added. */
type CatalogInstallBody = Omit<InstallRequest, "installedBy">;

const REQUIRED_INSTALL_FIELDS = ["organizationId", "projectId", "slug"] as const;

type StringBag = { ok: true; value: Record<string, string> } | { error: string; field: string; ok: false };

/** One `values` list (`vars` or `secrets`) as a string map, or the failure naming the value that is not one. */
const stringBag = (values: Record<string, unknown>, name: "secrets" | "vars"): StringBag => {
    const entries: unknown = values[name] === undefined ? {} : values[name];

    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
        return { error: `values.${name} must be an object of strings`, field: `values.${name}`, ok: false };
    }

    const offender = Object.entries(entries).find(([, value]) => typeof value !== "string");

    if (offender !== undefined) {
        return { error: `${offender[0]} must be a string`, field: offender[0], ok: false };
    }

    return { ok: true, value: entries as Record<string, string> };
};

/** Check the install body's shape. Returns the request, or the failure the caller needs to see. */
const parseInstallBody = (raw: unknown): { body: CatalogInstallBody; ok: true } | { error: string; field?: string; ok: false } => {
    if (typeof raw !== "object" || raw === null) {
        return { error: "a JSON object body is required", ok: false };
    }

    const body = raw as Record<string, unknown>;
    const missing = REQUIRED_INSTALL_FIELDS.find((field) => typeof body[field] !== "string" || body[field] === "");

    if (missing !== undefined) {
        return { error: `${missing} is required`, field: missing, ok: false };
    }

    const values: unknown = body["values"] === undefined ? {} : body["values"];

    if (typeof values !== "object" || values === null || Array.isArray(values)) {
        return { error: "values must be an object with vars and secrets", field: "values", ok: false };
    }

    const variables = stringBag(values as Record<string, unknown>, "vars");

    if (!variables.ok) {
        return { error: variables.error, field: variables.field, ok: false };
    }

    const secrets = stringBag(values as Record<string, unknown>, "secrets");

    if (!secrets.ok) {
        return { error: secrets.error, field: secrets.field, ok: false };
    }

    return {
        body: {
            organizationId: body["organizationId"] as string,
            projectId: body["projectId"] as string,
            slug: body["slug"] as string,
            values: { secrets: secrets.value, vars: variables.value },
        },
        ok: true,
    };
};

/**
 * The install core's ports, bound to one install's organization and project. Secrets
 * are sealed here, at the edge, and written to the production environment; the
 * release key is one minted for this install alone, and it expires on its own.
 */
const installPorts = (
    context: ReturnType<typeof requireContext>,
    organizationId: string,
    projectId: string,
    secretKey: string,
    deps: NonNullable<ReturnType<typeof deployDeps>>,
): InstallPorts => {
    const storedSecrets = async (): Promise<{ environment: string; id: string; name: string }[]> => {
        const rows = await context.runQuery<{ environment: string; id: string; name: string }[]>(api.secrets.list, { organizationId, projectId });

        return rows.filter((row) => row.environment === "production" || row.environment === "all");
    };

    return {
        abandon: (installId) => context.runMutation(internal.catalog.abandonInstall, { installId }),
        claim: async (claim) => {
            const result = await context.runMutation<{ busy: boolean; installId?: string }>(internal.catalog.claimInstall, {
                installedBy: claim.installedBy,
                organizationId,
                projectId,
                slug: claim.slug,
                version: claim.version,
            });

            return result.busy || result.installId === undefined ? { busy: true } : { busy: false, installId: result.installId };
        },
        finish: async (installId, deploymentId) => {
            await context.runMutation(internal.catalog.finishInstall, { deploymentId, installId });
        },
        inFlight: async () => {
            const deployments = await context.runQuery<{ status: string }[]>(api.deployments.listByProject, { organizationId, projectId });

            return deployments.some((deployment) => IN_FLIGHT_STATUSES.has(deployment.status));
        },
        mintReleaseKey: async (installId) => {
            const key = formatDeployKey({ organizationId, projectId, secret: randomSecret(), type: "production" });
            const id = await context.runMutation<string>(internal.deploy_keys.recordInstallKey, {
                hashedKey: await hashDeployKey(key),
                installId,
                organizationId,
                projectId,
            });

            return { id, key };
        },
        release: async (request, key) => {
            const started = await startRelease(request, { key, organizationId }, deps);

            if ("error" in started) {
                return { deploymentId: "", error: started.error, status: "failed" };
            }

            return started.run(() => {});
        },
        removeSecret: async (name) => {
            const rows = await storedSecrets();
            const row = rows.find((candidate) => candidate.name === name && candidate.environment === "production");

            if (row !== undefined) {
                await context.runMutation(api.secrets.remove, { id: row.id, organizationId });
            }
        },
        restoreSecret: async (secret) => {
            await context.runMutation(api.secrets.store, {
                ciphertext: secret.ciphertext,
                environment: "production",
                iv: secret.iv,
                name: secret.name,
                organizationId,
                projectId,
            });
        },
        revokeReleaseKey: async (installId, id) => {
            await context.runMutation(internal.deploy_keys.removeInstallKey, { id, installId });
        },
        snapshotSecrets: async (names) => {
            const current = await context.runQuery<{ ciphertext: string; iv: string; name: string }[]>(api.secrets.listEncrypted, {
                environment: "production",
                organizationId,
                projectId,
            });

            return current.filter((secret) => names.includes(secret.name)) satisfies SealedSecret[];
        },
        storedSecretNames: async () => {
            const rows = await storedSecrets();

            return rows.map((row) => row.name);
        },
        storeSecret: async (name, value) => {
            const sealed = await encryptSecret(secretKey, value);

            await context.runMutation(api.secrets.store, {
                ciphertext: sealed.ciphertext,
                environment: "production",
                iv: sealed.iv,
                name,
                organizationId,
                projectId,
            });
        },
    };
};

/** The project's production alias, or `null` when the project is not in this organization. */
const projectTargetOf = async (context: ReturnType<typeof requireContext>, organizationId: string, projectId: string): Promise<InstallTarget> => {
    const projects = await context.runQuery<{ _id: string; productionAlias?: string }[]>(api.projects.listByOrg, { organizationId });
    const project = projects.find((candidate) => candidate._id === projectId);

    if (!project) {
        return null;
    }

    return project.productionAlias === undefined ? {} : { scriptName: project.productionAlias };
};

/**
 * `POST /v1/catalog/install` — install a catalog app into a project. Owner or admin
 * only, refused before anything is written. The install's key is minted for it alone
 * and expires on its own; the install row names the session user.
 */
export const handleCatalogInstallRoute = async (request: Request, environment: RouterEnv, pacer: DeployPacer): Promise<Response> => {
    const context = requireContext(environment);
    const env = environment as CatalogRouterEnv;
    const parsed = parseInstallBody(await request.json().catch(() => null));

    if (!parsed.ok) {
        return Response.json({ error: parsed.error, ...(parsed.field === undefined ? {} : { field: parsed.field }) }, { status: 400 });
    }

    const deps = deployDeps(context, environment, pacer);

    if (!deps) {
        return jsonError(500, "the RELEASES bucket is not configured; a deploy without a stored release could never be rolled back");
    }

    const secretKey = env.SECRET_ENCRYPTION_KEY;

    if (!secretKey) {
        return jsonError(500, "SECRET_ENCRYPTION_KEY not configured");
    }

    const session = await currentAuth()?.api.getSession({ headers: request.headers });
    const installedBy = session?.user?.id;

    if (!installedBy) {
        return jsonError(401, "not signed in");
    }

    const { body } = parsed;

    try {
        const members = await context.runQuery<{ role: string; userId: string }[]>(api.members.list, { organizationId: body.organizationId });
        const role = members.find((member) => member.userId === installedBy)?.role;

        if (role !== "owner" && role !== "admin") {
            return jsonError(403, "only owners and admins can install a catalog app");
        }

        const adapters: InstallAdapters = {
            ports: installPorts(context, body.organizationId, body.projectId, secretKey, deps),
            target: () => projectTargetOf(context, body.organizationId, body.projectId),
        };
        const outcome = await installApp(catalogTransport(env), { ...body, installedBy }, adapters);

        if (outcome.ok) {
            return Response.json(
                {
                    deploymentId: outcome.deploymentId,
                    generated: outcome.generated,
                    kept: outcome.kept,
                    recorded: outcome.recorded,
                    ...(outcome.url === undefined ? {} : { url: outcome.url }),
                },
                { status: 200 },
            );
        }

        return Response.json(
            {
                error: outcome.error,
                ...(outcome.code === undefined ? {} : { code: outcome.code }),
                ...(outcome.field === undefined ? {} : { field: outcome.field }),
            },
            { status: STATUS_FOR[outcome.kind] },
        );
    } catch (error) {
        return catalogFailed(error, "catalog install failed");
    }
};
