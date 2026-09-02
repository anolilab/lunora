import type { Command, CommandExecute, Toolbox } from "@visulima/cerebro";

const viewCommand: Command = {
    description: "Open the Lunora studio in your browser (the running dev server's, or the default local one)",
    examples: [["lunora view", "Open the studio for the running dev server"]],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "view",
};

export default viewCommand;
