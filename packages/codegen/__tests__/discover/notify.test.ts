import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FcmCredentials } from "../../src/discover/notify";
import { discoverNotifyCalls, discoverNotifyChannels, discoverNotifyConfig } from "../../src/discover/notify";

/** A mutation that sends a push via `ctx.push.send` — must be recorded (outside-action). */
const MUTATION_PUSH_SEND = `
    import { mutation } from "@lunora/server";

    export const ping = mutation({
        args: {},
        handler: async (ctx) => ctx.push.send("sub-1", { title: "hi" }),
    });
`;

/** A query that broadcasts via `ctx.notify.push.broadcast` — normalises to ctx.push.broadcast. */
const QUERY_NOTIFY_PUSH_BROADCAST = `
    import { query } from "@lunora/server";

    export const fanout = query({
        args: {},
        handler: async (ctx) => ctx.notify.push.broadcast({ title: "news" }),
    });
`;

/** A mutation that sends a multi-channel notify via `ctx.notify.send`. */
const MUTATION_NOTIFY_SEND = `
    import { mutation } from "@lunora/server";

    export const announce = mutation({
        args: {},
        handler: async (ctx) => ctx.notify.send({ push: { title: "x" } }),
    });
`;

/** The same push send inside an action — must NOT be recorded (actions are the escape hatch). */
const ACTION_PUSH_SEND = `
    import { action } from "@lunora/server";

    export const notify = action({
        args: {},
        handler: async (ctx) => ctx.push.broadcast({ title: "ok" }),
    });
`;

/** A store lifecycle op (register) — not a send, must NOT be recorded. */
const MUTATION_PUSH_REGISTER = `
    import { mutation } from "@lunora/server";

    export const sub = mutation({
        args: {},
        handler: async (ctx) => ctx.push.register({ token: "t", kind: "fcm" }),
    });
`;

let workdir: string;
let project: Project;

const lunoraDirectory = (): string => join(workdir, "lunora");

describe("discoverNotifyCalls", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-notify-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a ctx.push.send inside a mutation handler with its callee label", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "ping.ts"), MUTATION_PUSH_SEND, "utf8");

        const calls = discoverNotifyCalls(project, lunoraDirectory());

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ callee: "ctx.push.send", exportName: "ping", file: "ping", kind: "mutation" });
    });

    it("normalises ctx.notify.push.broadcast to ctx.push.broadcast inside a query", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "fanout.ts"), QUERY_NOTIFY_PUSH_BROADCAST, "utf8");

        const calls = discoverNotifyCalls(project, lunoraDirectory());

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ callee: "ctx.push.broadcast", exportName: "fanout", file: "fanout", kind: "query" });
    });

    it("records a ctx.push.sendToTopic inside a query as a device-push send", () => {
        expect.assertions(2);

        writeFileSync(
            join(workdir, "lunora", "news.ts"),
            `
    import { query } from "@lunora/server";

    export const headlines = query({
        args: {},
        handler: async (ctx) => ctx.push.sendToTopic("news", { title: "news" }),
    });
`,
            "utf8",
        );

        const calls = discoverNotifyCalls(project, lunoraDirectory());

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ callee: "ctx.push.sendToTopic", exportName: "headlines", kind: "query" });
    });

    it("records a ctx.notify.send multi-channel send inside a mutation", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "announce.ts"), MUTATION_NOTIFY_SEND, "utf8");

        const calls = discoverNotifyCalls(project, lunoraDirectory());

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ callee: "ctx.notify.send", exportName: "announce", kind: "mutation" });
    });

    it("does NOT record a send inside an action handler", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "notify.ts"), ACTION_PUSH_SEND, "utf8");

        expect(discoverNotifyCalls(project, lunoraDirectory())).toHaveLength(0);
    });

    it("does NOT record a store lifecycle op (register) — only sends", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "sub.ts"), MUTATION_PUSH_REGISTER, "utf8");

        expect(discoverNotifyCalls(project, lunoraDirectory())).toHaveLength(0);
    });
});

