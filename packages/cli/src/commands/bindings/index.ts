import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const bindingsCommand: Command = {
    description: "Print what this Worker needs provisioned: bindings, crons, vars",
    examples: [
        ["lunora bindings", "List the bindings, crons and vars this Worker requires"],
        ["lunora bindings --json", "Emit the manifest a deployer or task runner consumes"],
        ["lunora bindings --out reqs.json", "Write that manifest to a file"],
    ],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "bindings",
    options: [
        { description: "Emit the manifest as JSON instead of human text", name: "json", type: Boolean },
        { description: "Write the manifest to <file> instead of stdout", name: "out", type: String },
    ],
};

export { bindingsCommand };

export type BindingsOptions = CreateOptions<{ json: boolean | undefined; out: string | undefined }>;
