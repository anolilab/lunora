/**
 * PROTOTYPE (plan 247, design spike) — not part of `@lunora/bindings`'s public
 * subpath exports (`package.json` "exports" has no `./event-store" entry).
 * Kept as an internal barrel, matching the package's per-binding folder
 * convention, so the prototype reads the same as every shipped subpath.
 */
export { defineEventStore } from "./define-event-store";
export type { EventStore, EventStoreColumnType, EventStoreConfig, EventStoreRecord, EventStoreSchema } from "./types";
