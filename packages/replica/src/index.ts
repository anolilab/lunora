/**
 * \@lunora/replica — Event sourcing runtime + local SQLite mirror for Lunora
 *
 * ## Modules
 *
 * - **EventEmitter** — type-safe event emitter with typed + wildcard listeners.
 * - **EventSource** — event-sourcing runtime that derives state from an
 * append-only log via a reducer.
 * - **SubscriptionManager** — manages state and event-type subscriptions.
 * - **SnapshotStore** — interface + in-memory store for persisting
 * event-sourced state snapshots.
 * - **LocalMirror** — local SQLite mirror that applies typed table diffs.
 * - **EventLog** — append-only log for events and catch-up replication.
 */

// ── Seq types ──────────────────────────────────────────────────────────────

export { createBetterSqlite3Adapter } from "./adapters/better-sqlite3";
export { createSqliteWasmAdapter } from "./adapters/sqlite-wasm";
export { createSqlJsAdapter } from "./adapters/sqljs";
export type { SqliteAdapter } from "./adapters/types";

// ── Event DSL ──────────────────────────────────────────────────────────────

export { applyDiff, applyDiffs, applyDiffToSnapshot } from "./apply-diff";
export type { EventFactory, EventNamespace, EventsDefinition } from "./define-events";

// ── Materializer ───────────────────────────────────────────────────────────

export { defineEvents } from "./define-events";
export type { Materializer, MaterializerDef, MaterializerReducer, MaterializerRuntimeOptions } from "./define-materializer";

// ── Event emitter ──────────────────────────────────────────────────────────

export { defineMaterializer, MaterializerRuntime } from "./define-materializer";

// ── EventSource ────────────────────────────────────────────────────────────

export { applyDiffsToDb, applyDiffToDb } from "./diff-applier";
export { EventEmitter } from "./event-emitter";
export type { AppendOptions, EventLogEntry, EventLogOptions, EventLogSnapshot } from "./event-log";
export { EventLog } from "./event-log";

// ── Server-side Durable Object ────────────────────────────────────────────

export { EventLogDO } from "./event-log-do";

// ── EventLogDO Client ─────────────────────────────────────────────────────

export type { AppendEventInput, EventLogDOClientOptions } from "./event-log-do-client";
export { EventLogDOClient } from "./event-log-do-client";

// ── Snapshot store ─────────────────────────────────────────────────────────

export type { EventSourceEvents } from "./event-source";
export type { EventReducer } from "./event-source";

// ── Events middleware ──────────────────────────────────────────────────────

export type { EventSourceOptions, UnknownEventHandling } from "./event-source";
export { EventSource, UNHANDLED } from "./event-source";

// ── eventsContext ──────────────────────────────────────────────────────────

export type { EventsContextOutput, EventsFacade } from "./events-context";
export { eventsContext } from "./events-context";

// ── EventLog ───────────────────────────────────────────────────────────────

export type { LocalMirrorOptions, MirrorTableDef } from "./local-mirror";
export { LocalMirror } from "./local-mirror";

// ── TableDiff ──────────────────────────────────────────────────────────────

export type { ClientSeq, GlobalSeq, InputEvent, Seq } from "./seq";
export { isClientSeq, isGlobalSeq, isInputEvent } from "./seq";

// ── Apply diff ─────────────────────────────────────────────────────────────

export type { SnapshotStore } from "./snapshot-store";
export { InMemorySnapshotStore } from "./snapshot-store";

// ── SQLite adapter ─────────────────────────────────────────────────────────

export type { SubscriptionClient } from "./subscribe-mirror";
export { subscribeToMirror } from "./subscribe-mirror";

// ── LocalMirror ────────────────────────────────────────────────────────────

export type { EventCallback, StateChangeCallback } from "./subscription";
export { SubscriptionManager } from "./subscription";

// ── Subscription ──────────────────────────────────────────────────────────

export type { EventsSyncOptions } from "./sync-events";
export { EventsSync } from "./sync-events";

// ── EventsSync ────────────────────────────────────────────────────────────

export type { RowChange, TableDiff } from "./table-diff";
export { classifyChanges, createTableDiff, diffSize, isDiffEmpty, mergeDiffs } from "./table-diff";
