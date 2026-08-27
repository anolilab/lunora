import type { Project } from "ts-morph";

import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-ast";
import type { StaleMigrationImportIR } from "./ir";

/**
 * Module prefixes that mean "this app still talks to the platform it migrated
 * away from", mapped to the guide that covers finishing the port.
 *
 * Only the three platforms with migration guides are listed. The lint exists to
 * catch a half-finished migration, not to police library choice, so an app that
 * deliberately reads a second data source is out of scope — it just has to keep
 * that import outside `lunora/`.
 */
const MIGRATED_PLATFORMS: ReadonlyArray<[StaleMigrationImportIR["platform"], ReadonlyArray<string>]> = [
    ["convex", ["convex", "@convex-dev/"]],
    ["supabase", ["@supabase/"]],
    // `firebase-admin` is listed separately because the matcher is exact-or-`prefix/`:
    // the server-side SDK a migrated backend actually imported would not match `firebase`.
    ["firebase", ["firebase", "@firebase/", "firebase-admin"]],
];

/** Does this specifier belong to a migrated-away platform? */
const platformFor = (specifier: string): StaleMigrationImportIR["platform"] | undefined => {
    for (const [platform, prefixes] of MIGRATED_PLATFORMS) {
        for (const prefix of prefixes) {
            // `convex` and `convex/server` both match; `convexity` must not.
            if (specifier === prefix || specifier.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) {
                return platform;
            }
        }
    }

    return undefined;
};

/**
 * Find imports of a migrated-away platform's SDK in `lunora/` source.
 *
 * Reads real import declarations rather than grepping: a specifier is only a
 * specifier when the AST says so, and a mention inside a comment or a string
 * literal is not an import.
 */
const discoverStaleMigrationImports = (project: Project, lunoraDirectory: string): StaleMigrationImportIR[] => {
    const found: StaleMigrationImportIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const declaration of sourceFile.getImportDeclarations()) {
            const moduleSpecifier = declaration.getModuleSpecifierValue();
            const platform = platformFor(moduleSpecifier);

            if (platform !== undefined) {
                found.push({
                    file: lunoraRelativePath(lunoraDirectory, filePath),
                    line: declaration.getStartLineNumber(),
                    moduleSpecifier,
                    platform,
                });
            }
        }
    }

    return found;
};

export default discoverStaleMigrationImports;
