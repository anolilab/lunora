import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorNotifyConfig } from "../src";
import { fromServerSchema } from "../src";
import notifyMissingPushConfig from "../src/lints/static/notify-missing-push-config";

const schema = () =>
    fromServerSchema(
        defineSchema({
            devices: defineTable({ token: v.string() }),
        }),
    );

const run = (notifyConfig?: AdvisorNotifyConfig) => notifyMissingPushConfig.run({ notifyConfig, schema: schema() });

describe("notify_missing_push_config", () => {
    it("finds nothing without config evidence (runtime caller)", () => {
        expect.assertions(1);

        expect(run()).toHaveLength(0);
    });

    it("flags push usage with neither channel configured", () => {
        expect.assertions(2);

        const findings = run({ hasFcm: false, hasWebPush: false, usesPush: true });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ level: "WARN", name: "notify_missing_push_config" });
    });

    it("is clean when a Web Push channel is configured", () => {
        expect.assertions(1);

        expect(run({ hasFcm: false, hasWebPush: true, usesPush: true })).toHaveLength(0);
    });

    it("is clean when an FCM channel is configured", () => {
        expect.assertions(1);

        expect(run({ hasFcm: true, hasWebPush: false, usesPush: true })).toHaveLength(0);
    });

    it("is clean when the app does not push", () => {
        expect.assertions(1);

        expect(run({ hasFcm: false, hasWebPush: false, usesPush: false })).toHaveLength(0);
    });
});
