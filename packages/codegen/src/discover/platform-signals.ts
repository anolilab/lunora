import type { CallExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { PROJECT_CONFIG_FILENAMES } from "../project-config-path";
import { chainRootOf, listLunoraSourceFiles, memberAccessOf, propertyKeyName, unwrapExpression } from "./ast";
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
    /** A `.deliveryAuthorization(...)` call on the app builder, matched by receiver. The shard answers its authority-fenced routes under it, and with `liveStreams` it answers every live route 501. */
    deliveryAuthorization: boolean;
    /** A `.stream(handler, { durable: … })` registration — a persisted, socket-outliving stream run. */
    durableStreams: boolean;
    /** A `ctx.live` read in a handler — the live publisher, which a target that withholds live streams never sets on the context. */
    liveContext: boolean;
    /** A `defineLiveStream` call: a topic SSE stream the shard serves over its subscriber registry. */
    liveStreams: boolean;
    /** A `ctx.secrets` read — the Secrets Store facade, which needs a host binding. */
    secrets: boolean;
    /** A `defineWebSocket` route or `defineRoom` room — both ride hibernated shard sockets. */
    typedWebSockets: boolean;
    /** A `defineStep` call declaring a `rollback` compensation. */
    workflowRollback: boolean;
}

/**
 * The declarations that carry a platform feature: socket routes and rooms ride hibernated shard sockets, live streams the subscriber registry.
 * `.deliveryAuthorization(...)` is not here: it is a method on the app builder, so it is matched by receiver in {@link isAppBuilderReceiver}.
 */
const DECLARATION_SIGNALS: Readonly<Record<string, "liveStreams" | "typedWebSockets">> = {
    defineLiveStream: "liveStreams",
    defineRoom: "typedWebSockets",
    defineWebSocket: "typedWebSockets",
};

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
            return keys.has(propertyKeyName(property));
        }

        if (!Node.isPropertyAssignment(property) || !keys.has(propertyKeyName(property))) {
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

/** The app builder's factory: `defineApp().ai(…).deliveryAuthorization(…)` is a builder chain rooted here. */
const APP_FACTORY = "defineApp";

/** The `lunora.config` hook whose function receives the generated `defineApp()` builder. */
const APP_HOOK_KEY = "app";

/** True when the config hands the binding `name` to its `app` key: `app: name`, or the shorthand `{ app }`. */
const isNamedAppHook = (configFile: SourceFile, name: string): boolean =>
    configFile
        .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
        .some((property) => propertyKeyName(property) === APP_HOOK_KEY && property.getInitializer()?.getText() === name) ||
    (name === APP_HOOK_KEY &&
        configFile.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment).some((property) => propertyKeyName(property) === APP_HOOK_KEY));

/**
 * True when `node` is a `lunora.config` `app` hook function, `app: (app) => …`.
 * Only the project's config file carries the hook: an `app` key on any object
 * under `lunora/` is not the generated builder's hook.
 */
const isAppHookFunction = (node: Node | undefined): boolean => {
    if (node === undefined || !PROJECT_CONFIG_FILENAMES.includes(node.getSourceFile().getBaseName())) {
        return false;
    }

    // Method shorthand: `app(builder) { … }`.
    if (Node.isMethodDeclaration(node)) {
        return Node.isObjectLiteralExpression(node.getParent()) && propertyKeyName(node) === APP_HOOK_KEY;
    }

    if (!(Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node))) {
        return false;
    }

    const owner = node.getParent();

    if (Node.isPropertyAssignment(owner)) {
        return propertyKeyName(owner) === APP_HOOK_KEY;
    }

    // Extracted: `const configure = (app) => …` or `function configure(app) {…}`,
    // handed to the key as `app: configure` or `{ app }`.
    if (Node.isVariableDeclaration(owner)) {
        return isNamedAppHook(node.getSourceFile(), owner.getName());
    }

    const declared = Node.isFunctionDeclaration(node) ? node.getName() : undefined;

    return declared !== undefined && isNamedAppHook(node.getSourceFile(), declared);
};

/** The generated builder class (`emit-app.ts`). */
const APP_BUILDER_CLASS = "AppBuilder";

/**
 * True when `node` is typed as the generated `AppBuilder`, whatever its form:
 * an import, a parameter, a `new`, a call result. Untyped values stay unmatched.
 */
const isAppBuilderType = (node: Node): boolean => node.getType().getSymbol()?.getName() === APP_BUILDER_CLASS;

