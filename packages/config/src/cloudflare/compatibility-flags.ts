/**
 * The `global_fetch_strictly_public` compatibility flag: every global `fetch` from
 * the Worker goes out to the public internet, never to a private or special-use
 * address. `workersCimdFetch()` from `@lunora/auth/cimd/workers` refuses to build
 * without it, and `lunora doctor` checks for it wherever that transport is imported.
 */
const GLOBAL_FETCH_STRICTLY_PUBLIC_FLAG = "global_fetch_strictly_public";

export default GLOBAL_FETCH_STRICTLY_PUBLIC_FLAG;
