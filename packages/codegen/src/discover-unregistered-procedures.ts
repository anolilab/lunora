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

const findingFor = (relativePath: string, exportName: string, typeName: string, line: number): Finding => {
    return {
        cacheKey: `procedure_not_registered:${relativePath}:${exportName}`,
        categories: ["SCHEMA"],
        description:
            "Codegen registers an export only when its initializer is literally a builder chain. A procedure produced any other way exists at runtime but never reaches `_generated/api.ts`, so no caller can address it.",
        detail: `\`${exportName}\` in \`${relativePath}\` (line ${line.toString()}) has type \`${typeName}\` but was not registered — codegen recognises a procedure only when the initializer is a builder chain, and this one is produced by a call or an alias.`,
        facing: "INTERNAL",
        level: "WARN",
        metadata: { exportName, filePath: relativePath, line, typeName },
        name: "procedure_not_registered",
        remediation: `Assign the builder chain directly: \`export const ${exportName} = query.input({ … }).query(handler);\`. A factory that returns a procedure cannot be read statically — inline it, or export the chain the factory builds.`,
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
                findings.push(findingFor(relativePath, exportName, typeName, declaration.getStartLineNumber()));
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
            findings.push(findingFor(relativePath, "default", typeName, assignment.getStartLineNumber()));
        }
    }

    return findings;
};

const fileFindings = (source: SourceFile, relativePath: string, registered: ReadonlySet<string>): Finding[] => [
    ...namedExportFindings(source, relativePath, registered),
    ...defaultExportFindings(source, relativePath, registered),
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
