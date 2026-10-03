import type { Node as TsNode, Project, PropertyAccessExpression, SourceFile, VariableDeclaration } from "ts-morph";
import { Node } from "ts-morph";

import type { FlagReadIR } from "../ir";
import { handlerOf, listLunoraSourceFiles, lunoraRelativePath } from "./ast";
import { exportedVariableDeclarationsOf, primaryExportName } from "./attribution";
import { contextSurfaceNodesIn } from "./context-root";
import { classifyProcedureCall } from "./functions/classify-procedure-call";

/** One resolved query handler with its attribution. */
interface ResolvedQuery {
    exportName: string;
    handler: TsNode;
}

/**
 * The query handler of an exported variable declaration, with its export name, or
 * `undefined` when the declaration isn't an exported `query(...)` with a
 * statically recognisable handler.
 *
 * `mutation(...)` / `action(...)` / `stream(...)` return `undefined`, which is the
 * one place this feeder narrows further than its `discoverR2sqlCalls` /
 * `discoverNondeterministicCalls` siblings: those record `query` **and**
 * `mutation` because both kinds produce a finding (at different levels). A flag
 * read in a mutation has no subscription-staleness hazard at all — the handler
 * runs once, and a point-in-time evaluation for a point-in-time call is simply
 * correct — so recording mutations here would only feed the lint rows it must
 * discard. Filtering at the feeder is why {@link FlagReadIR} carries no `kind`.
 */
const exportedQueryHandler = (declaration: VariableDeclaration): ResolvedQuery | undefined => {
    const initializer = declaration.getInitializer();

    if (!initializer || !Node.isCallExpression(initializer)) {
        return undefined;
    }

    // Shared classification (kind + builder receiver) — single source of truth
    // with function discovery and the other handler-scoped feeders.
    const classified = classifyProcedureCall(initializer);

    if (classified?.kind !== "query") {
        return undefined;
    }

    const handler = handlerOf(initializer, classified.receiver);

    return handler ? { exportName: primaryExportName(declaration), handler } : undefined;
};

/**
 * The property access that has `node` as its receiver (`node.<name>`), or
 * `undefined` when `node` is not itself the receiver of a member access. Used to
 * walk outwards from the `ctx.flags` node to the method actually invoked.
 */
const memberOn = (node: TsNode): PropertyAccessExpression | undefined => {
    const parent = node.getParent();

    return parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === node ? parent : undefined;
};

/**
 * The `ctx.flags` callee label for a property access, or `undefined` when the
 * access is not `ctx.flags`. A direct evaluation (`ctx.flags.boolean(...)`) yields
 * `ctx.flags` suffixed with the method (`ctx.flags.boolean`); the details variants
 * peel one level further (`ctx.flags.details.string`) so the label names the
 * evaluation performed rather than the namespace it came from; a bare `ctx.flags`
 * (aliased or passed on) yields `ctx.flags`.
 *
 * `access` denotes `ctx.flags` (see `contextSurfaceNodesIn`): the receiver is
 * resolved by symbol, so a renamed ctx (`c.flags`) and a destructured surface
 * (`const { flags } = ctx; flags.boolean(…)`) are recorded too.
 */
const flagReadCalleeOf = (access: TsNode): string => {
    const method = memberOn(access);

    // Bare `ctx.flags` — aliased into a local or handed to a helper. Recorded:
    // the alias exists to be evaluated, and the staleness is identical.
    if (!method) {
        return "ctx.flags";
    }

    // `ctx.flags.details.<method>` — `details` is a namespace, not an evaluation,
    // so peel it and label the method underneath.
    if (method.getName() === "details") {
        const inner = memberOn(method);

        return inner ? `ctx.flags.details.${inner.getName()}` : "ctx.flags.details";
    }

    return `ctx.flags.${method.getName()}`;
};

/** `ctx.flags` read IRs lexically inside one resolved query handler. */
const readsInHandler = (procedure: ResolvedQuery, file: string): FlagReadIR[] => {
    const found: FlagReadIR[] = [];

    // Renamed (`c.flags`) and destructured (`const { flags } = ctx`) surfaces resolve by symbol.
    for (const access of contextSurfaceNodesIn(procedure.handler, "flags")) {
        found.push({ callee: flagReadCalleeOf(access), exportName: procedure.exportName, file, line: access.getStartLineNumber() });
    }

    return found;
};

/** `ctx.flags` read IRs across every exported query in one file. */
const readsInSourceFile = (sourceFile: SourceFile, relativePath: string): FlagReadIR[] => {
    const found: FlagReadIR[] = [];

    for (const declaration of exportedVariableDeclarationsOf(sourceFile)) {
        const procedure = exportedQueryHandler(declaration);

        if (procedure) {
            found.push(...readsInHandler(procedure, relativePath));
        }
    }

    return found;
};

/* eslint-disable no-secrets/no-secrets -- the referenced advisor lint rule id in the doc comment, not a credential */

/**
 * Discover `ctx.flags` reads lexically inside the handler body of every exported
 * `query(...)` registration under the lunora source directory — the
 * `flag_read_in_subscription` lint input.
 *
 * `mutation(...)`, `action(...)` and `stream(...)` registrations are intentionally
 * skipped: a flag read is only hazardous where a live subscription can serve a
 * stale evaluation, and only a query backs one. Flipping a flag appends nothing to
 * `__cdc_log`, so a subscribed query is never re-run on the change; `useFlag` is
 * the reactive path.
 *
 * Traversal is scoped to the handler node (not the whole declaration), mirroring
 * `discoverR2sqlCalls` — so a `ctx.flags` touch in a sibling helper outside the
 * handler is not attributed to the query. One {@link FlagReadIR} is produced per
 * read site.
 */
const discoverFlagReads = (project: Project, lunoraDirectory: string): FlagReadIR[] => {
    const reads: FlagReadIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        reads.push(...readsInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return reads;
};

export default discoverFlagReads;

/* eslint-enable no-secrets/no-secrets -- re-enable after the discoverFlagReads doc block */