describe("discoverNotifyConfig", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-notify-cfg-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("returns undefined when the project declares no lunora/notify.ts", () => {
        expect.assertions(1);

        expect(discoverNotifyConfig(project, lunoraDirectory())).toBeUndefined();
    });

    it("reports the wired push channels and push usage from defineNotify + handlers", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "notify.ts"),
            `import { defineNotify, webPushFromEnv } from "@lunora/notify";
export default defineNotify({ webPush: (env) => webPushFromEnv(env) });
`,
            "utf8",
        );
        writeFileSync(join(workdir, "lunora", "ping.ts"), ACTION_PUSH_SEND, "utf8");

        expect(discoverNotifyConfig(project, lunoraDirectory())).toStrictEqual({ hasFcm: false, hasWebPush: true, usesFcmOnlySend: false, usesPush: true });
    });

    it("marks a topic send as FCM-only in the config evidence", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "notify.ts"),
            `import { defineNotify, webPushFromEnv } from "@lunora/notify";
export default defineNotify({ webPush: (env) => webPushFromEnv(env) });
`,
            "utf8",
        );
        writeFileSync(
            join(workdir, "lunora", "news.ts"),
            `import { mutation } from "@lunora/server";

export const headline = mutation({
    args: {},
    handler: async (ctx) => ctx.push.sendToTopic("news", { title: "news" }),
});
`,
            "utf8",
        );

        expect(discoverNotifyConfig(project, lunoraDirectory())).toStrictEqual({ hasFcm: false, hasWebPush: true, usesFcmOnlySend: true, usesPush: true });
    });

    it("flags a push-using app whose defineNotify wires neither channel (usesPush, no channels)", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "notify.ts"),
            `import { defineNotify } from "@lunora/notify";
export default defineNotify({});
`,
            "utf8",
        );
        writeFileSync(join(workdir, "lunora", "ping.ts"), MUTATION_PUSH_SEND, "utf8");

        expect(discoverNotifyConfig(project, lunoraDirectory())).toStrictEqual({ hasFcm: false, hasWebPush: false, usesFcmOnlySend: false, usesPush: true });
    });

    it.each([
        [
            "a computed variable argument",
            `import { defineNotify } from "@lunora/notify";
import { buildNotifyConfig } from "./notify-config";
const config = buildNotifyConfig();
export default defineNotify(config);
`,
        ],
        [
            "a spread",
            `import { defineNotify } from "@lunora/notify";
import { base } from "./notify-base";
export default defineNotify({ ...base, webPush: () => undefined });
`,
        ],
        [
            "a re-exported definition",
            `import definition from "./notify-definition";
export default definition;
`,
        ],
        [
            "a wrapper factory around defineNotify",
            `import { defineNotify } from "@lunora/notify";
const withDefaults = (config: { webPush: () => void }) => defineNotify({ ...config, fcm: () => undefined });
export default withDefaults({ webPush: () => undefined });
`,
        ],
        [
            "a same-file variable config mutated via Object.assign",
            `import { defineNotify } from "@lunora/notify";
const config = { webPush: () => undefined };
Object.assign(config, { fcm: () => undefined });
export default defineNotify(config);
`,
        ],
        [
            "a same-file variable config with a property write",
            `import { defineNotify } from "@lunora/notify";
const config = { webPush: () => undefined };
config.fcm = () => undefined;
export default defineNotify(config);
`,
        ],
        [
            "a reassignable (let) variable config",
            `import { defineNotify } from "@lunora/notify";
let config = { webPush: () => undefined };
export default defineNotify(config);
`,
        ],
    ])("reports both channels when they can't be read statically (%s)", (_label, source) => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "notify.ts"), source, "utf8");

        expect(discoverNotifyConfig(project, lunoraDirectory())).toStrictEqual({ hasFcm: true, hasWebPush: true, usesFcmOnlySend: false, usesPush: false });
    });

    it("follows a same-file const alias of a direct defineNotify call (webPush-only does not scaffold fcm)", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "notify.ts"),
            `import { defineNotify } from "@lunora/notify";
const definition = defineNotify({ webPush: () => undefined });
export default definition;
`,
            "utf8",
        );

        expect(discoverNotifyConfig(project, lunoraDirectory())).toStrictEqual({ hasFcm: false, hasWebPush: true, usesFcmOnlySend: false, usesPush: false });
    });

    it("follows a cross-file default re-export of a direct defineNotify call (webPush-only does not scaffold fcm)", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "notify-definition.ts"),
            `import { defineNotify } from "@lunora/notify";
export default defineNotify({ webPush: () => undefined });
`,
            "utf8",
        );
        writeFileSync(
            join(workdir, "lunora", "notify.ts"),
            `import definition from "./notify-definition";
export default definition;
`,
            "utf8",
        );

        expect(discoverNotifyConfig(project, lunoraDirectory())).toStrictEqual({ hasFcm: false, hasWebPush: true, usesFcmOnlySend: false, usesPush: false });
    });

    it("reads a same-file variable config argument of defineNotify (webPush-only does not scaffold fcm)", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "notify.ts"),
            `import { defineNotify } from "@lunora/notify";
const config = { webPush: () => undefined };
export default defineNotify(config);
`,
            "utf8",
        );

        expect(discoverNotifyConfig(project, lunoraDirectory())).toStrictEqual({ hasFcm: false, hasWebPush: true, usesFcmOnlySend: false, usesPush: false });
    });

    it("reads an imported variable config argument of defineNotify from a sibling file (webPush-only does not scaffold fcm)", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "notify-config.ts"), `export const config = { webPush: () => undefined };\n`, "utf8");
        writeFileSync(
            join(workdir, "lunora", "notify.ts"),
            `import { defineNotify } from "@lunora/notify";
import { config } from "./notify-config";
export default defineNotify(config);
`,
            "utf8",
        );

        expect(discoverNotifyConfig(project, lunoraDirectory())).toStrictEqual({ hasFcm: false, hasWebPush: true, usesFcmOnlySend: false, usesPush: false });
    });

    it("reports both channels when an imported config is mutated in the using file", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "notify-config.ts"), `export const config = { webPush: () => undefined };\n`, "utf8");
        writeFileSync(
            join(workdir, "lunora", "notify.ts"),
            `import { defineNotify } from "@lunora/notify";
import { config } from "./notify-config";
Object.assign(config, { fcm: () => undefined });
export default defineNotify(config);
`,
            "utf8",
        );

        expect(discoverNotifyConfig(project, lunoraDirectory())).toStrictEqual({ hasFcm: true, hasWebPush: true, usesFcmOnlySend: false, usesPush: false });
    });

    it("reports both channels when an imported config is mutated in its declaring file", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "notify-config.ts"),
            `export const config = { webPush: () => undefined };\nObject.assign(config, { fcm: () => undefined });\n`,
            "utf8",
        );
        writeFileSync(
            join(workdir, "lunora", "notify.ts"),
            `import { defineNotify } from "@lunora/notify";
import { config } from "./notify-config";
export default defineNotify(config);
`,
            "utf8",
        );

        expect(discoverNotifyConfig(project, lunoraDirectory())).toStrictEqual({ hasFcm: true, hasWebPush: true, usesFcmOnlySend: false, usesPush: false });
    });
});

