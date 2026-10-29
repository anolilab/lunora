/**
 * The Node transport for `cimd()` (Client ID Metadata Documents), re-exported so
 * an app reaches it through `@lunora/auth` instead of installing `@better-auth/cimd`.
 *
 * Unlike `@lunora/auth/cimd/workers`, it meets cimd's full contract: it resolves the
 * host once, rejects any non-public answer, pins the connection to that address and
 * returns redirects without following them.
 *
 * Kept off the package root (and out of `./plugins`) because it is Node-only: it
 * imports `node:dns`, `node:https` and `node:net`.
 */
export { fetchClientMetadataResource as default } from "@better-auth/cimd/node";
