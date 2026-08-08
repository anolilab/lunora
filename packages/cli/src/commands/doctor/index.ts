import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `lunora doctor` — read-only preflight over the current project. Checks the
 * wrangler config (SHARD DO binding, placeholder D1 ids), the `send_email`
 * destination, `.dev.vars` secrets, and `LUNORA_ADMIN_TOKEN`, then prints a
 * pass/warn/fail report. Exits 1 when any hard check FAILs so it's CI-friendly.
 *
 * `--format json` emits the same findings as one JSON document on stdout, each
 * carrying a stable `code`, so an agent or CI job can branch on the diagnostic
 * instead of scraping the prose.
 */
const doctorCommand: Command = {
    description: "Preflight the current Lunora project (wrangler bindings, placeholders, dev secrets)",
    examples: [
        ["lunora doctor", "Run the project preflight checks"],
        ["lunora doctor --format json", "Emit the findings as a machine-readable JSON document"],
    ],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "doctor",
    options: [{ description: "Output format: pretty (default) or json", name: "format", type: String }],
};

export { doctorCommand };

export type DoctorOptions = CreateOptions<{ format: string | undefined }>;
