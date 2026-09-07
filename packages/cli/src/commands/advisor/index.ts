import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import DEFAULT_MAP_PATH from "./constants";

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
        { description: `Where to write the map (default ${DEFAULT_MAP_PATH})`, name: "out", type: String },
        // BOTH halves are declared, like `codegen`'s `--strict-advisories` pair.
        // cerebro only registers a `--no-X` flag for an option literally named
        // `no-X` (declaring just `write` is why `--no-write` was once rejected as
        // unknown, #285), but a `no-*`-ONLY declaration makes it synthesize the
        // positive form by cloning this description verbatim — so `--help` listed
        // `--write` under the negation's wording. Both are exposed under the one
        // positive camelCase key (`write`); neither sets a `defaultValue`, so it
        // stays `undefined` until the user picks a side and the handler's
        // `!== false` read treats that as "write it".
        { description: "Write the map artifact to disk (the default)", name: "write", type: Boolean },
        { description: "Don't write the map artifact to disk — report only", name: "no-write", type: Boolean },
    ],
};

export { advisorCommand };

export type AdvisorOptions = CreateOptions<{
    all: boolean | undefined;
    baseline: string | undefined;
    entry: string | undefined;
    format: string | undefined;
    "min-score": string | undefined;
    out: string | undefined;
    write: boolean | undefined;
}>;
