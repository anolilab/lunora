/**
 * Which backend a `.global()` table lives on, asked as a predicate rather than
 * re-derived per call site.
 *
 * The two facts drive different wiring everywhere they are read — the D1 flavour
 * needs the `DB` binding, `@lunora/d1` and the app's `.global({ d1 })` chain; the
 * Hyperdrive flavour needs the `HYPERDRIVE` binding, `@lunora/hyperdrive` and
 * `.hyperdriveGlobal(...)` — and codegen, the CLI and `@lunora/config` all have
 * to agree on which table is which, or a project is told to add a binding it
 * does not need and blocked for missing a chain it should never write.
 *
 * The correctness detail worth centralising: the D1 side reads `!== "hyperdrive"`
 * rather than `=== "d1"`, because {@link TableIR.globalBackend} is optional and
 * hand-built IR may omit it. Discovery normalises it (`globalBackend: shardMode
 * === "global" ? (accumulator.globalBackend ?? "d1") : undefined`), so the two
 * forms agree on discovered schemas and only the negative form is right for the
 * rest.
 */
import type { TableIR } from "./ir";

/** A `.global()` table backed by D1 — the default when no `backend` is named. */
const isD1GlobalTable = (table: TableIR): boolean => table.shardMode === "global" && table.globalBackend !== "hyperdrive";

/** A `.global({ backend: "hyperdrive" })` table — Postgres/MySQL via Cloudflare Hyperdrive. */
const isHyperdriveGlobalTable = (table: TableIR): boolean => table.shardMode === "global" && table.globalBackend === "hyperdrive";

export { isD1GlobalTable, isHyperdriveGlobalTable };
