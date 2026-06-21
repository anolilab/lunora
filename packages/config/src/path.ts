/**
 * Tiny internal indirection so the validator does not depend on `node:path`
 * directly — keeps the import surface predictable when bundled.
 */
export { join as default } from "node:path";
