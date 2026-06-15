import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const infoCommand: Command = {
    description: "Print resolved project config: @lunora/* versions, wrangler summary, schema overview",
    examples: [
        ["lunora info", "Print resolved project config"],
        ["lunora info --json", "Emit a JSON snapshot"],
    ],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "info",
    options: [{ description: "Emit a JSON snapshot instead of human text", name: "json", type: Boolean }],
};

export { infoCommand };

export type InfoOptions = CreateOptions<{ json: boolean | undefined }>;
