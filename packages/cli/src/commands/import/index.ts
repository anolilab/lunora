import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

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
    ],
    group: "Data",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "import",
    options: [
        { description: "Source reader: convex | supabase | firebase | ndjson (default: auto-detect)", name: "from", type: String },
        { description: "Wrap each bare doc as `{table:<name>,doc:...}`", name: "table", type: String },
        { description: "Rows per HTTP request (default 500)", name: "batch-size", type: Number },
        { description: "Also migrate Convex `_storage` blobs (verified upload)", name: "with-storage", type: Boolean },
        {
            description: "Directory of storage objects to upload alongside the rows (Firebase: after `gcloud storage cp -r`)",
            name: "storage-dir",
            type: String,
        },
        { description: "Write a candidate `lunora/import-convex.json` storage-column mapping and exit", name: "scan", type: Boolean },
        { description: "Verify row parity + dangling-storage after import (non-zero exit on mismatch)", name: "verify", type: Boolean },
        { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
        { description: "Confirm bulk-writing production (required with --prod)", name: "yes", type: Boolean },
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
    from: string | undefined;
    prod: boolean | undefined;
    scan: boolean | undefined;
    "storage-dir": string | undefined;
    table: string | undefined;
    token: string | undefined;
    url: string | undefined;
    verify: boolean | undefined;
    "with-storage": boolean | undefined;
    yes: boolean | undefined;
}>;
