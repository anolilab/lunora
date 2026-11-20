/**
 * How long a release or install key, and an install's claim on a project, stays
 * valid. One value, so the claim outlives the key it was issued for and a crashed
 * install stops blocking its project after the same window its key expires in.
 */
export const RELEASE_LEASE_MS = 35 * 60 * 1000;
