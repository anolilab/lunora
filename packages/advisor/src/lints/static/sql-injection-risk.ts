import emit from "../../finding";
import type { Lint } from "../../types";
import { callSiteFields, callSiteWhere } from "../helpers";

/**
 * Flags a `ctx.sql.query(text, params)` / `ctx.sql.unsafe(text, params)` call whose
 * `text` is built from a non-constant value.
 *
 * The driver binds only `params`; `text` runs verbatim, so request input that reaches
 * the text reopens SQL injection. Codegen's feeder decides what counts as constant
 * (literals, module consts, fixed joins), so this lint only reports sinks it could not
 * prove fixed.
 *
 * Runs only when the codegen feeder supplies interpolation evidence
 * (`context.sqlInterpolations`); a runtime caller flags nothing. One finding per
 * interpolation.
 */
const sqlInjectionRisk: Lint = {
    categories: ["SECURITY"],
    description:
        "A `ctx.sql.query(text, params)` / `ctx.sql.unsafe(text, params)` call builds its SQL `text` from non-constant values. The driver binds only `params` and runs `text` verbatim, so request input in the text reopens SQL injection.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "sql_injection_risk",
    remediation:
        "Keep the SQL text constant and pass every value through the `params` array (`$1`, `$2`, …) so the driver binds it. Never build SQL text from request input.",
    run: (context) => {
        if (context.sqlInterpolations === undefined) {
            return [];
        }

        return context.sqlInterpolations.map((interpolation) =>
            emit(sqlInjectionRisk, {
                cacheKey: `sql_injection_risk:${interpolation.file}:${interpolation.line.toString()}`,
                detail: `\`ctx.sql\` in ${callSiteWhere(interpolation)} builds its SQL text from a non-constant value instead of passing it in \`params\` — a SQL-injection vector. Keep the text constant and bind the value through \`params\`.`,
                metadata: { ...callSiteFields(interpolation) },
            }),
        );
    },
    source: "static",
    title: "Possible SQL injection in ctx.sql text",
};

export default sqlInjectionRisk;
