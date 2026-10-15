import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { OUTPUT_FORMAT_OPTION } from "../../util/output-format";

const importCommand: Command = {
    argument: { description: "Source NDJSON file, or a `npx convex export --path <dir>` directory", name: "file", type: String },
    description: "Bulk-insert rows from an NDJSON file — or a Convex export directory — via the worker's admin endpoint",
    examples: [
        ["lunora import backup.ndjson", "Bulk-insert rows from an NDJSON file"],
        ["lunora import ./convex-export", "Import a `npx convex export --path` directory (ids are preserved, so no remapping)"],
        ["lunora import ./convex-export --with-storage", "Also migrate blobs (verified sha256 upload) + `{ $storage }` refs"],
        ["lunora import ./convex-export --scan", "Write a candidate `lunora/import-convex.json` storage-column mapping (imports nothing)"],
        ["lunora import ./snapshot.zip --with-storage --verify", "Import a `npx convex export --path` zip snapshot with blob + row-parity checks"],
        ["lunora import ./supabase-csv --from supabase", "Import a directory of `COPY … TO STDOUT WITH CSV HEADER` dumps"],
        ["lunora import ./firestore-json --from firebase --verify", "Import Firestore documents (REST/Admin-SDK JSON) with row-parity checks"],
        ["lunora import backup.ndjson --replace", "Make every table hold exactly the file's rows (deletes the rest; asks first)"],
        ["lunora import backup.ndjson --replace --tables users --yes", "Restore only `users` from a full backup, without prompting"],
    ],
    group: "Data",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "import",
    options: [
        {
            description: "Source reader for a dump that cannot be detected: supabase | firebase (Convex and NDJSON are auto-detected)",
            name: "from",
            type: String,
        },
        { description: "Wrap each bare doc as `{table:<name>,doc:...}`", name: "table", type: String },
        {
            description: "Replace instead of append: the tables end up holding exactly the file's rows, every other row is deleted",
            name: "replace",
            type: Boolean,
        },
        { description: "With --replace: comma-separated tables to replace (default: every table, or --table)", name: "tables", type: String },
        OUTPUT_FORMAT_OPTION,
        { description: "Rows per HTTP request (default 500)", name: "batch-size", type: Number },
        {
            description: "Also migrate file storage — Convex `_storage` blobs, or a Supabase/Firebase bucket (verified upload)",
            name: "with-storage",
            type: Boolean,
        },
        {
            description: "Directory of storage objects to upload alongside the rows (Firebase: after `gcloud storage cp -r`)",
            name: "storage-dir",
            type: String,
        },
        { description: "Write a candidate `lunora/import-convex.json` storage-column mapping and exit", name: "scan", type: Boolean },
        { description: "Verify row parity + dangling-storage after import (non-zero exit on mismatch)", name: "verify", type: Boolean },
        { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
        { description: "Confirm bulk-writing production (required with --prod) and skip the --replace prompt", name: "yes", type: Boolean },
        { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
        {
            description: "Admin bearer token (prefer LUNORA_ADMIN_TOKEN; --token is visible to other local processes via the process table)",
            name: "token",
            type: String,
        },
    ],
};

export { importCommand };

export type ImportOptions = CreateOptions<{
    "batch-size": number | undefined;
    format: string | undefined;
    from: string | undefined;
    prod: boolean | undefined;
    replace: boolean | undefined;
    scan: boolean | undefined;
    "storage-dir": string | undefined;
    table: string | undefined;
    tables: string | undefined;
    token: string | undefined;
    url: string | undefined;
    verify: boolean | undefined;
    "with-storage": boolean | undefined;
    yes: boolean | undefined;
}>;
