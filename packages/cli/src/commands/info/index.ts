import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const infoCommand: Command = {
    description: "Print resolved project config: @lunora/* versions, wrangler summary, schema overview",
    examples: [
        ["lunora info", "Print resolved project config"],
        ["lunora info --json", "Emit a JSON snapshot"],
        ["lunora info --bindings", "List what this Worker needs provisioned: bindings, crons, vars"],
        ["lunora info --bindings --json", "Emit the manifest a deployer or task runner consumes"],
        ["lunora info --bindings --out reqs.json", "Write that manifest to a file"],
    ],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "info",
    options: [
        { description: "Report only what this Worker needs provisioned, as the binding manifest", name: "bindings", type: Boolean },
        { description: "Emit JSON instead of human text", name: "json", type: Boolean },
        { description: "With --bindings: write the manifest to <file> instead of stdout", name: "out", type: String },
    ],
};

export { infoCommand };

export type InfoOptions = CreateOptions<{ bindings: boolean | undefined; json: boolean | undefined; out: string | undefined }>;
