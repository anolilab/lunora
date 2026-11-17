import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { OUTPUT_FORMAT_OPTION } from "../../util/output-format";

/**
 * `lunora workflow create | send-event` — start a workflow instance or deliver an event to a
 * waiting one, through the same admin ops the Studio Workflows panel calls. Metadata only; the
 * handler (lazy-loaded via `loader`) holds the logic.
 */
const workflowCommand: Command = {
    argument: { description: "create <exportName> | send-event <exportName> <instanceId> <eventType>", name: "args", type: String },
    description: "Start a workflow instance, or send an event to a waiting one",
    examples: [
        ['lunora workflow create onboarding --params \'{"userId":"u1"}\'', "Start an instance of the `onboarding` workflow"],
        ["lunora workflow create onboarding --id user-u1", "Start it under an explicit instance id"],
        ['lunora workflow send-event onboarding user-u1 approved --payload \'{"by":"ada"}\'', "Deliver an `approved` event to a waiting instance"],
    ],
    group: "Develop",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "workflow",
    options: [
        { description: "Instance id for `create` (defaults to a generated one)", name: "id", type: String },
        { description: "JSON-encoded params for `create`", name: "params", type: String },
        { description: "JSON-encoded event payload for `send-event`", name: "payload", type: String },
        OUTPUT_FORMAT_OPTION,
        { description: "Worker URL (defaults to the running dev server)", name: "url", type: String },
        { description: "Admin bearer token (prefer LUNORA_ADMIN_TOKEN or .dev.vars)", name: "token", type: String },
    ],
};

export { workflowCommand };

export type WorkflowOptions = CreateOptions<{
    format: string | undefined;
    id: string | undefined;
    params: string | undefined;
    payload: string | undefined;
    token: string | undefined;
    url: string | undefined;
}>;
