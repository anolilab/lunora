import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `lunora eval` — discover every `*.eval.ts` under `evals/` (or `--dir`) and
 * run it through its own default-exported `run()`, which calls
 * `evaluate`/`agentHarness` from `@lunora/testing` however the eval needs.
 * Entirely in-process: no `wrangler dev`/`lunora dev` needed, unlike `seed`/
 * `insights`. Metadata only; the handler (lazy-loaded via `loader`) holds the
 * logic. See `plans/245-eval-runner-design.md`.
 */
const evalCommand: Command = {
    description: "Run every *.eval.ts under evals/ via @lunora/testing's evaluate/agentHarness — no live worker needed",
    examples: [
        ["lunora eval", "Run every eval under evals/, print the aggregate table"],
        ["lunora eval --threshold 0.8", "Non-zero exit if any eval's average score falls below 0.8"],
        ["lunora eval --dir evals/support --format json", "Run a subset and emit a machine-readable result"],
    ],
    group: "Develop",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "eval",
    options: [
        { description: "Directory to discover *.eval.ts files under (default evals/)", name: "dir", type: String },
        { description: "Output format: pretty (default) or json", name: "format", type: String },
        {
            description: "Score gate every eval's average must meet ([0,1]); a per-eval `threshold` export wins over this for that eval",
            name: "threshold",
            type: Number,
        },
    ],
};

export { evalCommand };

export type EvalOptions = CreateOptions<{
    dir: string | undefined;
    format: string | undefined;
    threshold: number | undefined;
}>;
