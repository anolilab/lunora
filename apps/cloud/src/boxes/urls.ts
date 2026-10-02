/**
 * Where boxes find things (plan 458 D6, D9, W7): the apex their hostnames live
 * under, and the control-plane paths a box fetches a release or a `lunora-hostd`
 * manifest from. A leaf: the driver, the routes, the session and the studio
 * query all read these from here, so a default or a path has one spelling.
 */
import { fillRoutePath } from "../deploy/route-path";
import stripTrailingSlashes from "../lib/strip-trailing-slashes";

/** The apex box hostnames live under when `LUNORA_BOX_DOMAIN` is unset or empty. */
export const DEFAULT_BOX_DOMAIN = "boxes.lunora.app";

/**
 * The apex box hostnames live under: `{slug}.{domain}` for a box, and
 * `{alias}.{slug}.{domain}` for a tenant on it. An empty `LUNORA_BOX_DOMAIN` is
 * unset — a hostname under `""` would be no hostname at all.
 */
export const boxDomainOf = (environment: { LUNORA_BOX_DOMAIN?: string }): string => {
    const configured = environment.LUNORA_BOX_DOMAIN;

    return configured === undefined || configured === "" ? DEFAULT_BOX_DOMAIN : configured;
};

/** The release-download route; `:deploymentId` is a deployment's id. */
export const BOX_RELEASE_PATH = "/v1/boxes/releases/:deploymentId";

/** The `lunora-hostd` manifest route; `:releaseId` is a release id. */
export const HOSTD_MANIFEST_PATH = "/v1/hostd/releases/:releaseId/manifest";

/** Where a box downloads deployment `deploymentId`'s stored release (a `deploy` job's `releaseUrl`). */
export const boxReleaseUrlOf = (origin: string, deploymentId: string): string =>
    `${stripTrailingSlashes(origin)}${fillRoutePath(BOX_RELEASE_PATH, { deploymentId })}`;

/** Where a box fetches a `lunora-hostd` release's signed envelope (an `upgrade` job's `manifestUrl`). */
export const manifestUrlOf = (origin: string, releaseId: string): string =>
    `${stripTrailingSlashes(origin)}${fillRoutePath(HOSTD_MANIFEST_PATH, { releaseId })}`;
