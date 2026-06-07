/**
 * AST-merge helper for `cirrus-cron` — kept in `_helpers/` so the tests
 * under `tests/vis-templates/` can import it without pulling in the vis
 * runtime (`@visulima/vis/generate`).
 */
import type { CallExpression } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";

export type InsertCronResult = { ok: true; text: string } | { ok: false; reason: "duplicate" | "no-cron-jobs" };

/**
 * Append a `crons.interval(<name>, ...)` registration to an existing
 * `cirrus/crons.ts`. The call is inserted right after the last existing
 * `crons.<kind>(...)` statement (or after the `const crons = cronJobs()`
 * declaration if there are none yet), so the trailing `export default crons`
 * and any surrounding comments survive the edit.
 *
 * Returns a tagged result rather than throwing so callers can render a
 * helpful message per failure mode.
 *
 * Matching is by the literal identifier `crons` — the binding produced by the
 * fresh template. If a user renames the registry variable this reports
 * `no-cron-jobs`; that's an edge case we accept until someone hits it.
 */
export const insertCronJob = (source: string, name: string): InsertCronResult => {
    const project = new Project({
        compilerOptions: { allowJs: true },
        useInMemoryFileSystem: true,
    });

    const sourceFile = project.createSourceFile("crons.ts", source, { overwrite: true });

    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    let cronJobsCall: CallExpression | undefined;
    const registrationCalls: CallExpression[] = [];

    for (const call of callExpressions) {
        const expr = call.getExpression();

        if (expr.getText() === "cronJobs") {
            cronJobsCall = call;

            continue;
        }

        // crons.interval(...), crons.daily(...), crons.cron(...), etc.
        if (expr.getKind() === SyntaxKind.PropertyAccessExpression && expr.getText().startsWith("crons.")) {
            registrationCalls.push(call);

            const firstArgument = call.getArguments()[0];

            if (firstArgument?.getKind() === SyntaxKind.StringLiteral) {
                const existingName = firstArgument.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();

                if (existingName === name) {
                    return { ok: false, reason: "duplicate" };
                }
            }
        }
    }

    if (!cronJobsCall) {
        return { ok: false, reason: "no-cron-jobs" };
    }

    // Anchor the insertion on the statement that contains either the last
    // existing registration or the `cronJobs()` call, then add the new
    // registration immediately after it.
    const anchorCall = registrationCalls.at(-1) ?? cronJobsCall;
    const anchorStatement =
        anchorCall.getFirstAncestorByKind(SyntaxKind.ExpressionStatement) ?? anchorCall.getFirstAncestorByKind(SyntaxKind.VariableStatement);

    if (!anchorStatement) {
        return { ok: false, reason: "no-cron-jobs" };
    }

    const index = anchorStatement.getChildIndex();
    const escapedName = name.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

    sourceFile.insertStatements(index + 1, `crons.interval("${escapedName}", { minutes: 60 }, internal.example.run, {});`);

    return { ok: true, text: sourceFile.getFullText() };
};
