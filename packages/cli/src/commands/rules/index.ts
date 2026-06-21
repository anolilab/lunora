import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `lunora rules` — manage the Lunora agent skills ("rules") in the current
 * project. `install` copies the skills bundled with `@lunora/cli` into
 * `.agents/skills/` (the Convex `ai-files install` analog); `check` reports
 * which are present. The dev server and Vite plugin nudge you to run `install`
 * when the rules are missing.
 */
const rulesCommand: Command = {
    argument: { description: "install | check", name: "subcommand", type: String },
    description: "Install the Lunora agent skills (AI rules) into .agents/skills/, or check they're present",
    examples: [
        ["lunora rules install", "Copy the Lunora agent skills into .agents/skills/"],
        ["lunora rules install --overwrite", "Reinstall, replacing edited skill files"],
        ["lunora rules check", "Report which Lunora skills are installed"],
        ["lunora rules check --strict", "Exit non-zero when rules are missing (CI gate)"],
    ],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "rules",
    options: [
        { description: "install: overwrite skill files that already exist (default: skip them)", name: "overwrite", type: Boolean },
        { description: "check: exit non-zero when the rules are missing (for CI gating)", name: "strict", type: Boolean },
    ],
};

export { rulesCommand };

export type RulesOptions = CreateOptions<{ overwrite: boolean | undefined; strict: boolean | undefined }>;