describe("fcm credentials read from defineNotify", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-notify-fcm-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const fcmOfSource = (source: string): FcmCredentials | undefined => {
        writeFileSync(join(workdir, "lunora", "notify.ts"), source, "utf8");

        return discoverNotifyChannels(project, lunoraDirectory())?.fcm;
    };

    const fcmOf = (fcmValue: string): FcmCredentials | undefined =>
        fcmOfSource(`import { defineNotify, fcmFromEnv } from "@lunora/notify";
import { getAccessToken } from "./google-auth";
export default defineNotify({ fcm: ${fcmValue} });
`);

    it.each([
        ["a spread of fcmFromEnv plus its own token", "(env) => ({ ...fcmFromEnv(env), getAccessToken })"],
        ["fcmFromEnv overrides", "(env) => fcmFromEnv(env, { getAccessToken })"],
        ["a non-null fcmFromEnv overrides call", "(env) => fcmFromEnv(env, { getAccessToken })!"],
        ["a block body returning the object", "(env) => { return { ...fcmFromEnv(env), getAccessToken: getAccessToken }; }"],
        ["an inline token function", `(env) => ({ ...fcmFromEnv(env), getAccessToken: async () => "t" })`],
    ])("reads its own token source for %s", (_label, fcmValue) => {
        expect.assertions(1);

        expect(fcmOf(fcmValue)).toBe("ownToken");
    });

    it("reads its own token source for an fcm method", () => {
        expect.assertions(1);

        expect(
            fcmOfSource(`import { defineNotify, fcmFromEnv } from "@lunora/notify";
import { getAccessToken } from "./google-auth";
export default defineNotify({ fcm(env) { return fcmFromEnv(env, { getAccessToken }); } });
`),
        ).toBe("ownToken");
    });

    it.each([
        ["read from env", "{ getAccessToken, projectId: env.FCM_PROJECT_ID }"],
        ["a shorthand variable", "{ getAccessToken, projectId }"],
        ["an empty string, which fcmFromEnv treats as unset", `fcmFromEnv(env, { getAccessToken, projectId: "" })`],
        ["replaced by a later computed key", `{ projectId: "acme", [key]: env.FCM_PROJECT_ID, getAccessToken }`],
        ["replaced by a later member of the same name", `{ getAccessToken, projectId: "acme", projectId: env.FCM_PROJECT_ID }`],
    ])("still takes the project id from env when projectId is %s", (_label, object) => {
        expect.assertions(1);

        expect(fcmOf(`(env) => (${object})`)).toBe("ownToken");
    });

    it.each([
        ["a literal projectId", `{ getAccessToken, projectId: "acme" }`],
        ["a later computed key it can resolve statically", `{ getAccessToken, projectId: "acme", ["region"]: "eu" }`],
    ])("reads own credentials for %s", (_label, fcmValue) => {
        expect.assertions(1);

        expect(fcmOf(fcmValue)).toBe("ownCredentials");
    });

    it.each([
        ["plain fcmFromEnv", "(env) => fcmFromEnv(env)"],
        ["the bare fcmFromEnv reference", "fcmFromEnv"],
        ["a static accessToken override", `(env) => fcmFromEnv(env, { accessToken: "tok" })`],
        ["a literal projectId with no token of its own", `(env) => fcmFromEnv(env, { projectId: "acme" })`],
        ["a spread after the token, which can replace it", "(env) => ({ getAccessToken, ...fcmFromEnv(env) })"],
        ["a computed key after the token, which can replace it", "(env) => ({ ...fcmFromEnv(env), getAccessToken, [key]: undefined })"],
        ["getAccessToken set to undefined", "(env) => fcmFromEnv(env, { getAccessToken: undefined })"],
        ["a conditional getAccessToken", "(env) => fcmFromEnv(env, { getAccessToken: useOwn ? getAccessToken : undefined })"],
        ["a function passed as the overrides argument", `(env) => fcmFromEnv(env, () => ({ getAccessToken, projectId: "p" }))`],
        ["a call to some other factory", "(env) => buildFcm(env, { getAccessToken })"],
        ["a block body that does more than return", "(env) => { const base = fcmFromEnv(env); return { ...base, getAccessToken }; }"],
    ])("reads env credentials for %s", (_label, fcmValue) => {
        expect.assertions(1);

        expect(fcmOf(fcmValue)).toBe("env");
    });

    it.each([
        [
            "a local function that is only named fcmFromEnv",
            `import { defineNotify, fcmFromEnv as packageFcmFromEnv } from "@lunora/notify";
import { getAccessToken } from "./google-auth";
const fcmFromEnv = (env: Record<string, unknown>, _ignored?: unknown) => packageFcmFromEnv(env);
export default defineNotify({ fcm: (env) => fcmFromEnv(env, { getAccessToken }) });
`,
        ],
        [
            "an fcm member that a later computed key can replace",
            `import { defineNotify, fcmFromEnv } from "@lunora/notify";
import { getAccessToken } from "./google-auth";
const key: string = "fcm";
export default defineNotify({ fcm: (env) => ({ ...fcmFromEnv(env), getAccessToken }), [key]: (env) => fcmFromEnv(env) });
`,
        ],
        [
            "a variable config that an alias of it rewrites",
            `import { defineNotify, fcmFromEnv } from "@lunora/notify";
import { getAccessToken } from "./google-auth";
const config = { fcm: (env) => ({ ...fcmFromEnv(env), getAccessToken }) };
const alias = config;
alias.fcm = (env) => fcmFromEnv(env);
export default defineNotify(config);
`,
        ],
    ])("reads env credentials for %s", (_label, source) => {
        expect.assertions(1);

        expect(fcmOfSource(source)).toBe("env");
    });

    it("reads env credentials and both channels when the config falls back to every channel", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "notify.ts"),
            `import { defineNotify } from "@lunora/notify";
import { base } from "./notify-base";
export default defineNotify({ ...base, fcm: () => ({ getAccessToken: async () => "t", projectId: "p" }) });
`,
            "utf8",
        );

        expect(discoverNotifyChannels(project, lunoraDirectory())).toStrictEqual({ fcm: "env", hasWebPush: true });
    });
});
