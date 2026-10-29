/**
 * Why a vector index on a `.global()` table is refused — one wording for the two
 * places that refuse it: `defineSchema` at runtime (`@lunora/server`) and schema
 * discovery at generate time (`@lunora/codegen`), which share no runtime edge.
 */
export const globalVectorIndexMessage = (table: string, index: string): string =>
    `table "${table}" is .global() and declares vector index "${index}". Vector sync runs on the shard write path, which a global (D1/Hyperdrive) table's writes never take — the index would stay empty. Drop .global(), or keep the index yourself with ctx.vectors.upsert/deleteByIds.`;
