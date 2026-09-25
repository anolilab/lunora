import type { CallExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listLunoraSourceFiles, unwrapExpression } from "./ast";
import { contextPropertiesRead } from "./feature-usage";

/**
 * Code-usage signals for the platform features that are app-DECLARABLE but have
 * no `ctx.*` capability row — so `discoverFeatureUsage` (keyed off
 * `CAPABILITY_ROWS`) cannot see them and the platform gate had nothing to gate
 * them on.
 *
 * Only the ones that need an AST walk live here. `globalTables`, `queues` and
 * `crossShardFanout` are read straight off the schema/queue IR by the caller.
 */
interface PlatformCodeSignals {
    /** A `defineContainer` call carrying an egress policy (`allowedHosts` / `deniedHosts` / `interceptHttps`). */
    containerEgressPolicy: boolean;
    /** A `.stream(handler, { durable: … })` registration — a persisted, socket-outliving stream run. */
    durableStreams: boolean;
    /** A `ctx.secrets` read — the Secrets Store facade, which needs a host binding. */
    secrets: boolean;
    /** A `defineStep` call declaring a `rollback` compensation. */
    workflowRollback: boolean;
}

/** The `defineContainer` keys that turn on outbound interception. */
const EGRESS_POLICY_KEYS = new Set(["allowedHosts", "deniedHosts", "interceptHttps"]);

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
 * trade {@link declaresKey} already makes for a non-literal value.
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
const declaresKey = (node: Node | undefined, keys: ReadonlySet<string>): boolean =>
    node !== undefined &&
    Node.isObjectLiteralExpression(node) &&
    node.getProperties().some((property) => {
        if (Node.isShorthandPropertyAssignment(property)) {
            return keys.has(property.getName());
        }

        if (!Node.isPropertyAssignment(property) || !keys.has(property.getName())) {
            return false;
        }

        const value = unwrapExpression(property.getInitializer())?.getText();

        return value !== "false" && value !== "undefined";
    });

const DURABLE_KEY = new Set(["durable"]);
const ROLLBACK_KEY = new Set(["rollback"]);

/** The called function's name: `stream`, `defineStep`, also through a namespace (`workflow.defineStep`). */
const calleeName = (call: CallExpression): string => {
    const callee = call.getExpression();

    return Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
};

/** The option keys that make each signal call a declaration. */
const SIGNAL_CALLS: ReadonlyMap<string, { keys: ReadonlySet<string>; signal: "containerEgressPolicy" | "durableStreams" | "workflowRollback" }> = new Map([
    ["defineContainer", { keys: EGRESS_POLICY_KEYS, signal: "containerEgressPolicy" }],
    // `defineStep(name, { handler, rollback })` — the compensation
    // `@lunora/workflow` forwards to the host's `step.do`.
    ["defineStep", { keys: ROLLBACK_KEY, signal: "workflowRollback" }],
    ["stream", { keys: DURABLE_KEY, signal: "durableStreams" }],
] as const);

/**
 * The signal `call` declares, if any. The callee name is checked first:
 * resolving an argument walks the file's declarations, so doing that for every
 * call made discovery quadratic in file size.
 */
const callSignal = (sourceFile: SourceFile, call: CallExpression): keyof PlatformCodeSignals | undefined => {
    const match = SIGNAL_CALLS.get(calleeName(call));

    if (match === undefined) {
        return undefined;
    }

    return call.getArguments().some((argument) => declaresKey(resolveObjectLiteral(sourceFile, argument), match.keys)) ? match.signal : undefined;
};

/**
 * Discover the AST-only platform signals in one pass over the `lunora/`
 * source set.
 *
 * `durableStreams` matches any `stream(...)` call — the bare `stream({ … })`
 * form and the builder terminal `.stream(handler, { durable: true })` alike —
 * with a `durable` key in one of its options objects, written inline or
 * {@link resolveObjectLiteral | hoisted into a variable}. Deliberately
 * syntactic: `durable` is not carried in any IR (the emitted registry reads it
 * off the user's own registration object at runtime), so there is nothing else
 * to key on.
 *
 * `workflowRollback` and `containerEgressPolicy` follow the same rule for
 * `defineStep(name, { rollback })` and `defineContainer({ allowedHosts |
 * deniedHosts | interceptHttps })`: neither option reaches an IR (the step and
 * container definitions are read at runtime), and a host that lacks the
 * feature does not run the declaration without it — it fails — so a missed
 * declaration is worse than an over-reported one.
 */
const discoverPlatformSignals = (project: Project, lunoraDirectory: string): PlatformCodeSignals => {
    const signals: PlatformCodeSignals = { containerEgressPolicy: false, durableStreams: false, secrets: false, workflowRollback: false };

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

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const signal = callSignal(sourceFile, call);

            if (signal !== undefined) {
                signals[signal] = true;
            }
        }

        if (Object.values(signals).every(Boolean)) {
            break;
        }
    }

    return signals;
};

export type { PlatformCodeSignals };
export { discoverPlatformSignals };
