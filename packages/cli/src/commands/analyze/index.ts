import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { OUTPUT_FORMAT_OPTION } from "../../util/output-format";

const analyzeCommand: Command = {
    description: "Run wrangler dry-run and report bundle size, top modules, and _generated files",
    examples: [["lunora analyze", "Report the worker bundle size + heaviest modules"]],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "analyze",
    options: [OUTPUT_FORMAT_OPTION],
};

export { analyzeCommand };

export type AnalyzeOptions = CreateOptions<{ format: string | undefined }>;
