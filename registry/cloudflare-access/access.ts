/**
 * Cloudflare Access (Zero Trust) — added by `lunora add cloudflare-access`.
 *
 * Verify the Cf-Access-Jwt-Assertion header from Cloudflare Access against
 * your team's JWKS, and feed the verified identity into ctx.auth.
 *
 * Wire this into your Worker entry as the `resolveIdentity` option:
 *
 *   import { createAccessResolver } from "@lunora/cloudflare-access";
 *
 *   createWorker({
 *     resolveIdentity: createAccessResolver({
 *       teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
 *       aud: env.CF_ACCESS_AUD,
 *       // isAdmin: (claims) => claims.groups?.includes("lunora-admins") ?? false,
 *     }),
 *   });
 *
 * Set CF_ACCESS_TEAM_DOMAIN in .dev.vars and CF_ACCESS_AUD in your
 * Cloudflare dashboard (then `wrangler secret put CF_ACCESS_AUD`).
 */
import { env } from "cloudflare:workers";

import { createAccessResolver } from "@lunora/cloudflare-access";

/**
 * Build the identity resolver from env vars. Used by the Worker entry
 * to verify the Cf-Access-Jwt-Assertion on every request.
 */
export const resolveIdentity = createAccessResolver({
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN as string,
    aud: env.CF_ACCESS_AUD as string,
});
