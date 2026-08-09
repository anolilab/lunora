import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const backupCommand: Command = {
    argument: { description: "create | list | restore <id|file> | retention | prune | pitr", name: "subcommand", type: String },
    description: "Managed snapshot backups (create | list | restore) to a directory or an R2 bucket, plus native point-in-time recovery (pitr)",
    examples: [
        ["lunora backup create", "Snapshot every table to a backup file"],
        ["lunora backup list", "List recorded snapshots"],
        ["lunora backup restore <id>", "Restore a snapshot by id"],
        ["lunora backup create --bucket default", "Snapshot into an R2 bucket instead of a directory"],
        ["lunora backup restore <id> --bucket default --verify", "Restore from R2, checksum first"],
        ["lunora backup retention", "Show what the platform's retention would delete next"],
        ["lunora backup prune", "Delete the snapshots past the retention window (the only command that deletes backups)"],
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
        { description: "Store snapshots in this R2 bucket instead of a directory (use `default` for the app's default bucket)", name: "bucket", type: String },
        { description: "Key prefix for bucket-backed snapshots (default backups/)", name: "prefix", type: String },
        { description: "restore: verify the snapshot's checksum before importing anything", name: "verify", type: Boolean },
        { description: "Comma-separated table allowlist (create)", name: "tables", type: String },
        { description: "pitr: time to read/restore to (ISO or epoch-ms, ≤30 days)", name: "at", type: String },
        { description: "pitr --restore: explicit bookmark to restore to (wins over --at)", name: "bookmark", type: String },
        { description: "pitr: perform a restore instead of just reading the bookmark", name: "restore", type: Boolean },
        { description: "pitr --restore: restart the shard now so recovery applies immediately", name: "restart", type: Boolean },
        { description: "pitr: target shard key (default: root shard)", name: "shard", type: String },
        { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
        { description: "Confirm a destructive step without prompting: a production pitr --restore, or backup prune", name: "yes", type: Boolean },
        { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
        {
            description: "Admin bearer token (prefer LUNORA_ADMIN_TOKEN; --token is visible to other local processes via the process table)",
            name: "token",
            type: String,
        },
    ],
};

export { backupCommand };

export type BackupOptions = CreateOptions<{
    at: string | undefined;
    bookmark: string | undefined;
    bucket: string | undefined;
    dir: string | undefined;
    prefix: string | undefined;
    prod: boolean | undefined;
    restart: boolean | undefined;
    restore: boolean | undefined;
    shard: string | undefined;
    tables: string | undefined;
    token: string | undefined;
    url: string | undefined;
    verify: boolean | undefined;
    yes: boolean | undefined;
}>;
