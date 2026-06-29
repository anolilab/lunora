import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CallExpression, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isDefineMutatorCallee, MUTATORS_FILENAME } from "./discover-mutators";
import type { MutatorWriteIR } from "./ir";

/**
 * True for a `ctx.db.replace(...)` (or bare `db.replace(...)`) call — the
 * whole-row write entry point. The receiver must be `.db` so unrelated
 * `.replace(...)` calls (e.g. `string.replace`) don't match. Mirrors
 * `discover-inserts`' `isDatabaseInsertCall`, narrowed to `replace`.
 */
const isDatabaseReplaceCall = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "replace") {
        return false;
    }

    const receiver = callee.getExpression();

    if (Node.isPropertyAccessExpression(receiver)) {
        return receiver.getName() === "db";
    }

    return Node.isIdentifier(receiver) && receiver.getText() === "db";
};

/**
 * The `server` property value node of a `defineMutator({ server })` call, or
 * `undefined` when the call has no inline object arg / `server` property. The
 * authoritative impl is the only place `ctx.db.replace` is meaningful — the
 * `client` twin writes through the TanStack collections, never `ctx.db` — so the
 * lint scopes its scan there.
 */
const serverImplNode = (call: CallExpression): Node | undefined => {
    const argument = call.getArguments()[0];

    if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
        return undefined;
    }

    const property = argument.getProperty("server");

    if (property === undefined) {
        return undefined;
    }

    // `server: (ctx, args) => {…}` (PropertyAssignment → initializer) or the
    // method shorthand `server(ctx, args) {…}` (MethodDeclaration → itself).
    return Node.isPropertyAssignment(property) ? property.getInitializer() : property;
};

/**
 * The exported `defineMutator(...)` call an exported variable declaration binds,
 * or `undefined` when the declaration isn't an exported mutator definition.
 */
const exportedDefineMutatorCall = (declaration: VariableDeclaration): CallExpression | undefined => {
    if (!declaration.isExported()) {
        return undefined;
    }

    const initializer = declaration.getInitializer();

    if (initializer?.getKind() !== SyntaxKind.CallExpression) {
        return undefined;
    }

    const call = initializer as CallExpression;

    return isDefineMutatorCallee(call.getExpression()) ? call : undefined;
};

/** Collect the whole-row `replace` writes inside one exported mutator's `server` impl. */
const writesFromDeclaration = (declaration: VariableDeclaration): MutatorWriteIR[] => {
    const call = exportedDefineMutatorCall(declaration);
    const serverImpl = call === undefined ? undefined : serverImplNode(call);

    if (serverImpl === undefined) {
        return [];
    }

    const nameNode = declaration.getNameNode();
    const exportName = Node.isIdentifier(nameNode) ? nameNode.getText() : "";

    return serverImpl
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((replaceCall) => isDatabaseReplaceCall(replaceCall))
        .map((replaceCall) => {
            return { exportName, file: "lunora/mutators.ts", line: replaceCall.getStartLineNumber() };
        });
};

/** Collect the whole-row `replace` writes from every exported `defineMutator` in one source file. */
const mutatorWritesFromSource = (source: SourceFile): MutatorWriteIR[] =>
    source.getVariableDeclarations().flatMap((declaration) => writesFromDeclaration(declaration));

/**
 * Discover whole-row `ctx.db.replace(...)` writes inside custom mutators'
 * authoritative `server` impls (`lunora/mutators.ts`) — the
 * `mutator_full_row_replace` advisor input. Returns `[]` when the file doesn't
 * exist. Each `replace` is attributed to the mutator export performing it so the
 * lint can steer a developer toward column-level `ctx.db.patch(id, { field })`.
 */
const discoverMutatorWrites = (project: Project, lunoraDirectory: string): MutatorWriteIR[] => {
    const mutatorsPath = join(lunoraDirectory, MUTATORS_FILENAME);

    if (!existsSync(mutatorsPath)) {
        return [];
    }

    const source = project.getSourceFile(mutatorsPath) ?? project.addSourceFileAtPath(mutatorsPath);

    return mutatorWritesFromSource(source);
};

export default discoverMutatorWrites;
