import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverPrivilegedDispatches from "../src/discover-privileged-dispatches";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

const discover = () => discoverPrivilegedDispatches(project, join(workdir, "lunora"));

describe("discoverPrivilegedDispatches", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-dispatch-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a workflow dispatch forwarding destructured params", () => {
        expect.assertions(2);

        write(
            "workflows.ts",
            `export const onboard = defineWorkflow({
    handler: async (context) => {
        const { channelId } = context.params;
        await context.step.do("greet", () => context.run(api.messages.send, { channelId, text: "hi" }, { shardKey: channelId }));
    },
});`,
        );

        const found = discover();

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ dispatchKind: "workflow", handlerExport: "onboard", targetExport: "send", targetFile: "messages" });
    });

    it("flags a workflow dispatch reading context.params directly in the args", () => {
        expect.assertions(1);

        write(
            "direct.ts",
            `export const run = defineWorkflow({
    handler: async (context) => context.run(api.docs.create, { ownerId: context.params.ownerId }),
});`,
        );

        expect(discover()).toHaveLength(1);
    });

    it("flags a queue dispatch forwarding a message body field", () => {
        expect.assertions(2);

        write(
            "queues.ts",
            `export const emailQueue = defineQueue({
    handler: async (ctx, batch) => {
        for (const message of batch.messages) {
            await ctx.run(api.email.send, { to: message.body.to });
            message.ack();
        }
    },
});`,
        );

        const found = discover();

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ dispatchKind: "queue", handlerExport: "emailQueue", targetExport: "send", targetFile: "email" });
    });

    it("resolves an internal.<dir>.<file>.<export> target to a nested file path", () => {
        expect.assertions(1);

        write(
            "nested.ts",
            `export const run = defineWorkflow({
    handler: async (context) => context.run(internal.admin.users.grant, { userId: context.params.userId }),
});`,
        );

        expect(discover()[0]).toMatchObject({ targetExport: "grant", targetFile: "admin/users" });
    });

    it("ignores a dispatch whose args are all server-trusted / literal", () => {
        expect.assertions(1);

        write(
            "trusted.ts",
            `export const run = defineWorkflow({
    handler: async (context) => context.run(api.audit.log, { at: Date.now(), source: "workflow" }),
});`,
        );

        expect(discover()).toHaveLength(0);
    });

    it("ignores a dispatch whose object key merely shares a payload binding's name", () => {
        expect.assertions(1);

        // `channelId` is a payload binding, but here it is only the *key* of a
        // safe `{ channelId: freshId() }` value — a name position, not a use of
        // the payload. Counting the key would flag this safe dispatch.
        write(
            "keyname.ts",
            `export const onboard = defineWorkflow({
    handler: async (context) => {
        const { channelId } = context.params;
        await context.run(api.messages.send, { channelId: freshId(), text: "hi" });
    },
});`,
        );

        expect(discover()).toHaveLength(0);
    });

    it("ignores a dispatch to a non-static (variable) target it cannot resolve", () => {
        expect.assertions(1);

        write(
            "dynamic.ts",
            `export const run = defineWorkflow({
    handler: async (context) => context.run(target, { channelId: context.params.channelId }),
});`,
        );

        expect(discover()).toHaveLength(0);
    });

    it("ignores a payload-derived call that is not a dispatch method", () => {
        expect.assertions(1);

        write(
            "notrun.ts",
            `export const run = defineWorkflow({
    handler: async (context) => context.log(api.messages.send, { channelId: context.params.channelId }),
});`,
        );

        expect(discover()).toHaveLength(0);
    });

    it("ignores a plain mutation that is not a queue/workflow handler", () => {
        expect.assertions(1);

        write("plain.ts", `export const send = mutation(async ({ ctx, args }) => ctx.run(api.messages.send, { channelId: args.channelId }));`);

        expect(discover()).toHaveLength(0);
    });
});
