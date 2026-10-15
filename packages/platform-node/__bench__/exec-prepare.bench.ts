import Database from "better-sqlite3";
import { bench, describe } from "vitest";

import { createNodeShardHost } from "../src/node-shard-host";

/*
 * 10k point reads. `recompile` is the old behaviour (a fresh `database.prepare`
 * per call); `shard host exec` goes through the cached path.
 */
const READS = 10_000;

describe("point read x10k", () => {
    const { host } = createNodeShardHost();

    host.sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    host.sql.exec("INSERT INTO t (id, v) VALUES (1, 'a')");

    const raw = new Database(":memory:");

    raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    raw.exec("INSERT INTO t (id, v) VALUES (1, 'a')");

    bench("recompile (prepare per call)", () => {
        for (let index = 0; index < READS; index += 1) {
            raw.prepare("SELECT v FROM t WHERE id = ?").all(1);
        }
    });

    bench("shard host exec (cached)", () => {
        for (let index = 0; index < READS; index += 1) {
            host.sql.exec("SELECT v FROM t WHERE id = ?", 1).toArray();
        }
    });
});
