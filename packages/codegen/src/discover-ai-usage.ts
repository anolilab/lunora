import type { Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listCirrusSourceFiles } from "./discover-functions";

/**
 * True when any function file under `cirrus/` uses Workers AI — either it
 * imports `@cirrus/ai`, or a handler reads `ctx.ai` (the generated per-function
 * helper). Gates whether codegen wires `ctx.ai` into the generated `ShardDO` and
 * the project-typed contexts: when false, `@cirrus/ai` (and the AI SDK it pulls
 * in) is never imported into the generated worker — mirroring how `@cirrus/vectors`
 * is only imported when the schema declares a vector index.
 *
 * Detection is deliberately conservative: a `ctx` destructured into `{ ai }` is
 * not matched, but importing `@cirrus/ai` (which such handlers do to reach
 * `createAi`/`streamText`) is — so real usage still flips the flag.
 */
const discoverAiUsage = (project: Project, cirrusDirectory: string): boolean => {
    for (const filePath of listCirrusSourceFiles(cirrusDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        if (sourceFile.getImportDeclarations().some((declaration) => declaration.getModuleSpecifierValue() === "@cirrus/ai")) {
            return true;
        }

        const readsContextAi = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).some((access) => {
            if (access.getName() !== "ai") {
                return false;
            }

            const receiver = access.getExpression();

            return Node.isIdentifier(receiver) && receiver.getText() === "ctx";
        });

        if (readsContextAi) {
            return true;
        }
    }

    return false;
};

export default discoverAiUsage;
