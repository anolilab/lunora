import type { CallExpression, Project, SourceFile } from "ts-morph";

import type { ExposeCacheIR, FunctionIR, ValidatorIR } from "../../ir";
import sanitizeNamespace from "../../paths";
import { listLunoraSourceFiles, lunoraRelativePath } from "../ast";
import type { LifecycleMoment } from "./classify-procedure-call";
import { classifyProcedureCall } from "./classify-procedure-call";
import { argsFromBuilderChain, outputFromBuilderChain, returnTypeFromBuilderCall, returnTypeFromCall } from "./internal/builder-chain";
import { argsFromCall, exposeFromBuilderChain } from "./internal/expose";
import { exportCallsOfDeclaration, resolveExpressionToCall } from "./internal/resolve-call";

interface DiscoveredFunction {
    args: Record<string, ValidatorIR>;
    /** Set when the builder chain includes `.expose({ rest: true })` (plan 167). */
    expose?: { cache?: ExposeCacheIR; rest?: boolean };
    kind: string;
    lifecycle?: LifecycleMoment;
    /** The `.output(validator)` declaration, when the chain has one. */
    output?: ValidatorIR;
    returnType: string;
    visibility: "internal" | "public";
}

/**
 * Classify a top-level `export const x = …` initializer call as a Lunora
 * registration, or `undefined` when it isn't one. Handles both the bare-factory
 * form (`query({...})` / `internalQuery({...})`) and the builder terminal
 * (`c.query(...)`).
 */
const discoverFromCall = (call: CallExpression): DiscoveredFunction | undefined => {
    const classified = classifyProcedureCall(call);

    if (!classified) {
        return undefined;
    }

    // Builder terminal: pull args/return type from the chain; bare factory: from the call.
    if (classified.receiver) {
        const expose = exposeFromBuilderChain(classified.receiver);
        const output = outputFromBuilderChain(classified.receiver);

        return {
            args: argsFromBuilderChain(classified.receiver),
            ...(expose ? { expose } : {}),
            kind: classified.kind,
            ...(output ? { output } : {}),
            returnType: returnTypeFromBuilderCall(call),
            visibility: classified.visibility,
        };
    }

    // Lifecycle hooks (`onConnect`/`onDisconnect`) take a bare handler, not the
    // `{ args, handler }` literal — their args are framework-fixed (empty) and
    // their return is void, so skip the object-literal extraction.
    if (classified.lifecycle) {
        return { args: {}, kind: classified.kind, lifecycle: classified.lifecycle, returnType: "void", visibility: classified.visibility };
    }

    return {
        args: argsFromCall(call),
        kind: classified.kind,
        returnType: returnTypeFromCall(call),
        visibility: classified.visibility,
    };
};

/** Build a {@link FunctionIR} entry from one classified registration call, or `undefined` when it isn't a Lunora registration. */
const functionIrFromCall = (call: CallExpression, exportName: string, relativePath: string): FunctionIR | undefined => {
    const discovered = discoverFromCall(call);

    if (!discovered) {
        return undefined;
    }

    return {
        args: discovered.args,
        exportName,
        filePath: relativePath,
        kind: discovered.kind as FunctionIR["kind"],
        returnType: discovered.returnType,
        ...(discovered.output ? { output: discovered.output } : {}),
        visibility: discovered.visibility,
        ...(discovered.expose ? { expose: discovered.expose } : {}),
        ...(discovered.lifecycle ? { lifecycle: discovered.lifecycle } : {}),
    };
};

/**
 * Lift `export default <procedure>` into a `<module>.default` registration,
 * matching Convex.
 *
 * Only named exports used to be walked, so a module whose sole registration was
 * a default export did not merely lose that entry — the whole module was absent
 * from `api.ts`, and the caller's error read "Property '<module>' does not
 * exist", pointing at a file that was entirely correct.
 *
 * `export = x` is CJS and never a Lunora registration. Non-procedure defaults
 * (`export default cronJobs()`, a workflow registry) classify to `undefined`
 * and are skipped like any other non-registration call.
 */
const defaultExportFunctions = (source: SourceFile, relativePath: string): FunctionIR[] => {
    const found: FunctionIR[] = [];

    for (const assignment of source.getExportAssignments()) {
        if (assignment.isExportEquals()) {
            continue;
        }

        const call = resolveExpressionToCall(assignment.getExpression());
        const entry = call ? functionIrFromCall(call, "default", relativePath) : undefined;

        if (entry) {
            found.push(entry);
        }
    }

    return found;
};

/** Lift every Lunora registration in one source file into {@link FunctionIR} entries. */
const discoverFileFunctions = (source: SourceFile, relativePath: string): FunctionIR[] => {
    const found: FunctionIR[] = [];

    for (const statement of source.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declaration of statement.getDeclarations()) {
            for (const [exportName, call] of exportCallsOfDeclaration(declaration)) {
                const entry = functionIrFromCall(call, exportName, relativePath);

                if (entry) {
                    found.push(entry);
                }
            }
        }
    }

    found.push(...defaultExportFunctions(source, relativePath));

    return found;
};

/**
 * Detect namespace collisions: two distinct file paths that sanitize to the
 * same identifier (e.g. `foo/bar.ts` and `foo-bar.ts` both → `foo_bar`).
 * Without this guard, emit silently produces duplicate `ApiTypes` keys and an
 * ambiguous dispatch table.
 *
 * Migrations are intentionally NOT considered here: the emitted `LUNORA_MIGRATIONS`
 * table keys on the migration `id` (uniqueness-checked separately during migration
 * discovery), not on the sanitized namespace, and `emitServer` aliases imports by
 * exact `filePath`. So a migration-only file that sanitizes to the same namespace
 * as a function file cannot collide — only function↔function pairs can.
 */
const assertNoNamespaceCollision = (functions: ReadonlyArray<FunctionIR>): void => {
    const namespaceOrigins = new Map<string, string>();

    for (const entry of functions) {
        const namespace = sanitizeNamespace(entry.filePath);
        const prior = namespaceOrigins.get(namespace);

        if (prior && prior !== entry.filePath) {
            throw Object.assign(
                new Error(
                    `Namespace collision: "${prior}" and "${entry.filePath}" both resolve to "${namespace}". Rename one of the files so the JS-identifier-sanitized names differ. (note: case-insensitive filesystems may also cause this — \`foo\` and \`FOO\` map to the same identifier)`,
                ),
                { code: "NAMESPACE_COLLISION", name: "LunoraError", paths: [prior, entry.filePath], status: 500 },
            );
        }

        namespaceOrigins.set(namespace, entry.filePath);
    }
};

/**
 * Scan all .ts files under `lunoraDir` (skipping `_generated/` and `schema.ts`)
 * for top-level `export const x = query/mutation/action({...})` registrations.
 */
const discoverFunctions = (project: Project, lunoraDirectory: string): FunctionIR[] => {
    const filePaths = listLunoraSourceFiles(lunoraDirectory);
    const functions: FunctionIR[] = [];

    for (const filePath of filePaths) {
        const source: SourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        functions.push(...discoverFileFunctions(source, relativePath));
    }

    functions.sort((a, b) => `${a.filePath}:${a.exportName}`.localeCompare(`${b.filePath}:${b.exportName}`));

    assertNoNamespaceCollision(functions);

    return functions;
};

export default discoverFunctions;
