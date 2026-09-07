/**
 * How much of an upstream response body may be spliced into an error MESSAGE.
 *
 * The codes these errors carry (`ANALYTICS_SQL_ERROR`, `R2_SQL_ERROR`,
 * `WORKFLOWS_REST_ERROR`) are catalogued and non-internal, so `toErrorBody`
 * echoes their `message` verbatim to whoever called the action — an uncapped
 * body puts upstream error text (which routinely quotes the query) or a multi-KB
 * HTML gateway page on the wire to a browser. Each thrower keeps the full body
 * on `cause`, which `toErrorBody` never serialises, so a server-side log still
 * has all of it.
 */
export const MAX_ERROR_BODY_CHARS = 256;

/** Trim `body` to {@link MAX_ERROR_BODY_CHARS}, marking that it was cut. */
export const capErrorBody = (body: string): string => (body.length > MAX_ERROR_BODY_CHARS ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated)` : body);
