import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const introspectCommand: Command = {
    description: "Scaffold lunora/schema.ts (and list/get procedures) from an existing Postgres or MySQL database",
    examples: [
        ["lunora introspect --url postgres://localhost/shop", "Scaffold a schema + procedures from every table"],
        ["lunora introspect --tables users,orders", "Introspect only these tables (DATABASE_URL is read by default)"],
        ["lunora introspect --dry-run", "Print what would be written without touching the filesystem"],
        ["lunora introspect --no-procedures --force", "Regenerate just the schema, overwriting the existing file"],
    ],
    group: "Data",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "introspect",
    options: [
        { description: "Database connection string (default: $DATABASE_URL)", name: "url", type: String },
        { description: "Postgres schema (default `public`) or MySQL database name", name: "schema", type: String },
        { description: "Comma-separated table allow-list (default: every base table)", name: "tables", type: String },
        { description: "Also emit list/get procedure modules per table (default true; --no-procedures to skip)", name: "procedures", type: Boolean },
        { description: "Overwrite files that already exist", name: "force", type: Boolean },
        { description: "Print what would be written without writing it", name: "dry-run", type: Boolean },
    ],
};

export { introspectCommand };

export type IntrospectOptions = CreateOptions<{
    "dry-run": boolean | undefined;
    force: boolean | undefined;
    procedures: boolean | undefined;
    schema: string | undefined;
    tables: string | undefined;
    url: string | undefined;
}>;
