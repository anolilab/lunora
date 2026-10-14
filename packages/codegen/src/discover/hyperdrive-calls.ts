import type { Project } from "ts-morph";

import type { ContextPropertyCallIR } from "../ir";
import discoverContextPropertyCalls from "./context-property-calls";

/**
 * Discover Hyperdrive `ctx.sql` accesses inside exported `query(...)` /
 * `mutation(...)` handlers — the `hyperdrive_outside_action` lint input.
 *
 * The lint shipped with no feeder at all: it returns `[]` unless
 * `context.hyperdriveCalls` is set, and nothing set it, so the one guardrail
 * against non-deterministic external SQL in a reactive handler never fired.
 * `ctx.sql` is typed on `ActionCtx` only, so `action(...)` bodies are skipped by
 * the shared walker — an access there is correct usage, not a finding.
 */
const discoverHyperdriveCalls = (project: Project, lunoraDirectory: string): ContextPropertyCallIR[] =>
    discoverContextPropertyCalls(project, lunoraDirectory, "sql");

export default discoverHyperdriveCalls;
