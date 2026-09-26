import type { CallExpression, ObjectLiteralExpression, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "../diagnostics";
import type { SchemaIR } from "../ir";
import { listSecurityScanFiles } from "./ast";

/** The key a property-name node spells, or `undefined` when it is computed from something other than a string literal. */
const staticKey = (name: Node): string | undefined => {
    if (Node.isComputedPropertyName(name)) {
        const expression = name.getExpression();

        return Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression) ? expression.getLiteralValue() : undefined;
    }

    return Node.isStringLiteral(name) ? name.getLiteralValue() : name.getText();
};

/**
 * Whether an options object literal names a `namespace` key (quoted, or as a
 * computed `["namespace"]`) or may hide one: a spread, or a computed key whose
 * value is not a literal (`[key]`), both count.
 */
const mayDeclareNamespace = (options: ObjectLiteralExpression): boolean =>
    options.getProperties().some((property) => {
        if (Node.isSpreadAssignment(property)) {
            return true;
        }

        const key = staticKey(property.getNameNode());

        return key === undefined || key === "namespace";
    });

/**
 * The first `.auth(…)` call that declares — or may declare — DO-backed auth:
 * an options literal with a `namespace` key or a spread, or an argument that is
 * not a literal at all. Fails toward "may": a false hit only asks for an
 * acknowledgement that is a no-op for D1-mode auth, while a miss would let the
 * pinned auth object silently start out empty.
 */
const findDoAuthDeclaration = (project: Project, lunoraDirectory: string): CallExpression | undefined => {
    for (const { filePath } of listSecurityScanFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const callee = call.getExpression();
            const [argument] = call.getArguments();

            if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "auth" || argument === undefined) {
                continue;
            }

            if (!Node.isObjectLiteralExpression(argument) || mayDeclareNamespace(argument)) {
                return call;
            }
        }
    }

    return undefined;
};

/** Where the move is documented, including how to copy the auth rows across. */
const UPGRADE_DOCS = "https://lunora.sh/docs/concepts/data-residency#pinning-auth-and-voice";

/**
 * Refuse a project whose schema declares `.jurisdiction(…)` and which has
 * DO-backed auth, unless the schema acknowledges the move with
 * `{ pinAuth: true }`.
 *
 * The auth object was not pinned before, and a Durable Object name maps to a
 * different id in each jurisdiction: pinning it resolves every user, account,
 * session and credential to a new, empty object until the rows are copied.
 * Nothing else fires on this upgrade — the schema itself did not change — so
 * without this check the first deploy silently locks every user out.
 *
 * Voice sessions are not gated. A `VoiceSessionDO` keeps no storage: it holds
 * the live socket and the utterance in progress, and every transcript turn is a
 * row in the app's shards, which the jurisdiction already pins. Pinning voice
 * only drops the sessions live at the deploy, so the worker pins it outright.
 */
const assertJurisdictionMoveAcknowledged = (schema: SchemaIR, doAuthDeclaration: CallExpression | undefined): void => {
    if (schema.jurisdiction === undefined || schema.jurisdictionPinsAuth === true || doAuthDeclaration === undefined) {
        return;
    }

    throw diagnosticAt(
        doAuthDeclaration,
        `the schema pins Durable Objects to the "${schema.jurisdiction}" jurisdiction, and this project also has DO-backed auth (users, sessions, accounts, credentials). ` +
            `Pinning the auth object resolves it to a NEW, EMPTY object: existing users stay in the unpinned one until you copy them across (${UPGRADE_DOCS}). ` +
            `Acknowledge with \`.jurisdiction("${schema.jurisdiction}", { pinAuth: true })\`, deploy, then run the copy. For D1-mode auth the acknowledgement changes nothing.`,
        { code: "JURISDICTION_MOVE", status: 422 },
    );
};

export { assertJurisdictionMoveAcknowledged, findDoAuthDeclaration };
