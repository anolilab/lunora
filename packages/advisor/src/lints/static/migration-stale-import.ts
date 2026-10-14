import emit from "../../finding";
import type { Lint } from "../../types";

/** Which guide to point at, per platform. */
const GUIDES = {
    convex: "migrating/from-convex",
    firebase: "migrating/from-firebase",
    supabase: "migrating/from-supabase",
} as const;

/**
 * Flags a migrated-away platform's SDK still imported from `lunora/` source.
 *
 * This is what a half-finished port looks like from the outside: the data moved,
 * most handlers were rewritten, and one still imports `@supabase/supabase-js` or
 * `firebase/firestore`. Nothing fails — it compiles, it typechecks, and the app
 * quietly keeps reading from the platform it just left, so the two stores drift
 * apart until someone notices stale data.
 *
 * Only the three platforms with migration guides are flagged. The lint exists to
 * catch an unfinished migration, not to police which libraries an app uses, so a
 * deliberate second data source is out of its scope.
 *
 * Runs only when the codegen feeder supplies `staleMigrationImports`; a runtime
 * caller flags nothing. One finding per import.
 */
const migrationStaleImport: Lint = {
    categories: ["SCHEMA"],
    description:
        "A migrated-away platform's SDK is still imported from `lunora/` source. The code compiles and typechecks, so a half-finished port keeps reading from the old platform at runtime and the two stores silently drift apart.",
    facing: "INTERNAL",
    level: "WARN",
    name: "migration_stale_import",
    remediation:
        "Replace the call with its Lunora equivalent and drop the dependency. If the import is deliberate — a second data source you still read from — move it out of `lunora/` so it is not mistaken for an unfinished migration.",
    run: (context) => {
        if (context.staleMigrationImports === undefined) {
            return [];
        }

        return context.staleMigrationImports.map((staleImport) =>
            emit(migrationStaleImport, {
                cacheKey: `migration_stale_import:${staleImport.file}:${staleImport.line.toString()}:${staleImport.moduleSpecifier}`,
                detail: `\`${staleImport.file}\` (line ${staleImport.line.toString()}) still imports \`${staleImport.moduleSpecifier}\`. Finish the port — see \`${GUIDES[staleImport.platform]}\` — or move the import out of \`lunora/\` if you genuinely still read from ${staleImport.platform}.`,
                metadata: { file: staleImport.file, line: staleImport.line, moduleSpecifier: staleImport.moduleSpecifier, platform: staleImport.platform },
            }),
        );
    },
    source: "static",
    title: "Stale migration import",
};

export default migrationStaleImport;
