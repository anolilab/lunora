/**
 * Static discovery of `.use(storageRules([...]))` chains — the storage analogue
 * of `discoverRlsMetadata` (`./discover-rls-procedures`). Walks every exported
 * Lunora procedure's builder chain, finds each `storageRules(rules)` call, and
 * lifts the `{ bucket, on, prefix }` shape of every literal rule into metadata
 * the studio's read-only access-rules view lists. The `when` predicate is never
 * read — it's an opaque closure whose logic belongs in code, not the UI.
 */
import type { CallExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node } from "ts-morph";

import { stringPropertyOf } from "./discover-ast";
import { classifyProcedureCall, listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { StorageRuleIR, StorageRulesMetadataIR } from "./ir";

/** The operations `defineStorageRule({ on })` accepts; anything else is ignored as malformed. */
const STORAGE_OPERATIONS = new Set<StorageRuleIR["on"]>(["delete", "list", "read", "write"]);

/** True when `node` is a `storageRules(...)` call (bare identifier or `mod.storageRules(...)`). */
const isStorageRulesCall = (node: TsNode): boolean => {
    if (!Node.isCallExpression(node)) {
        return false;
    }

    const callee = node.getExpression();

    if (Node.isIdentifier(callee)) {
        return callee.getText() === "storageRules";
    }

    return Node.isPropertyAccessExpression(callee) && callee.getName() === "storageRules";
};

/** Walk a builder chain leftward from `receiver`, collecting every `storageRules(...)` call carried via `.use(...)`. */
const storageRulesCallsInChain = (receiver: TsNode): CallExpression[] => {
    const calls: CallExpression[] = [];
    let node: TsNode = receiver;

    while (Node.isCallExpression(node)) {
        const chainCallee = node.getExpression();

        if (!Node.isPropertyAccessExpression(chainCallee)) {
            break;
        }

        if (chainCallee.getName() === "use") {
            const argument = node.getArguments()[0];

            if (argument && isStorageRulesCall(argument)) {
                calls.push(argument as CallExpression);
            }
        }

        node = chainCallee.getExpression();
    }

    return calls;
};

/** Extract `{ bucket, on, prefix }` from each object-literal element of a `storageRules(rules)` array literal. */
const extractRules = (call: CallExpression, file: string, procedure: string): StorageRuleIR[] => {
    const argument = call.getArguments()[0];

    if (!argument || !Node.isArrayLiteralExpression(argument)) {
        return [];
    }

    const rules: StorageRuleIR[] = [];

    for (const element of argument.getElements()) {
        if (!Node.isObjectLiteralExpression(element)) {
            continue;
        }

        const on = stringPropertyOf(element, "on");

        if (on === undefined || !STORAGE_OPERATIONS.has(on as StorageRuleIR["on"])) {
            continue;
        }

        const prefix = stringPropertyOf(element, "prefix");
        const rule: StorageRuleIR = { bucket: stringPropertyOf(element, "bucket") ?? "", file, on: on as StorageRuleIR["on"], procedure };

        if (prefix !== undefined) {
            rule.prefix = prefix;
        }

        rules.push(rule);
    }

    return rules;
};

/** The exported variable declarations in `sourceFile` whose initializer is a procedure builder chain with a receiver. */
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

/**
 * Aggregate the schema-wide storage-rule metadata the studio's inspector reads:
 * every statically-discovered `(bucket, on, prefix, procedure)` entry across all
 * `.use(storageRules(...))` chains. Only the builder form can declare rules, so
 * bare-factory procedures contribute nothing.
 */
const discoverStorageRulesMetadata = (project: Project, lunoraDirectory: string): StorageRulesMetadataIR => {
    const rules: StorageRuleIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const { name, receiver } of exportedProcedureChains(sourceFile)) {
            for (const call of storageRulesCallsInChain(receiver)) {
                rules.push(...extractRules(call, relativePath, name));
            }
        }
    }

    return { rules };
};

export default discoverStorageRulesMetadata;
