import { LunoraError } from "@lunora/errors";
import type { CallExpression, ObjectLiteralExpression, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "../diagnostics";
import type { AgentIR, SchemaIR } from "../ir";
import { listSecurityScanFiles } from "./ast";

/** Whether an options object literal names a `namespace` key (quoted or not) or hides keys behind a spread. */
const mayDeclareNamespace = (options: ObjectLiteralExpression): boolean =>
    options.getProperties().some((property) => {
        if (Node.isSpreadAssignment(property)) {
            return true;
        }

        const name = property.getNameNode();

        return (Node.isStringLiteral(name) ? name.getLiteralValue() : name.getText()) === "namespace";
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

/** Where the unacknowledged objects are documented, including how to move their data. */
const UPGRADE_DOCS = "https://lunora.sh/docs/concepts/data-residency#pinning-auth-and-voice";

/**
 * Refuse a project whose schema declares `.jurisdiction(…)` and which reaches
 * voice sessions or DO-backed auth, unless the schema acknowledges the move
 * with `{ pinAuthAndVoice: true }`.
 *
 * Those objects were not pinned before, and a Durable Object name maps to a
 * different id in each jurisdiction: pinning them resolves every user, session,
 * credential and transcript to a new, empty object. Nothing else fires on this
 * upgrade — the schema itself did not change — so without this check the first
 * deploy silently locks every user out.
 */
const assertJurisdictionMoveAcknowledged = (schema: SchemaIR, agents: ReadonlyArray<AgentIR>, doAuthDeclaration: CallExpression | undefined): void => {
    if (schema.jurisdiction === undefined || schema.jurisdictionPinsAuthAndVoice === true) {
        return;
    }

    const voiceAgents = agents.filter((agent) => agent.voice === true).map((agent) => `"${agent.exportName}"`);
    const affected = [
        ...(doAuthDeclaration === undefined ? [] : ["DO-backed auth (users, sessions, accounts, credentials)"]),
        ...(voiceAgents.length === 0 ? [] : [`the voice sessions of agent(s) ${voiceAgents.join(", ")} (transcripts)`]),
    ];

    if (affected.length === 0) {
        return;
    }

    const detail =
        `the schema pins Durable Objects to the "${schema.jurisdiction}" jurisdiction, and this project also has ${affected.join(" and ")}. ` +
        `Those objects are now pinned too, which resolves them to NEW, EMPTY objects: existing data stays in the unpinned ones. ` +
        `Move or discard that data first (${UPGRADE_DOCS}), then acknowledge with \`.jurisdiction("${schema.jurisdiction}", { pinAuthAndVoice: true })\`. ` +
        `For D1-mode auth the acknowledgement changes nothing.`;

    if (doAuthDeclaration !== undefined) {
        throw diagnosticAt(doAuthDeclaration, detail, { code: "JURISDICTION_MOVE", status: 422 });
    }

    throw new LunoraError("JURISDICTION_MOVE", `@lunora/codegen: ${detail}`, { status: 422 });
};

export { assertJurisdictionMoveAcknowledged, findDoAuthDeclaration };
