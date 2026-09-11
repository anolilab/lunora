import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const analyzeCommand: Command = {
    description: "Run wrangler dry-run and report bundle size, top modules, and _generated files",
    examples: [["lunora analyze", "Report the worker bundle size + heaviest modules"]],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "analyze",
    options: [{ description: "Output format: pretty (default) or json", name: "format", type: String }],
};

export { analyzeCommand };

export type AnalyzeOptions = CreateOptions<{ format: string | undefined }>;
