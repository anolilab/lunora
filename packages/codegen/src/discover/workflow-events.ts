import { LunoraError } from "@lunora/errors";
import type { Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "../diagnostics";
import type { WorkflowEventIR } from "../ir";
import { descendantsOfKind, listLunoraSourceFiles, lunoraRelativePath } from "./ast";
import { addressableExportNameOf } from "./attribution";
import { importAliases } from "./callee";

const isWorkflowModule = (moduleSpecifier: string): boolean => moduleSpecifier === "@lunora/workflow";

const workflowNamespaces = (sourceFile: SourceFile): Set<string> =>
    new Set(
        sourceFile
            .getImportDeclarations()
            .filter((declaration) => isWorkflowModule(declaration.getModuleSpecifierValue()))
            .map((declaration) => declaration.getNamespaceImport()?.getText())
            .filter((name): name is string => name !== undefined),
    );

const isEventFactoryCall = (callee: Node, aliases: Set<string>, namespaces: Set<string>): boolean => {
    if (Node.isIdentifier(callee)) {
        return aliases.has(callee.getText());
    }

    return Node.isPropertyAccessExpression(callee) && callee.getName() === "defineWorkflowEvent" && namespaces.has(callee.getExpression().getText());
};

/** The exported `defineWorkflowEvent(…)` calls of one file. Unexported ones are skipped: the shard cannot import them. */
const eventsIn = (sourceFile: SourceFile, lunoraDirectory: string): WorkflowEventIR[] => {
    const aliases = importAliases(sourceFile, "defineWorkflowEvent", isWorkflowModule);
    const namespaces = workflowNamespaces(sourceFile);

    if (aliases.size === 0 && namespaces.size === 0) {
        return [];
    }

    const events: WorkflowEventIR[] = [];

    for (const call of descendantsOfKind(sourceFile, SyntaxKind.CallExpression)) {
        if (!isEventFactoryCall(call.getExpression(), aliases, namespaces)) {
            continue;
        }

        let declaration = call.getParent();

        while (
            Node.isAsExpression(declaration) ||
            Node.isSatisfiesExpression(declaration) ||
            Node.isParenthesizedExpression(declaration) ||
            Node.isNonNullExpression(declaration)
        ) {
            declaration = declaration.getParent();
        }

        const exportName = Node.isVariableDeclaration(declaration) ? addressableExportNameOf(declaration, "binding") : undefined;

        if (exportName === undefined) {
            continue;
        }

        const typeArgument = call.getArguments()[0];

        // The literal is what Studio offers and what the admin send is keyed by; a computed one cannot be read here.
        if (typeArgument === undefined || !(Node.isStringLiteral(typeArgument) || Node.isNoSubstitutionTemplateLiteral(typeArgument))) {
            throw new LunoraError(
                "WORKFLOW_EVENT_NOT_LITERAL",
                diagnosticAt(
                    typeArgument ?? call,
                    `workflow event "${exportName}": defineWorkflowEvent's \`type\` must be a string literal so codegen can register it for admin sends`,
                ).message,
            );
        }

        events.push({ exportName, filePath: lunoraRelativePath(lunoraDirectory, sourceFile.getFilePath()), type: typeArgument.getLiteralValue() });
    }

    return events;
};

/**
 * Every exported `defineWorkflowEvent("type", validator)` in `lunora/`, sorted by type. The admin
 * `sendWorkflowEvent` RPC looks a definition up by its type to parse the payload before sending, so
 * two exports sharing a type would make that lookup ambiguous and are rejected.
 */
const discoverWorkflowEvents = (project: Project, lunoraDirectory: string): WorkflowEventIR[] => {
    const events = listLunoraSourceFiles(lunoraDirectory).flatMap((filePath) =>
        eventsIn(project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath), lunoraDirectory),
    );
    const seen = new Map<string, WorkflowEventIR>();

    for (const event of events) {
        const prior = seen.get(event.type);

        if (prior !== undefined) {
            throw new LunoraError(
                "WORKFLOW_EVENT_DUPLICATE",
                `workflow event type ${JSON.stringify(event.type)} is declared by both lunora/${prior.filePath}.ts (${prior.exportName}) and lunora/${event.filePath}.ts (${event.exportName}); it must be unique across the app.`,
            );
        }

        seen.set(event.type, event);
    }

    return events.toSorted((a, b) => a.type.localeCompare(b.type));
};

export default discoverWorkflowEvents;
