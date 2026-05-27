/**
 * Sanitize a file path (relative to the cirrus dir, no extension) into a
 * JS-identifier-safe namespace. Used in three places that MUST agree:
 *  - `emitApi` — namespace key inside `ApiTypes`.
 *  - `emitServer` — module-import alias and dispatch-table key prefix.
 *  - `anyApi` Proxy in `@cirrus/server` — emits `__cirrusRef = "${ns}:${fn}"`.
 *
 * If these ever disagree, runtime dispatch silently misses functions.
 */
export const sanitizeNamespace = (filePath: string): string => filePath.replaceAll(/[^\dA-Za-z]/gu, "_");
