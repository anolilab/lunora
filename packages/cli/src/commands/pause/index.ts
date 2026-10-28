import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { OUTPUT_FORMAT_OPTION } from "../../util/output-format";

const TARGET_OPTIONS = [
    OUTPUT_FORMAT_OPTION,
    { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
    { description: "Worker URL (defaults to the running dev server)", name: "url", type: String },
    { description: "Admin bearer token (or LUNORA_ADMIN_TOKEN)", name: "token", type: String },
];

/**
 * `lunora pause [status]` — the incident switch: refuse app function calls with
 * `503 DEPLOYMENT_PAUSED`, hold scheduled jobs, skip cron ticks and hand queue
 * batches back, until `lunora resume`. Metadata only; the handler (lazy-loaded
 * via `loader`) holds the logic.
 */
const pauseCommand: Command = {
    argument: { description: "status (print the current state instead of pausing)", name: "subcommand", type: String },
    description: "Pause the deployment: refuse function calls, hold scheduled jobs, skip crons and queue batches",
    examples: [
        ['lunora pause --reason "incident 42"', "Pause the local dev server"],
        ["lunora pause status", "Show whether the deployment is paused"],
        ["lunora pause --prod --url https://app.example.com", "Pause production"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.executePause as CommandExecute<Toolbox> };
        }),
    name: "pause",
    options: [{ description: "A note shown wherever the pause is (Studio, the 503 body)", name: "reason", type: String }, ...TARGET_OPTIONS],
};

/** `lunora resume` — undo `lunora pause`; every scheduled job held while paused runs on the next alarm. */
const resumeCommand: Command = {
    description: "Resume a paused deployment; jobs held while paused run right away",
    examples: [
        ["lunora resume", "Resume the local dev server"],
        ["lunora resume --prod --url https://app.example.com", "Resume production"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.executeResume as CommandExecute<Toolbox> };
        }),
    name: "resume",
    options: TARGET_OPTIONS,
};

export { pauseCommand, resumeCommand };

export type PauseOptions = CreateOptions<{
    format: string | undefined;
    prod: boolean | undefined;
    reason: string | undefined;
    token: string | undefined;
    url: string | undefined;
}>;
