import { LunoraError } from "@lunora/errors";
import type { CallExpression, Project, SourceFile } from "ts-morph";
import { Node } from "ts-morph";

import declaredOutputWins from "../../declared-output";
import type { ExposeCacheIR, FunctionIR, ValidatorIR } from "../../ir";
import { sanitizeNamespace } from "../../paths";
import { listLunoraSourceFiles, lunoraRelativePath } from "../ast";
import { exportNamesByLocalOf, isAddressableExportName } from "../attribution";
import { collectErasures, reportErasures } from "../erased-returns";
import type { LifecycleMoment } from "./classify-procedure-call";
import { classifyProcedureCall } from "./classify-procedure-call";
import { argsFromBuilderChain, outputFromBuilderChain, returnTypeFromBuilderCall, returnTypeFromCall } from "./internal/builder-chain";
import { argsFromCall, exposeFromBuilderChain } from "./internal/expose";
import { exportCallsOfDeclaration, resolveExpressionToCall } from "./internal/resolve-call";

interface DiscoveredFunction {
    /** Set when the builder chain carries `.use(platformAdmin(...))` — see `classifyProcedureCall`. */
    adminOnly?: true;
    args: Record<string, ValidatorIR>;
    /** A channel registration (`defineRoom`): its kind and literal name. */
    channel?: { kind: "room"; name: string };
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

/**
 * The literal `name` of a `defineRoom({ name: "…" })` call. The name is the room's
 * whisper-topic key and the `connectRoom` reference, so codegen must read it at
 * build time: a computed name cannot be typed or deduplicated.
 */
const roomNameOf = (call: CallExpression): string => {
    const options = call.getArguments()[0];
    const name = Node.isObjectLiteralExpression(options) ? options.getProperty("name") : undefined;
    const initializer = Node.isPropertyAssignment(name) ? name.getInitializer() : undefined;

    if (!initializer || !Node.isStringLiteral(initializer)) {
        throw new LunoraError(
            "ROOM_NAME_NOT_LITERAL",
            'defineRoom needs a string-literal `name` (e.g. `defineRoom({ name: "chat", … })`) so codegen can type its reference.',
        );
    }

    return initializer.getLiteralValue();
};

const discoverFromCall = (call: CallExpression): DiscoveredFunction | undefined => {
    const classified = classifyProcedureCall(call);

    if (!classified) {
        return undefined;
    }

    if (classified.channel) {
        return {
            args: {},
            channel: { kind: classified.channel, name: roomNameOf(call) },
            kind: classified.kind,
            returnType: "void",
            visibility: classified.visibility,
        };
    }

    // Builder terminal: pull args/return type from the chain; bare factory: from the call.
    const { receiver } = classified;

    if (receiver) {
        const expose = exposeFromBuilderChain(receiver);
        // Both types are computed, but `api.ts` carries only one of them — see
        // `declaredOutputWins`. An erasure in the other reaches nothing, so it is
        // not reported: the handler behind a declared output, or the inert
        // `.output()` of a `stream`.
        const output = collectErasures(() => outputFromBuilderChain(receiver));
        const returnType = collectErasures(() => returnTypeFromBuilderCall(call));
        const outputWins = declaredOutputWins({ kind: classified.kind, output: output.value });

        reportErasures(outputWins ? output.erased : returnType.erased);

        return {
            args: argsFromBuilderChain(receiver),
            ...(expose ? { expose } : {}),
            ...(classified.adminOnly ? { adminOnly: true as const } : {}),
            kind: classified.kind,
            ...(output.value ? { output: output.value } : {}),
            returnType: returnType.value,
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
        ...(discovered.adminOnly ? { adminOnly: true as const } : {}),
        ...(discovered.expose ? { expose: discovered.expose } : {}),
        ...(discovered.lifecycle ? { lifecycle: discovered.lifecycle } : {}),
        ...(discovered.channel ? { channel: discovered.channel } : {}),
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

/**
 * Lift every Lunora registration in one source file into {@link FunctionIR}
 * entries, each under every name the module exports its binding under
 * ({@link exportNamesByLocalOf}): `export const x = …` as `x`,
 * `const run = query(…); export { run as start }` as `start`,
 * `export { run as default }` / `export default run` as `default`. Those are the
 * names the emitted `api.ts` and dispatch table read off the module namespace.
 * A name that is not an identifier (`export { run as "kebab-name" }`) cannot be
 * emitted that way and is left to `procedure_not_registered`.
 */
const discoverFileFunctions = (source: SourceFile, relativePath: string): FunctionIR[] => {
    const exportNames = exportNamesByLocalOf(source);
    // The call each room name was first registered by. Two export names of one call are aliases of
    // one room; two different calls under one name are a clash, which the emitters cannot represent.
    const roomCalls = new Map<string, CallExpression>();
    const found = source
        .getVariableStatements()
        .flatMap((statement) => statement.getDeclarations())
        .flatMap((declaration) => exportCallsOfDeclaration(declaration, (localName) => exportNames.has(localName)))
        .flatMap(([localName, call]) =>
            (exportNames.get(localName) ?? [])
                .filter((name) => isAddressableExportName(name))
                .flatMap((name) => {
                    const entry = functionIrFromCall(call, name, relativePath);

                    if (entry?.channel !== undefined) {
                        const prior = roomCalls.get(entry.channel.name);

                        if (prior !== undefined && prior !== call) {
                            throw new LunoraError(
                                "DUPLICATE_ROOM_NAME",
                                `Duplicate room name "${entry.channel.name}" in ${relativePath}: two defineRoom calls share it. Room names must be unique.`,
                            );
                        }

                        roomCalls.set(entry.channel.name, call);
                    }

                    return entry ? [entry] : [];
                }),
        );
    const named = new Set(found.map((entry) => entry.exportName));

    // `export default <expression>` that is not a local binding.
    found.push(...defaultExportFunctions(source, relativePath).filter((entry) => !named.has(entry.exportName)));

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

/**
 * Two `defineRoom`s under one name would share a whisper topic, and the generated
 * room map would keep whichever came last. Caught here, at build time, naming both.
 *
 * Two exports of one module under one name are an alias of a single registration
 * (`export const lobby = chat`), so they are not a clash here; the generated room
 * map checks that they are one object at load. Across modules the same name is a
 * clash, since a re-export is not visible to discovery.
 */
const assertUniqueRoomNames = (functions: ReadonlyArray<FunctionIR>): void => {
    const origins = new Map<string, { file: string; origin: string }>();

    for (const entry of functions) {
        if (entry.channel?.kind !== "room") {
            continue;
        }

        const prior = origins.get(entry.channel.name);

        if (prior !== undefined && prior.file !== entry.filePath) {
            throw new LunoraError(
                "DUPLICATE_ROOM_NAME",
                `Duplicate room name "${entry.channel.name}": defined in ${prior.origin} and ${entry.filePath}:${entry.exportName}. Room names must be unique across the project.`,
            );
        }

        if (prior === undefined) {
            origins.set(entry.channel.name, { file: entry.filePath, origin: `${entry.filePath}:${entry.exportName}` });
        }
    }
};

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
    assertUniqueRoomNames(functions);

    return functions;
};

export default discoverFunctions;
