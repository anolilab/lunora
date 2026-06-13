import type { Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listCirrusSourceFiles } from "./discover-functions";

/**
 * True when any function file under `cirrus/` uses payments — either it imports
 * `@cirrus/payment`, or a handler reads `ctx.payments` (the generated per-function
 * helper). Gates whether codegen wires `ctx.payments` into the generated `ShardDO`
 * and the project-typed `ActionCtx`: when false, `@cirrus/payment` is never imported
 * into the generated worker — mirroring `discoverAiUsage` and the vectors gating.
 */
const discoverPaymentUsage = (project: Project, cirrusDirectory: string): boolean => {
    for (const filePath of listCirrusSourceFiles(cirrusDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        if (sourceFile.getImportDeclarations().some((declaration) => declaration.getModuleSpecifierValue() === "@cirrus/payment")) {
            return true;
        }

        const readsContextPayments = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).some((access) => {
            if (access.getName() !== "payments") {
                return false;
            }

            const receiver = access.getExpression();

            return Node.isIdentifier(receiver) && receiver.getText() === "ctx";
        });

        if (readsContextPayments) {
            return true;
        }
    }

    return false;
};

export default discoverPaymentUsage;