/**
 * True when `receiver` denotes the app builder by name: a chain rooted at
 * `defineApp()`, a local variable initialised from one, or the parameter of an
 * `app` hook. Typed builders are matched at the call by {@link isAppBuilderType}.
 *
 * The root identifier is resolved the way the language resolves it: the
 * innermost enclosing scope that binds its name decides. A same-named object in
 * a sibling or nested scope is therefore never the builder, which the earlier
 * whole-file name lookup got wrong. A name bound nowhere in the file is not
 * matched here.
 */
const isAppBuilderReceiver = (sourceFile: SourceFile, receiver: Node | undefined, seen: Set<string> = new Set()): boolean => {
    const root = chainRootOf(receiver);

    if (root === undefined || !Node.isIdentifier(root)) {
        return false;
    }

    const name = root.getText();

    if (name === APP_FACTORY) {
        return true;
    }

    if (seen.has(name)) {
        return false;
    }

    seen.add(name);

    for (const scope of root.getAncestors()) {
        if (Node.isParametered(scope) && scope.getParameters().some((parameter) => parameter.getName() === name)) {
            return isAppHookFunction(scope);
        }

        if (Node.isBlock(scope) || Node.isSourceFile(scope)) {
            const declaration = scope
                .getVariableStatements()
                .flatMap((statement) => statement.getDeclarations())
                .find((candidate) => candidate.getName() === name);

            if (declaration !== undefined) {
                return isAppBuilderReceiver(sourceFile, declaration.getInitializer(), seen);
            }
        }
    }

    return false;
};

/** True when `call` is `<app builder>.deliveryAuthorization(…)`. A bare call of that name, or a method on any other object, is not. */
const isDeliveryAuthorizationCall = (sourceFile: SourceFile, call: CallExpression): boolean => {
    const access = memberAccessOf(call.getExpression());

    return access?.member === "deliveryAuthorization" && (isAppBuilderReceiver(sourceFile, access.object) || isAppBuilderType(access.object));
};

/** The option keys that make each signal call a declaration. */
const SIGNAL_CALLS: ReadonlyMap<string, { keys: ReadonlySet<string>; signal: Exclude<keyof PlatformCodeSignals, "secrets"> }> = new Map([
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

/** The signal a call declares by name, or by receiver for the app builder's `.deliveryAuthorization(...)`. */
const declarationSignal = (sourceFile: SourceFile, call: CallExpression): keyof PlatformCodeSignals | undefined =>
    DECLARATION_SIGNALS[calleeName(call)] ?? (isDeliveryAuthorizationCall(sourceFile, call) ? "deliveryAuthorization" : undefined);

/**
 * Discover the AST-only platform signals in one pass over the `lunora/`
 * source set, plus the project's `lunora.config.*` for the app hook.
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
const discoverPlatformSignals = (project: Project, lunoraDirectory: string, projectConfigFile?: string): PlatformCodeSignals => {
    const signals: PlatformCodeSignals = {
        containerEgressPolicy: false,
        deliveryAuthorization: false,
        durableStreams: false,
        liveContext: false,
        liveStreams: false,
        secrets: false,
        typedWebSockets: false,
        workflowRollback: false,
    };

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        if (!signals.secrets || !signals.liveContext) {
            // The sibling walk `discoverFeatureUsage` uses for the same job, not
            // a third copy of it: it resolves the handler's context by binding,
            // so `{ ctx: context }` and `{ ctx: { secrets } }` count as much as
            // `ctx.secrets`. Reads spelled any other way used to slip past this
            // gate into exactly the surface-that-throws-on-first-use the
            // `secrets` rating exists to refuse. `ctx.live` gets the same treatment.
            const contextReads = contextPropertiesRead(sourceFile);

            signals.secrets = signals.secrets || contextReads.has("secrets");
            signals.liveContext = signals.liveContext || contextReads.has("live");
        }

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const signal = callSignal(sourceFile, call) ?? declarationSignal(sourceFile, call);

            if (signal !== undefined) {
                signals[signal] = true;
            }
        }

        if (Object.values(signals).every(Boolean)) {
            break;
        }
    }

    // The `app` hook lives in `lunora.config.*` at the project root, outside
    // `lunora/`, so the walk above never reaches it. Only the builder call is
    // read here: the name-only declarations are a `lunora/` concern.
    if (!signals.deliveryAuthorization && projectConfigFile !== undefined) {
        const configFile = project.getSourceFile(projectConfigFile) ?? project.addSourceFileAtPath(projectConfigFile);

        signals.deliveryAuthorization = configFile
            .getDescendantsOfKind(SyntaxKind.CallExpression)
            .some((call) => isDeliveryAuthorizationCall(configFile, call));
    }

    return signals;
};

export type { PlatformCodeSignals };
export { discoverPlatformSignals };
