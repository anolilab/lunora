import type { Finding } from "@lunora/advisor";
import type { Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node } from "ts-morph";

import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { FunctionIR } from "./ir";

/**
 * The types `@lunora/server`'s builder chains terminate in. A binding whose
 * TYPE is one of these is a registered procedure no matter how the value was
 * produced — which is the whole point: the syntactic scan can be fooled by a
 * factory, the type cannot.
 */
const REGISTERED_TYPE_NAMES = new Set(["RegisteredAction", "RegisteredMutation", "RegisteredQuery"]);

/**
 * The registration type of a binding, or `undefined` when it is not one.
 *
 * Resolves through the alias symbol first so a re-exported or locally aliased
 * `RegisteredQuery` still matches. When the type cannot be resolved at all
 * (`@lunora/server` not installed, a project assembled without a tsconfig) the
 * type is an error type whose symbol matches nothing — so this reports nothing
 * rather than reporting everything, which is the right way to fail.
 */
const registrationTypeName = (node: Node): string | undefined => {
    const type = node.getType();
    const name = type.getAliasSymbol()?.getName() ?? type.getSymbol()?.getName();

    return name !== undefined && REGISTERED_TYPE_NAMES.has(name) ? name : undefined;
};

/**
 * Whether this declaration is worth type-checking.
 *
 * `getType()` runs the checker, which is far more expensive than the rest of
 * codegen's syntactic passes, so it is spent only on the shapes that can
 * actually hide a registration: a call the scan did not recognise
 * (`export const x = makeQuery(...)`) or an identifier aliasing one
 * (`export const x = y`). Literals, arrow functions, objects and arrays are
 * skipped without touching the checker.
 */
const mayHideRegistration = (declaration: VariableDeclaration): boolean => {
    const initializer = declaration.getInitializer();

    if (initializer === undefined) {
        return false;
    }

    return Node.isCallExpression(initializer) || Node.isIdentifier(initializer) || Node.isPropertyAccessExpression(initializer);
};

/** Why codegen could not see this one, and what to write instead. */
type MissedRegistration = { cause: string; remediation: string };

const INDIRECT_INITIALIZER: MissedRegistration = {
    cause: "codegen recognises a procedure only when the initializer is a builder chain, and this one is produced by a call or an alias",
    remediation: "A factory that returns a procedure cannot be read statically — inline it, or export the chain the factory builds.",
};

const SEPARATE_EXPORT_STATEMENT: MissedRegistration = {
    cause: "the binding is exported by a separate `export { … }` statement, and codegen reads the `export` keyword on the declaration itself",
    remediation: "Move the keyword onto the declaration and drop the separate export statement.",
};

const findingFor = (relativePath: string, exportName: string, typeName: string, line: number, missed: MissedRegistration): Finding => {
    return {
        cacheKey: `procedure_not_registered:${relativePath}:${exportName}`,
        categories: ["SCHEMA"],
        description:
            "Codegen registers an export only when the declaration carries `export` and its initializer is literally a builder chain. A procedure written any other way exists at runtime but never reaches `_generated/api.ts`, so no caller can address it.",
        detail: `\`${exportName}\` in \`${relativePath}\` (line ${line.toString()}) has type \`${typeName}\` but was not registered — ${missed.cause}.`,
        facing: "INTERNAL",
        level: "WARN",
        metadata: { exportName, filePath: relativePath, line, typeName },
        name: "procedure_not_registered",
        remediation: `Assign the builder chain directly: \`export const ${exportName} = query.input({ … }).query(handler);\`. ${missed.remediation}`,
        title: "Procedure exists at runtime but is missing from the generated API",
    };
};

/**
 * Report exported bindings that ARE procedures by type but never made it into
 * `api.ts`.
 *
 * Three separate investigations traced back to the same
 * defect. `export default someProcedure` (now registered), `export const x =
 * factory(...)`, and `defineWorkflow(config)` all produced a function that
 * exists at runtime and is absent from the generated API — with codegen exiting
 * 0 and saying nothing. Each time the error surfaced somewhere else entirely
 * ("Property 'x' does not exist"), often in another package, and read as "you
 * named something wrong" rather than "your function was dropped".
 *
 * This is a type-level check rather than a syntactic one, so it cannot be
 * fooled by the very indirection that causes the bug.
 */
