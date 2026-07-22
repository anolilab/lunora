import type { AdvisorExportSink } from "@lunora/advisor";
import type { CallExpression, ObjectLiteralExpression, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";

/** The three CDC export-sink factories the runtime ships (plan 170). */
const SINK_FACTORIES = new Set<AdvisorExportSink["factory"]>(["defineExportSink", "r2Sink", "webhookExportSink"]);

/** The factory name of a `&lt;factory>({ … })` call, or `undefined` when the callee is not one of the sink factories. */
const sinkFactoryOf = (call: CallExpression): AdvisorExportSink["factory"] | undefined => {
    const callee = call.getExpression();

    if (!Node.isIdentifier(callee)) {
        return undefined;
    }

    const name = callee.getText() as AdvisorExportSink["factory"];

    return SINK_FACTORIES.has(name) ? name : undefined;
};

/** Static-analysis result for a factory's config argument: which keys are present, which are empty-string literals, whether it was analyzable at all. */
interface ConfigFacts {
    analyzable: boolean;
    emptyKeys: string[];
    presentKeys: string[];
}

/**
 * Read the config object literal's keys. A spread (`{ ...base }`) could supply any
 * required key, so its presence makes the config non-analyzable (the lint then
 * skips rather than false-alarms). A present key whose value is an empty string
 * literal (`url: ""`) is recorded as empty — the lint treats it as missing.
 */
const analyzeConfig = (literal: ObjectLiteralExpression): ConfigFacts => {
    const presentKeys: string[] = [];
    const emptyKeys: string[] = [];

    for (const property of literal.getProperties()) {
        if (Node.isSpreadAssignment(property)) {
            return { analyzable: false, emptyKeys: [], presentKeys: [] };
        }

        if (Node.isPropertyAssignment(property)) {
            const key = property.getName();

            presentKeys.push(key);

            const initializer = property.getInitializer();

            if (initializer && Node.isStringLiteral(initializer) && initializer.getLiteralText() === "") {
                emptyKeys.push(key);
            }

            continue;
        }

        if (Node.isShorthandPropertyAssignment(property) || Node.isMethodDeclaration(property) || Node.isGetAccessorDeclaration(property)) {
            presentKeys.push(property.getName());
        }
    }

    return { analyzable: true, emptyKeys, presentKeys };
};

/**
 * Discover CDC export-sink constructions (`defineExportSink` / `webhookExportSink`
 * / `r2Sink`) under the lunora source directory — the `export_sink_misconfigured`
 * lint input. Each records which config keys were present (and which were an empty
 * string) so the lint can flag a sink missing a required field. A call whose first
 * argument is not an object literal (a variable, a spread) is recorded as
 * `analyzable: false` so the lint skips it rather than raising a false alarm.
 */
const discoverExportSinks = (project: Project, lunoraDirectory: string): AdvisorExportSink[] => {
    const sinks: AdvisorExportSink[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const factory = sinkFactoryOf(call);

            if (factory === undefined) {
                continue;
            }

            const argument = call.getArguments()[0];
            const facts =
                argument && Node.isObjectLiteralExpression(argument) ? analyzeConfig(argument) : { analyzable: false, emptyKeys: [], presentKeys: [] };

            sinks.push({
                analyzable: facts.analyzable,
                emptyKeys: facts.emptyKeys,
                factory,
                file: relativePath,
                line: call.getStartLineNumber(),
                presentKeys: facts.presentKeys,
            });
        }
    }

    return sinks;
};

export default discoverExportSinks;
