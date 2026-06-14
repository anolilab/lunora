import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `cirrus rules` — manage the Cirrus agent skills ("rules") in the current
 * project. `install` copies the skills bundled with `@cirrus/cli` into
 * `.agents/skills/` (the Convex `ai-files install` analog); `check` reports
 * which are present. The dev server and Vite plugin nudge you to run `install`
 * when the rules are missing.
 */
const rulesCommand: Command = {
    argument: { description: "install | check", name: "subcommand", type: String },
    description: "Install the Cirrus agent skills (AI rules) into .agents/skills/, or check they're present",
    examples: [
        ["cirrus rules install", "Copy the Cirrus agent skills into .agents/skills/"],
        ["cirrus rules install --overwrite", "Reinstall, replacing edited skill files"],
        ["cirrus rules check", "Report which Cirrus skills are installed"],
        ["cirrus rules check --strict", "Exit non-zero when rules are missing (CI gate)"],
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