const namedExportFindings = (source: SourceFile, relativePath: string, registered: ReadonlySet<string>): Finding[] => {
    const findings: Finding[] = [];

    for (const statement of source.getVariableStatements().filter((entry) => entry.isExported())) {
        for (const declaration of statement.getDeclarations()) {
            const exportName = declaration.getName();

            if (registered.has(`${relativePath}:${exportName}`) || !mayHideRegistration(declaration)) {
                continue;
            }

            const typeName = registrationTypeName(declaration);

            if (typeName !== undefined) {
                findings.push(findingFor(relativePath, exportName, typeName, declaration.getStartLineNumber(), INDIRECT_INITIALIZER));
            }
        }
    }

    return findings;
};

/**
 * `export default buildProcedure()` registers only when the initializer is a
 * readable builder chain, so an unresolvable factory behind a default export is
 * dropped exactly like a named one — and would otherwise be the single shape
 * this check could not see.
 */
const defaultExportFindings = (source: SourceFile, relativePath: string, registered: ReadonlySet<string>): Finding[] => {
    if (registered.has(`${relativePath}:default`)) {
        return [];
    }

    const findings: Finding[] = [];

    for (const assignment of source.getExportAssignments().filter((entry) => !entry.isExportEquals())) {
        const typeName = registrationTypeName(assignment.getExpression());

        if (typeName !== undefined) {
            findings.push(findingFor(relativePath, "default", typeName, assignment.getStartLineNumber(), INDIRECT_INITIALIZER));
        }
    }

    return findings;
};

/**
 * `const handler = query.…; export { handler };` — the export-declaration form.
 *
 * Discovery walks variable statements and asks each whether it `isExported()`,
 * which is false here: the `export` is a separate statement. So the procedure is
 * dropped from `api.ts` exactly like a factory-produced one, and the binding it
 * is dropped from looks like a perfectly ordinary builder chain — which is what
 * makes this shape worse than the ones above rather than merely another of them.
 *
 * The exported name is what a caller addresses, so `export { a as b }` is
 * checked and reported as `b`. Re-exports (`export { x } from "./other"`) are
 * skipped: the declaration lives in another file, and naming this one would send
 * the reader to the wrong place.
 */
const exportDeclarationFindings = (source: SourceFile, relativePath: string, registered: ReadonlySet<string>): Finding[] => {
    const findings: Finding[] = [];

    for (const declaration of source.getExportDeclarations().filter((entry) => entry.getModuleSpecifier() === undefined)) {
        for (const specifier of declaration.getNamedExports()) {
            const exportName = specifier.getAliasNode()?.getText() ?? specifier.getName();

            if (registered.has(`${relativePath}:${exportName}`)) {
                continue;
            }

            const local = specifier.getLocalTargetDeclarations().find((entry): entry is VariableDeclaration => Node.isVariableDeclaration(entry));

            if (local === undefined || !mayHideRegistration(local)) {
                continue;
            }

            const typeName = registrationTypeName(local);

            if (typeName !== undefined) {
                findings.push(findingFor(relativePath, exportName, typeName, specifier.getStartLineNumber(), SEPARATE_EXPORT_STATEMENT));
            }
        }
    }

    return findings;
};

const fileFindings = (source: SourceFile, relativePath: string, registered: ReadonlySet<string>): Finding[] => [
    ...namedExportFindings(source, relativePath, registered),
    ...defaultExportFindings(source, relativePath, registered),
    ...exportDeclarationFindings(source, relativePath, registered),
];

const discoverUnregisteredProcedures = (project: Project, lunoraDirectory: string, functions: ReadonlyArray<FunctionIR>): Finding[] => {
    const registered = new Set(functions.map((entry) => `${entry.filePath}:${entry.exportName}`));
    const findings: Finding[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        // Only files the discovery pass already loaded — never add one here, so
        // this stays a read over work that has been done rather than a second
        // parse of the tree.
        const source: SourceFile | undefined = project.getSourceFile(filePath);

        if (source !== undefined) {
            findings.push(...fileFindings(source, lunoraRelativePath(lunoraDirectory, filePath), registered));
        }
    }

    return findings.toSorted((a, b) => a.cacheKey.localeCompare(b.cacheKey));
};

export default discoverUnregisteredProcedures;
