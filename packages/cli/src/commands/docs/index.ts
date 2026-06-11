/* eslint-disable unicorn/prevent-abbreviations -- "docs" is the user-facing CLI command name (cirrus docs); renaming the identifiers would diverge from the command users type */
import type { Command, CommandExecute, Toolbox } from "@visulima/cerebro";

const docsCommand: Command = {
    argument: { description: "Optional path under the docs site (e.g. addons/studio)", name: "section", type: String },
    description: "Open the Cirrus docs in your browser (optional [section] path)",
    examples: [
        ["cirrus docs", "Open the Cirrus docs"],
        ["cirrus docs addons/studio", "Open a specific docs section"],
    ],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "docs",
};

export default docsCommand;
