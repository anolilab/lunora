/**
 * Cloudflare Access (Zero Trust) — added by `lunora add cloudflare-access`.
 *
 * Feed the verified Cloudflare Access identity into ctx.auth, from whichever of
 * the two Access shapes your deployment uses:
 *
 *   - Access policy attached to the WORKER (covers its custom domains, routes,
 *     workers.dev and preview URLs at once): the identity arrives on the
 *     execution context. Nothing to configure — call createAccessResolver() with
 *     no arguments. `wrangler.jsonc`'s `access.dev` block simulates it locally.
 *   - Hostname-scoped Access APPLICATION: the Cf-Access-Jwt-Assertion header is
 *     verified against your team's JWKS. Pass teamDomain + aud (both required).
 *
 * Wire this into your Worker entry as the `resolveIdentity` option:
 *
 *   import { createAccessResolver } from "@lunora/cloudflare-access";
 *
 *   createWorker({ resolveIdentity: createAccessResolver() });
 *
 * For the hostname-scoped form, set CF_ACCESS_TEAM_DOMAIN in .dev.vars and
 * CF_ACCESS_AUD in your Cloudflare dashboard (then `wrangler secret put
 * CF_ACCESS_AUD`), and pass them below.
 */
import { env } from "cloudflare:workers";

import { createAccessResolver } from "@lunora/cloudflare-access";

/**
 * Build the identity resolver. Used by the Worker entry to authenticate every
 * request through Cloudflare Access.
 *
 * The JWT config is passed only when both env vars are set, so this file works
 * unchanged for a Worker-scoped Access policy (where neither exists and the
 * identity comes off the execution context). Supplying exactly one of the two
 * throws at startup rather than silently skipping verification.
 */
const teamDomain = env.CF_ACCESS_TEAM_DOMAIN as string | undefined;
const aud = env.CF_ACCESS_AUD as string | undefined;

export const resolveIdentity =
    teamDomain === undefined && aud === undefined ? createAccessResolver() : createAccessResolver({ aud: aud as string, teamDomain: teamDomain as string });
