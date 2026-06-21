import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const viewCommand: Command = {
    description: "Open the Lunora studio in your browser (local dev by default, --remote for production)",
    examples: [
        ["lunora view", "Open the studio for local dev"],
        ["lunora view --remote", "Open the deployed studio"],
    ],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "view",
    options: [{ description: "Open the deployed worker URL instead of localhost", name: "remote", type: Boolean }],
};

export { viewCommand };

export type ViewOptions = CreateOptions<{ remote: boolean | undefined }>;
