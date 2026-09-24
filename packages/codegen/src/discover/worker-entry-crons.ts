import type { CallExpression, ObjectLiteralExpression, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listSecurityScanFiles, objectLiteralFromCallbackBody, propertyInitializer } from "./ast";
import { calleeName } from "./callee";

/** The runtime worker factory whose options object pins cron expressions. */
const WORKER_FACTORY = "createWorker";

/**
 * The generated `AppBuilder` escape hatch: `.extend((env, derived) =>
 * Partial<WorkerOptions>)`, whose result is merged straight into the
 * `createWorker(...)` options at runtime. Matched by method name only — the same
 * import-agnostic convention `discover/config-calls` uses for the same call.
 */
const EXTEND_METHOD = "extend";

/**
 * A node's literal string value in either quoting the config could use, or
 * `undefined` for anything the compiler would have to evaluate. A substituted
 * template (`` `0 ${hour} * * *` ``) is deliberately NOT a
 * `NoSubstitutionTemplateLiteral`, so it falls out here with the rest of the
 * computed forms.
 */
const literalText = (node: Node | undefined): string | undefined =>
    node !== undefined && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) ? node.getLiteralValue() : undefined;

/**
 * The cron expressions a `WorkerOptions` object literal pins, in source order:
 * the `backupCron` literal, then every statically-named key of the `crons`
 * handler map.
 *
 * A cron expression contains spaces, so a `crons` key is ALWAYS a quoted name —
 * an identifier key cannot spell one. That is why only literal keys are read: a
 * computed key (`[env.CRON]: handler`) or a spread is out of reach, not merely
 * unusual.
 */
const cronsFromWorkerOptions = (options: ObjectLiteralExpression): string[] => {
    const found: string[] = [];
    const backupCron = literalText(propertyInitializer(options, "backupCron"));

    if (backupCron !== undefined) {
        found.push(backupCron);
    }

    const handlers = propertyInitializer(options, "crons");

    if (handlers === undefined || !Node.isObjectLiteralExpression(handlers)) {
        return found;
    }

    for (const property of handlers.getProperties()) {
        if (!Node.isPropertyAssignment(property) && !Node.isMethodDeclaration(property)) {
            continue;
        }

        const key = literalText(property.getNameNode());

        if (key !== undefined) {
            found.push(key);
        }
    }

    return found;
};

/**
 * The cron expressions one call contributes: the options literal a
 * `createWorker({...})` is passed, or the literal an `.extend(fn)` callback
 * returns. Empty for every other call, and for an argument that is not a
 * statically readable literal.
 */
const cronsFromCall = (call: CallExpression): string[] => {
    const name = calleeName(call.getExpression());
    const [argument] = call.getArguments();

    if (argument === undefined) {
        return [];
    }

    if (name === WORKER_FACTORY) {
        return Node.isObjectLiteralExpression(argument) ? cronsFromWorkerOptions(argument) : [];
    }

    if (name !== EXTEND_METHOD || !(Node.isArrowFunction(argument) || Node.isFunctionExpression(argument))) {
        return [];
    }

    const returned = objectLiteralFromCallbackBody(argument.getBody());

    return returned === undefined ? [] : cronsFromWorkerOptions(returned);
};

/**
 * The cron expressions the worker entry pins outside `lunora/crons.ts`:
 * `createWorker({ backupCron })` (the nightly NDJSON backup, compared verbatim
 * against the firing trigger) and the keys of `createWorker({ crons })`
 * (handlers dispatched by exact expression). Both need an entry in wrangler's
 * `triggers.crons` to fire at all, and neither is a `cronJobs()` registration,
 * so `discover/crons` never saw them — which is why the cron reconciler used to
 * delete them.
 *
 * Scans the worker-entry file set as well as `lunora/` (see
 * {@link listSecurityScanFiles}) for the same reason the config-call lints do:
 * `createWorker` is called from the entry by convention and never from under
 * `lunora/`.
 *
 * **Deliberately incomplete, and the reconciler's ownership record is what
 * covers the rest.** `.extend((env) => ({ backupCron: env.NIGHTLY_CRON }))` is a
 * documented, supported way to configure this, and no AST scan can resolve it;
 * the same goes for a spread, a variable, or a computed `crons` key. Discovery
 * buys the common static case — an expression found here is one the reconciler
 * knows it OWNS, so it is cleared when the entry stops declaring it, rather than
 * merely surviving as "not ours". Anything it cannot read falls back to
 * `package.json`'s `lunora.crons` record, which keeps an unrecognised entry
 * instead of deleting it. Removing that record on the strength of this scan
 * would reinstate the deletion bug for every dynamically-configured app.
 */
const discoverWorkerEntryCrons = (project: Project, lunoraDirectory: string): string[] => {
    const found: string[] = [];

    for (const { filePath } of listSecurityScanFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            found.push(...cronsFromCall(call));
        }
    }

    return [...new Set(found)];
};

export default discoverWorkerEntryCrons;
