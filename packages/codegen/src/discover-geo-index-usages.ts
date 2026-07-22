import type { AdvisorGeoIndexUsage } from "@lunora/advisor";
import type { CallExpression, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";

/**
 * True for a `.withGeoIndex(name, build)` call — the geo-query read entry point
 * on a table reader (`ctx.db.query("t").withGeoIndex(...)` /
 * `ctx.db.&lt;table>.withGeoIndex(...)`). `withGeoIndex` is a Lunora-only reader
 * method, so matching the callee name alone is unambiguous (mirrors how
 * `discover-queries` keys off the `.query`/`.withIndex` chain method names).
 */
const isWithGeoIndexCall = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    return Node.isPropertyAccessExpression(callee) && callee.getName() === "withGeoIndex";
};

/** The literal index name from a `withGeoIndex("name", …)` call, or `""` when the argument is not a string literal. */
const indexNameOf = (call: CallExpression): string => {
    const argument = call.getArguments()[0];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralText() : "";
};

/**
 * Discover `withGeoIndex("name", …)` reads under the lunora source directory and
 * record each referenced geo-index name — the `geo_index_unused` lint's use-side
 * input. A non-literal name argument is kept with `indexName === ""` so the lint
 * can treat it as a dynamic use (and suppress its unused heuristic) rather than
 * silently ignoring it.
 */
const discoverGeoIndexUsages = (project: Project, lunoraDirectory: string): AdvisorGeoIndexUsage[] => {
    const usages: AdvisorGeoIndexUsage[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            if (!isWithGeoIndexCall(call)) {
                continue;
            }

            usages.push({ file: relativePath, indexName: indexNameOf(call), line: call.getStartLineNumber() });
        }
    }

    return usages;
};

export default discoverGeoIndexUsages;
