import type { RenderedSql } from "@lunora/shard-engine";
import { renderSql } from "@lunora/shard-engine";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { PgDialect } from "drizzle-orm/pg-core";

/** A `SqlDialect.render` for a fake dialect that borrows another engine's name, so statements quote and number the way that engine's do. */
const renderFor = (name: "mysql" | "postgres" | "sqlite"): ((query: SQL) => RenderedSql) => {
    if (name === "sqlite") {
        return (query) => renderSql("sqlite", query);
    }

    const dialect = name === "postgres" ? new PgDialect() : new MySqlDialect();

    return (query) => {
        const { params, sql: text } = dialect.sqlToQuery(query);

        return { params, sql: text };
    };
};

export default renderFor;
