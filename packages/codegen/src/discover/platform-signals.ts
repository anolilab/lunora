import type { Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listLunoraSourceFiles } from "./ast";

/**
 * Code-usage signals for the platform features that are app-DECLARABLE but have
 * no `ctx.*` capability row — so `discoverFeatureUsage` (keyed off
 * `CAPABILITY_ROWS`) cannot see them and the platform gate had nothing to gate
 * them on.
 *
 * Only the two that need an AST walk live here. `globalTables`, `queues` and
 * `crossShardFanout` are read straight off the schema/queue IR by the caller.
 */
interface PlatformCodeSignals {
    /** A `.stream(handler, { durable: … })` registration — a persisted, socket-outliving stream run. */
    durableStreams: boolean;
    /** A `ctx.secrets` read — the Secrets Store facade, which needs a host binding. */
    secrets: boolean;
}

/** True when `node` is an object literal carrying a `durable` property. */
const declaresDurable = (node: Node): boolean =>
    Node.isObjectLiteralExpression(node) &&
    node
        .getProperties()
        .some((property) => (Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property)) && property.getName() === "durable");

/**
 * Discover the two AST-only platform signals in one pass over the `lunora/`
 * source set.
 *
 * `durableStreams` matches any `stream(...)` call — the bare `stream({ … })`
 * form and the builder terminal `.stream(handler, { durable: true })` alike —
 * with a `durable` key in one of its object-literal arguments. Deliberately
 * syntactic: `durable` is not carried in any IR (the emitted registry reads it
 * off the user's own registration object at runtime), so there is nothing else
 * to key on.
 */
const discoverPlatformSignals = (project: Project, lunoraDirectory: string): PlatformCodeSignals => {
    const signals: PlatformCodeSignals = { durableStreams: false, secrets: false };

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        if (!signals.secrets) {
            signals.secrets = sourceFile
                .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
                .some((access) => access.getName() === "secrets" && Node.isIdentifier(access.getExpression()) && access.getExpression().getText() === "ctx");
        }

        if (!signals.durableStreams) {
            signals.durableStreams = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
                const callee = call.getExpression();
                const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();

                return name === "stream" && call.getArguments().some((argument) => declaresDurable(argument));
            });
        }

        if (signals.durableStreams && signals.secrets) {
            break;
        }
    }

    return signals;
};

export type { PlatformCodeSignals };
export { discoverPlatformSignals };
