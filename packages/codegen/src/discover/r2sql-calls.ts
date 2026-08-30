import type { Project } from "ts-morph";

import type { R2sqlCallIR } from "../ir";
import { discoverContextPropertyCalls } from "./context-property-calls";

/**
 * Discover `ctx.r2sql` accesses inside exported `query(...)` / `mutation(...)`
 * handlers — the `r2sql_outside_action` lint input. `action(...)` is the
 * intended home for R2 SQL and is skipped by the shared walker.
 */
const discoverR2sqlCalls = (project: Project, lunoraDirectory: string): R2sqlCallIR[] => discoverContextPropertyCalls(project, lunoraDirectory, "r2sql");

export default discoverR2sqlCalls;
