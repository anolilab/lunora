import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `cirrus doctor` — read-only preflight over the current project. Checks the
 * wrangler config (SHARD DO binding, placeholder D1 ids), the `send_email`
 * destination, `.dev.vars` secrets, and `CIRRUS_ADMIN_TOKEN`, then prints a
 * pass/warn/fail report. Exits 1 when any hard check FAILs so it's CI-friendly.
 */
const doctorCommand: Command = {
    description: "Preflight the current Cirrus project (wrangler bindings, placeholders, dev secrets)",
    examples: [["cirrus doctor", "Run the project preflight checks"]],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "doctor",
    options: [],
};

export { doctorCommand };

export type DoctorOptions = CreateOptions<Record<string, never>>;
