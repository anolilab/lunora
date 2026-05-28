/**
 * Re-export of drizzle's SQLite schema-definition surface.
 *
 * Codegen emits `_generated/drizzle.{shard,global}.ts` importing column and
 * index builders (`sqliteTable`, `text`, `integer`, `index`, …) from here
 * rather than from `drizzle-orm/sqlite-core` directly. Apps already depend on
 * `@cirrus/server`, so the generated files resolve without each app having to
 * declare `drizzle-orm` itself.
 */
export * from "drizzle-orm/sqlite-core";
