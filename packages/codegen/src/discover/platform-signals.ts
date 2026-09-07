import type { Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listLunoraSourceFiles, unwrapExpression } from "./ast";
import { contextPropertiesRead } from "./feature-usage";

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

/**
 * The object literal `node` denotes: itself, or — when it is an identifier —
 * the initializer of a same-named variable declared in this file.
 *
 * Hoisting the options out of the call (`const streamOptions = { durable: true }`)
 * is ordinary style and used to slip the gate entirely, so the stream ran as
 * ephemeral on a host with no durable stream storage and nothing said so. The
 * lookup is by NAME within the file rather than through the type checker: this
 * walk runs over every call in every source, a same-named local elsewhere can
 * only ever over-report, and over-reporting here is a diagnostic while
 * under-reporting is a silent behavioural change on the deployed host — the same
 * trade {@link declaresDurable} already makes for a non-literal value.
 */
const resolveObjectLiteral = (sourceFile: SourceFile, node: Node | undefined): Node | undefined => {
    const expression = unwrapExpression(node);

    if (expression === undefined || !Node.isIdentifier(expression)) {
        return expression;
    }

    const name = expression.getText();

    return unwrapExpression(
        sourceFile
            .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
            .find((declaration) => declaration.getName() === name)
            ?.getInitializer(),
    );
};

/**
 * True when `node` is an object literal declaring a durable stream.
 *
 * The KEY's presence is not enough: `{ durable: false }` is an app explicitly
 * opting out, and treating it as a declaration hard-failed the build for a
 * feature the app said it does not want. A value that is not a literal `false`
 * counts (a shorthand `{ durable }`, a variable, `{ durable: { … } }` — the
 * documented long form) because nothing here can evaluate it, and over-reporting
 * a declaration is a diagnostic while under-reporting one is a silent
 * behavioural change on the deployed host.
 */
const declaresDurable = (node: Node | undefined): boolean =>
    node !== undefined &&
    Node.isObjectLiteralExpression(node) &&
    node.getProperties().some((property) => {
        if (Node.isShorthandPropertyAssignment(property)) {
            return property.getName() === "durable";
        }

        if (!Node.isPropertyAssignment(property) || property.getName() !== "durable") {
            return false;
        }

        const initializer = property.getInitializer();

        return initializer === undefined || unwrapExpression(initializer)?.getText() !== "false";
    });

/**
 * Discover the two AST-only platform signals in one pass over the `lunora/`
 * source set.
 *
 * `durableStreams` matches any `stream(...)` call — the bare `stream({ … })`
 * form and the builder terminal `.stream(handler, { durable: true })` alike —
 * with a `durable` key in one of its options objects, written inline or
 * {@link resolveObjectLiteral | hoisted into a variable}. Deliberately
 * syntactic: `durable` is not carried in any IR (the emitted registry reads it
 * off the user's own registration object at runtime), so there is nothing else
 * to key on.
 */
const discoverPlatformSignals = (project: Project, lunoraDirectory: string): PlatformCodeSignals => {
    const signals: PlatformCodeSignals = { durableStreams: false, secrets: false };

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        if (!signals.secrets) {
            // The sibling walk `discoverFeatureUsage` uses for the same job, not
            // a third copy of it: it resolves the handler's context by binding,
            // so `{ ctx: context }` and `{ ctx: { secrets } }` count as much as
            // `ctx.secrets`. Reads spelled any other way used to slip past this
            // gate into exactly the surface-that-throws-on-first-use the
            // `secrets` rating exists to refuse.
            signals.secrets = contextPropertiesRead(sourceFile).has("secrets");
        }

        if (!signals.durableStreams) {
            signals.durableStreams = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
                const callee = call.getExpression();
                const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();

                return name === "stream" && call.getArguments().some((argument) => declaresDurable(resolveObjectLiteral(sourceFile, argument)));
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
