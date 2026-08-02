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
        // Declared as a `no-*` option, like `codegen`'s `--no-strict-advisories` /
        // `dev`'s `--no-studio` / `--no-codegen` / `--no-worker`: cerebro reads a
        // `no-`-prefixed name as the negative half of a negatable boolean and
        // synthesizes the positive counterpart itself, exposing the RESULT under
        // the positive camelCase key (`write`) at runtime — so `--no-write` and
        // `--write` both work and `options.write` defaults to `true`. Declaring
        // the positive name directly (as this used to) never registers a
        // `--no-write` flag at all — cerebro only negates options named `no-*`
        // — which is exactly why `--no-write` was rejected as unknown (#285).
        { description: "Write the map artifact to disk (default true; use --no-write to skip)", name: "no-write", type: Boolean },
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
