import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `ctx.sql` tagged-template that splices an unparameterized
 * string-building expression into the query.
 *
 * The Hyperdrive `ctx.sql\`…\`` driver binds each `${value}` placeholder as a
 * query parameter — safe by construction. But a placeholder that *builds* a string
 * in place (`ctx.sql\`… ${"WHERE name='" + name + "'"}\``, or a nested template
 * literal) splices raw, attacker-controlled text into the SQL, reopening classic
 * SQL injection. The fix is always to pass the value through a placeholder so the
 * driver parameterizes it.
 *
 * Runs only when the codegen feeder supplies interpolation evidence
 * (`context.sqlInterpolations`); a runtime caller flags nothing. One finding per
 * interpolation.
 */
const sqlInjectionRisk: Lint = {
    categories: ["SECURITY"],
    description:
        "A `ctx.sql` tagged-template interpolates an unparameterized string-building expression (concatenation or nested template) instead of a bound value — splicing raw text into the query and reopening SQL injection.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "sql_injection_risk",
    remediation:
        "Pass the value through a bound placeholder so the driver parameterizes it — keep request input inside a `ctx.sql` placeholder instead of concatenating it into the query string. Never build SQL text from request input by hand.",
    run: (context) => {
        if (context.sqlInterpolations === undefined) {
            return [];
        }

        return context.sqlInterpolations.map((interpolation) =>
            emit(sqlInjectionRisk, {
                cacheKey: `sql_injection_risk:${interpolation.file}:${interpolation.line.toString()}`,
                detail: `\`ctx.sql\` in \`${interpolation.exportName}\` (${interpolation.file}:${interpolation.line.toString()}) interpolates a string-building expression instead of a bound value — a SQL-injection vector. Pass the value through a bound placeholder so the driver parameterizes it.`,
                metadata: { exportName: interpolation.exportName, file: interpolation.file, line: interpolation.line },
            }),
        );
    },
    source: "static",
    title: "Possible SQL injection in ctx.sql interpolation",
};

export default sqlInjectionRisk;
