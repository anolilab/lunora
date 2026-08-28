/**
 * Static discovery of `.use(storageRules([...]))` chains — the storage analogue
 * of `discoverRlsMetadata` (`./discover/rls-procedures`). Walks every exported
 * Lunora procedure's builder chain, finds each `storageRules(rules)` call, and
 * lifts the `{ bucket, on, prefix }` shape of every literal rule into metadata
 * the studio's read-only access-rules view lists. The `when` predicate is never
 * read — it's an opaque closure whose logic belongs in code, not the UI.
 */
import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node } from "ts-morph";

import type { StorageRuleIR, StorageRulesMetadataIR } from "../ir";
import { listLunoraSourceFiles, lunoraRelativePath, stringPropertyOf } from "./ast";
import { wrappedCallsInChain } from "./builder-chain";
import exportedProcedureChains from "./functions/exported-procedure-chains";

/** The operations `defineStorageRule({ on })` accepts; anything else is ignored as malformed. */
const STORAGE_OPERATIONS = new Set<StorageRuleIR["on"]>(["delete", "list", "read", "write"]);

/**
 * Every `storageRules(...)` call carried through a `.use(...)` step of the chain
 * rooted at `receiver`.
 *
 * Shares the walk with the RLS and mask twins. It used to be a fourth hand-written
 * copy of both the walk and the name match, which left storage rules the one
 * `.use(...)` policy family still blind to an aliased import
 * (`import { storageRules as rules }`) and to a `(… as B)` cast mid-chain — both
 * silent, both already fixed for the other two.
 */
const storageRulesCallsInChain = (receiver: TsNode): CallExpression[] => wrappedCallsInChain(receiver, "use", "storageRules");

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
