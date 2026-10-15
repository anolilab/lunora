/**
 * Build-time cron validation backed by `cron-parser`, the authority on what a
 * schedule means. Reached only through `@lunora/scheduler/validate` (codegen,
 * CLI) — never from the Worker-reachable barrel, because `cron-parser` and its
 * `luxon` dependency are ~350 KB of CommonJS that cannot be tree-shaken.
 */
import { CronExpressionParser } from "cron-parser";

/** Standard cron expression (5- or 6-field) or a supported `@macro`, per `cron-parser`. */
const isValidCronExpression = (schedule: string): boolean => {
    if (typeof schedule !== "string" || schedule.trim() === "") {
        return false;
    }

    try {
        CronExpressionParser.parse(schedule.trim());

        return true;
    } catch {
        return false;
    }
};

export default isValidCronExpression;
