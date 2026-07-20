/**
 * Cloudflare dashboard deep-links.
 *
 * The studio surfaces a read-only mirror of each Cloudflare plane (logs,
 * settings, files, globals, metrics); the infra plane itself — where you edit
 * bindings/secrets, run raw SQL, or read durable analytics — lives in the
 * Cloudflare dashboard. Each panel that overlaps a Cloudflare surface deep-links
 * out to it rather than re-implementing it.
 *
 * `dash.cloudflare.com/?to=/:account/{section}` resolves `:account` to the
 * signed-in account, so a single host-relative path lands on the right page
 * without the studio knowing the account id. The studio cannot read the
 * concrete bucket / database / namespace name client-side, so each link targets
 * its section index page rather than a specific resource.
 */
const CLOUDFLARE_DASH = "https://dash.cloudflare.com/?to=/:account";

/** Workers Observability — the raw, un-attributed request firehose (Logs panel). */
export const CLOUDFLARE_OBSERVABILITY_URL: string = `${CLOUDFLARE_DASH}/workers-and-pages/observability`;

/** Workers & Pages overview — where vars, secrets, and bindings are edited (Settings panel). */
export const CLOUDFLARE_WORKERS_URL: string = `${CLOUDFLARE_DASH}/workers-and-pages`;

/** R2 overview — the bucket list / object browser (Files panel). */
export const CLOUDFLARE_R2_URL: string = `${CLOUDFLARE_DASH}/r2`;

/** D1 overview — the database console for raw SQL / Time-Travel (Globals panel). */
export const CLOUDFLARE_D1_URL: string = `${CLOUDFLARE_DASH}/workers/d1`;

/** Durable Objects overview — the namespace list / analytics (Metrics panel). */
export const CLOUDFLARE_DURABLE_OBJECTS_URL: string = `${CLOUDFLARE_DASH}/workers/durable-objects`;
