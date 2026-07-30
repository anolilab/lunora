import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/** Default artifact path, relative to the project root. */
const DEFAULT_MAP_PATH = "lunora.advisor.map.json";

const advisorCommand: Command = {
    description: "Score your app's advisor findings into a health map, and gate CI on it",
    examples: [
        ["lunora advisor", "Score the app and write lunora.advisor.map.json"],
        ["lunora advisor --all", "Show every procedure as a check matrix"],
        ["lunora advisor --entry messages#sendMessage", "Inspect one procedure"],
        ["lunora advisor --min-score 80", "Exit non-zero when the score drops below 80"],
        ["lunora advisor --baseline", "Fail on any regression against the committed map"],
    ],
    group: "Develop",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "advisor",
    options: [
        { description: "Show every procedure as a check matrix, not just the ones with findings", name: "all", type: Boolean },
        {
            description: `Compare against a committed map and fail on regression (default ${DEFAULT_MAP_PATH})`,
            name: "baseline",
            type: String,
        },
        { description: "Inspect a single procedure by `file#exportName`", name: "entry", type: String },
        { description: "Output format: pretty (default) or json", name: "format", type: String },
        { description: "Exit non-zero when the global score is below this value (0-100)", name: "min-score", type: String },
        { description: "Do not write the map artifact to disk", name: "no-write", type: Boolean },
        { description: `Where to write the map (default ${DEFAULT_MAP_PATH})`, name: "out", type: String },
    ],
};

export { advisorCommand, DEFAULT_MAP_PATH };

export type AdvisorOptions = CreateOptions<{
    all: boolean | undefined;
    baseline: string | undefined;
    entry: string | undefined;
    format: string | undefined;
    "min-score": string | undefined;
    "no-write": boolean | undefined;
    out: string | undefined;
}>;
