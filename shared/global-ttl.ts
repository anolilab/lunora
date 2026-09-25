/**
 * Why `.ttl()` on a `.global()` table is refused — one wording for the two places
 * that refuse it: `defineSchema` at runtime (`@lunora/server`) and schema
 * discovery at generate time (`@lunora/codegen`), which share no runtime edge.
 */
export const globalTtlMessage = (table: string): string =>
    `table "${table}" is both .global() and .ttl(). The TTL sweep is a shard's alarm deleting from that shard's own SQLite, and a global (D1/Hyperdrive) table's rows live outside every shard — so expired rows would never be deleted. Drop .ttl() and expire the rows from a cron, or keep the table shard-local.`;
