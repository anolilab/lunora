import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const backupCommand: Command = {
    argument: { description: "create | list | restore <id|file> | pitr", name: "subcommand", type: String },
    description: "Managed snapshot backups (create | list | restore) plus native point-in-time recovery (pitr)",
    examples: [
        ["lunora backup create", "Snapshot every table to a backup file"],
        ["lunora backup list", "List recorded snapshots"],
        ["lunora backup restore <id>", "Restore a snapshot by id"],
        ["lunora backup pitr --at 2026-06-01T00:00:00Z", "Point-in-time recovery (≤30 days)"],
    ],
    group: "Data",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "backup",
    options: [
        { description: "Backup directory (default .lunora-backups)", name: "dir", type: String },
        { description: "Comma-separated table allowlist (create)", name: "tables", type: String },
        { description: "pitr: time to read/restore to (ISO or epoch-ms, ≤30 days)", name: "at", type: String },
        { description: "pitr --restore: explicit bookmark to restore to (wins over --at)", name: "bookmark", type: String },
        { description: "pitr: perform a restore instead of just reading the bookmark", name: "restore", type: Boolean },
        { description: "pitr --restore: restart the shard now so recovery applies immediately", name: "restart", type: Boolean },
        { description: "pitr: target shard key (default: root shard)", name: "shard", type: String },
        { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
        { description: "Confirm a production pitr --restore (required with --prod)", name: "yes", type: Boolean },
        { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
        { description: "Admin bearer token (or LUNORA_ADMIN_TOKEN)", name: "token", type: String },
    ],
};

export { backupCommand };

export type BackupOptions = CreateOptions<{
    at: string | undefined;
    bookmark: string | undefined;
    dir: string | undefined;
    prod: boolean | undefined;
    restart: boolean | undefined;
    restore: boolean | undefined;
    shard: string | undefined;
    tables: string | undefined;
    token: string | undefined;
    url: string | undefined;
    yes: boolean | undefined;
}>;
