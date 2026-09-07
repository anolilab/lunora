import type { Node as TsNode, SourceFile } from "ts-morph";
import { Node } from "ts-morph";

import { classifyProcedureCall } from "./classify-procedure-call";

/**
 * Every exported `const` in `sourceFile` whose initializer classifies as a
 * builder-form procedure, paired with the builder receiver its chain is rooted
 * at. Bare-factory procedures (`query({ ... })`) have no receiver and are
 * skipped — a chain step is the only thing a caller can walk.
 */
const exportedProcedureChains = (sourceFile: SourceFile): { name: string; receiver: TsNode }[] => {
    const chains: { name: string; receiver: TsNode }[] = [];

    for (const statement of sourceFile.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declaration of statement.getDeclarations()) {
            const initializer = declaration.getInitializer();
            const classified = initializer && Node.isCallExpression(initializer) ? classifyProcedureCall(initializer) : undefined;

            if (classified?.receiver) {
                chains.push({ name: declaration.getName(), receiver: classified.receiver });
            }
        }
    }

    return chains;
};

export default exportedProcedureChains;
