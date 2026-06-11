import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const analyzeCommand: Command = {
    description: "Run wrangler dry-run and report bundle size, top modules, and _generated files",
    examples: [["cirrus analyze", "Report the worker bundle size + heaviest modules"]],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "analyze",
    options: [{ description: "Emit a JSON report instead of human text", name: "json", type: Boolean }],
};

export { analyzeCommand };

export type AnalyzeOptions = CreateOptions<{ json: boolean | undefined }>;
