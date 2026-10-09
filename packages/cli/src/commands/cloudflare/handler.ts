/**
 * `lunora cloudflare <tool>` handler — dispatches on the first positional to a
 * Cloudflare-only tool. `alert` is accepted for `alerts`, the way `lunora add`
 * accepts friendly synonyms for its items.
 */
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { EXIT_CODE } from "../../util/exit-code";
import type { AlertsSubcommand } from "./alerts/handler";
import { runAlertsCommand } from "./alerts/handler";
import type { AlertsData } from "./alerts/outcome";
import { fail } from "./alerts/outcome";
import type { CloudflareOptions } from "./index";

const ALERTS_TOOL_NAMES = new Set(["alert", "alerts"]);

const isAlertsSubcommand = (value: string): value is AlertsSubcommand => value === "status" || value === "setup" || value === "test";

/** `lunora cloudflare` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<CloudflareOptions> = defineHandler<CloudflareOptions, AlertsData>(async ({ argument, cwd, format, logger, options }) => {
    const [tool = "", sub = "status"] = argument;

    if (!ALERTS_TOOL_NAMES.has(tool)) {
        return fail(logger, EXIT_CODE.USAGE, `cloudflare: unknown tool "${tool}" — expected alerts (lunora cloudflare alerts [status | setup | test])`);
    }

    if (!isAlertsSubcommand(sub)) {
        return fail(logger, EXIT_CODE.USAGE, `cloudflare alerts: unknown subcommand "${sub}" — expected status | setup | test`);
    }

    return runAlertsCommand({
        allowFloor: options.allowFloor === true,
        cwd,
        dryRun: options.dryRun === true,
        format,
        logger,
        replaceRecipients: options.replaceRecipients === true,
        subcommand: sub,
        yes: options.yes === true,
        ...(options.email === undefined ? {} : { emails: options.email }),
        ...(options.webhook === undefined ? {} : { webhooks: options.webhook }),
        ...(options.multiplier === undefined ? {} : { multiplier: options.multiplier }),
        ...(options.threshold === undefined ? {} : { thresholds: options.threshold }),
    });
});

export { execute };
