/**
 * One import of a migrated-away platform's SDK still present in `lunora/`
 * source — the input the `migration_stale_import` lint consumes.
 *
 * A half-finished port is the failure mode: the data moved, the functions were
 * rewritten, and one handler still calls the old client. It builds, it
 * typechecks, and at runtime it reads from the platform the app just left.
 * Produced by the codegen feeder; runtime callers don't supply it, so the lint
 * finds nothing there.
 */
export interface AdvisorStaleMigrationImport {
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the import, or `0` when unknown. */
    line: number;
    /** The imported module, e.g. `@supabase/supabase-js`. */
    moduleSpecifier: string;
    /** Which migration guide covers this platform. */
    platform: "convex" | "firebase" | "supabase";
}
