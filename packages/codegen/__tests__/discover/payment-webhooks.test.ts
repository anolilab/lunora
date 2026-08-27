import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverPaymentWebhooks from "../src/discover-payment-webhooks";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

// eslint-disable-next-line no-secrets/no-secrets -- the describe block names the function under test, not a credential
describe("discoverPaymentWebhooks", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-payment-webhooks-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("captures a statically-known webhookToleranceSeconds literal on createStripeAdapter", () => {
        expect.assertions(2);

        write("payment.ts", `export const adapter = createStripeAdapter({ client, webhookSecret, webhookToleranceSeconds: 86400 });`);

        const rows = discoverPaymentWebhooks(project, join(workdir, "lunora"));

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ callee: "createStripeAdapter", exportName: "adapter", toleranceSeconds: 86_400 });
    });

    it("records createPolarAdapter with no tolerance option", () => {
        expect.assertions(2);

        write("payment.ts", `export const adapter = createPolarAdapter({ client, webhookSecret });`);

        const [row] = discoverPaymentWebhooks(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ callee: "createPolarAdapter" });
        expect(row?.toleranceSeconds).toBeUndefined();
    });

    it("leaves toleranceSeconds undefined when the value is a non-literal expression", () => {
        expect.assertions(1);

        write("payment.ts", `export const adapter = createStripeAdapter({ client, webhookSecret, webhookToleranceSeconds: 60 * 60 });`);

        const [row] = discoverPaymentWebhooks(project, join(workdir, "lunora"));

        expect(row?.toleranceSeconds).toBeUndefined();
    });

    it("does not track an unrelated factory call", () => {
        expect.assertions(1);

        write("payment.ts", `export const p = createPayment({ adapter, webhookToleranceSeconds: 86400 });`);

        expect(discoverPaymentWebhooks(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
