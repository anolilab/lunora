import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { OUTPUT_FORMAT_OPTION } from "../../util/output-format";

/**
 * `lunora doctor` — preflight over the current project. Checks the
 * wrangler config (SHARD DO binding, placeholder D1 ids), the `send_email`
 * destination, `.dev.vars` secrets, and `LUNORA_ADMIN_TOKEN`, then prints a
 * pass/warn/fail report. Exits 1 when any hard check FAILs so it's CI-friendly.
 *
 * `--format json` emits the same findings as one JSON document on stdout, each
 * carrying a stable `code`, so an agent or CI job can branch on the diagnostic
 * instead of scraping the prose.
 *
 * `--fix` resolves what it can (a placeholder D1 id, a missing or placeholder
 * `.dev.vars` secret) before the report is printed, and `--dry-run` prints the
 * same changes without making them. Those are the only writes this command makes.
 */
const doctorCommand: Command = {
    description: "Preflight the current Lunora project (wrangler bindings, placeholders, dev secrets)",
    examples: [
        ["lunora doctor", "Run the project preflight checks"],
        ["lunora doctor --format json", "Emit the findings as a machine-readable JSON document"],
        ["lunora doctor --fix", "Create the D1 databases the config names and mint the local dev secrets"],
        ["lunora doctor --fix --dry-run", "Show what --fix would create or write, without doing it"],
    ],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "doctor",
    options: [
        OUTPUT_FORMAT_OPTION,
        { description: "Resolve what can be resolved: create placeholder D1 databases, mint missing .dev.vars secrets", name: "fix", type: Boolean },
        { description: "With --fix: print the changes without making them", name: "dry-run", type: Boolean },
    ],
};

export { doctorCommand };

export type DoctorOptions = CreateOptions<{ "dry-run": boolean | undefined; fix: boolean | undefined; format: string | undefined }>;
