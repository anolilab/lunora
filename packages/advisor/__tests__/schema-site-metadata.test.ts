import { describe, expect, it } from "vitest";

import type { AdvisorInsertWrite, AdvisorQueue, AdvisorSchema, AdvisorTopic, LintContext } from "../src";
import commitOrderedHardDelete from "../src/lints/static/commit-ordered-hard-delete";
import crossModuleTableWrite from "../src/lints/static/cross-module-table-write";
import emptyIndex from "../src/lints/static/empty-index";
import notifyMissingPushConfig from "../src/lints/static/notify-missing-push-config";
import plaintextSecretInWranglerVariables from "../src/lints/static/plaintext-secret-in-wrangler-variables";
import topicTooManySubscriptions from "../src/lints/static/topic-too-many-subscriptions";
import unindexedForeignKey from "../src/lints/static/unindexed-foreign-key";

/*
 * Schema, config and topic findings name where the object is declared: the `file` and `line` the codegen
 * feeder recorded are copied into the finding's metadata. An object with no recorded site carries neither key.
 */

const context = (parts: Partial<LintContext>): LintContext => {
    return { schema: { tables: [] }, ...parts };
};

describe("schema findings copy the declaration site of the object they report", () => {
    it("a table finding carries the table's defineTable site", () => {
        expect.assertions(1);

        const schema: AdvisorSchema = {
            tables: [
                {
                    commitOrdered: true,
                    fields: ["text"],
                    file: "chat/messages",
                    indexes: [],
                    line: 12,
                    name: "messages",
                    relations: [],
                },
            ],
        };

        const findings = commitOrderedHardDelete.run(context({ schema }));

        expect(findings[0]?.metadata).toMatchObject({ file: "chat/messages", line: 12, table: "messages" });
    });

    it("an index finding carries the index's method-name site, not its table's", () => {
        expect.assertions(1);

        const schema: AdvisorSchema = {
            tables: [
                {
                    fields: ["text"],
                    file: "schema",
                    indexes: [{ fields: [], file: "schema", kind: "index", line: 7, name: "by_nothing" }],
                    line: 4,
                    name: "messages",
                    relations: [],
                },
            ],
        };

        const findings = emptyIndex.run(context({ schema }));

        expect(findings[0]?.metadata).toMatchObject({ file: "schema", index: "by_nothing", line: 7 });
    });

    it("a relation finding carries the relation's property site", () => {
        expect.assertions(1);

        const schema: AdvisorSchema = {
            tables: [
                {
                    fields: ["authorId"],
                    indexes: [],
                    name: "posts",
                    relations: [{ field: "authorId", file: "schema", kind: "one", line: 11, name: "author", references: "_id", table: "users" }],
                },
                { fields: ["email"], indexes: [], name: "users", relations: [] },
            ],
        };

        const findings = unindexedForeignKey.run(context({ schema }));

        expect(findings[0]?.metadata).toMatchObject({ file: "schema", line: 11, relation: "author", table: "posts" });
    });

    it("a finding on an object with no recorded site carries no location", () => {
        expect.assertions(2);

        const schema: AdvisorSchema = {
            tables: [{ commitOrdered: true, fields: [], indexes: [], name: "installed", relations: [] }],
        };

        const findings = commitOrderedHardDelete.run(context({ schema }));

        expect(findings[0]?.metadata).toStrictEqual({ table: "installed" });
        expect(findings[0]?.metadata).not.toHaveProperty("file");
    });
});

describe("config and topic findings copy their declaration site", () => {
    it("a plaintext wrangler var finding carries the key's line", () => {
        expect.assertions(1);

        const findings = plaintextSecretInWranglerVariables.run(
            context({
                wranglerVariables: [{ file: "wrangler.jsonc", key: "STRIPE_SECRET_KEY", kind: "stripe_live_key", line: 6, preview: "sk_li…" }],
            }),
        );

        expect(findings[0]?.metadata).toMatchObject({ file: "wrangler.jsonc", key: "STRIPE_SECRET_KEY", line: 6 });
    });

    it("a topic with too many subscriptions carries the defineTopic declaration", () => {
        expect.assertions(1);

        const topic: AdvisorTopic = { exportName: "signups", file: "queues", line: 4 };
        const queues: AdvisorQueue[] = Array.from({ length: 11 }, (_unused, index) => {
            return { exportName: `sub${String(index)}`, mode: "push", name: `sub-${String(index)}`, topic: "signups", tuning: {} };
        });

        const findings = topicTooManySubscriptions.run(context({ queues, topics: [topic] }));

        expect(findings[0]?.metadata).toMatchObject({ file: "queues", line: 4, topic: "signups" });
    });

    it("a notify config finding has no location, since its evidence is not one call", () => {
        expect.assertions(2);

        const findings = notifyMissingPushConfig.run(context({ notifyConfig: { hasFcm: false, hasWebPush: false, usesFcmOnlySend: false, usesPush: true } }));

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).not.toHaveProperty("file");
    });
});

describe("cross_module_table_write copies the earliest line among the writes it reports", () => {
    it("uses the lowest line of the writes that share the finding's cache key", () => {
        expect.assertions(2);

        const write = (line: number): AdvisorInsertWrite => {
            return { file: "accounts/signup", line, scope: { kind: "export", name: "create" }, table: "invoices" };
        };

        const findings = crossModuleTableWrite.run(
            context({
                inserts: [write(9), write(4)],
                modules: [
                    { name: "billing", tables: ["invoices"] },
                    { name: "accounts", tables: [] },
                ],
                schema: { tables: [{ fields: [], indexes: [], name: "invoices", relations: [] }] },
            }),
        );

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).toMatchObject({ file: "accounts/signup", line: 4 });
    });
});
