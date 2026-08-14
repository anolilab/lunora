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
import { createAccessResolver } from "@lunora/cloudflare-access";

/**
 * Build the identity resolver. Used by the Worker entry to authenticate every
 * request through Cloudflare Access.
 *
 * Pick ONE of the two forms below and delete the other. They are not
 * interchangeable, and the difference is deliberate: naming the two options at
 * all means "verify JWTs", so if you keep the second form in an environment
 * where the secrets are unset, it throws at startup rather than quietly booting
 * a worker that authenticates nobody.
 */

// Access policy attached to the Worker — the identity arrives on the execution
// context and there is nothing to configure or verify.
export const resolveIdentity = createAccessResolver();

// Hostname-scoped Access application — verify the Cf-Access-Jwt-Assertion JWT.
// Uncomment, and add `import { env } from "cloudflare:workers";` above.
// export const resolveIdentity = createAccessResolver({
//     teamDomain: env.CF_ACCESS_TEAM_DOMAIN as string,
//     aud: env.CF_ACCESS_AUD as string,
// });
