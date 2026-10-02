import { describe, expect, it, vi } from "vitest";

import { sha256HexBytes } from "../src/deploy/keys";
import type { TenantDeploymentSpec } from "../src/provision-contract";
import type { ProvisionJob } from "../src/targets/cloudflare-wfp/box-contract";
import type { CloudflareWfpPorts } from "../src/targets/cloudflare-wfp/driver";
import { createCloudflareWfpDriver } from "../src/targets/cloudflare-wfp/driver";
import type { ProvisionBox } from "../src/targets/cloudflare-wfp/provision-box";

const spec: TenantDeploymentSpec = {
    alias: "org-project",
    bundle: new TextEncoder().encode("export default {}").buffer,
    deploymentId: "dep_1",
    kind: "production",
    manifest: { bindings: [{ binding: "DB", type: "d1" }] },
    secrets: { LUNORA_ADMIN_TOKEN: "t" },
    tags: ["org:org", "project:project", "env:production"],
};

/** A fake provision box: records each instance name + job, answers these chunks (split wherever the test says). */
const fakeBox = (chunks: ReadonlyArray<string>, status = 200): { box: ProvisionBox; calls: { job: ProvisionJob; name: string }[] } => {
    const calls: { job: ProvisionJob; name: string }[] = [];
    const encoder = new TextEncoder();

    return {
        box: {
            get: (name) => {
                return {
                    fetch: async (_path, init) => {
                        calls.push({ job: JSON.parse(init?.body as string) as ProvisionJob, name });

                        return new Response(
                            new ReadableStream<Uint8Array>({
                                start(controller) {
                                    for (const chunk of chunks) {
                                        controller.enqueue(encoder.encode(chunk));
                                    }

                                    controller.close();
                                },
                            }),
                            { status },
                        );
                    },
                };
            },
        },
        calls,
    };
};

/** The driver over a fake box, configured the way the production cell is. */
const driverFor = (box: ProvisionBox, overrides: Partial<CloudflareWfpPorts> = {}) =>
    createCloudflareWfpDriver({ appDomain: "lunora.app", box: () => box, cell: "cell-1", dispatchNamespace: "lunora-production", ...overrides });

describe(createCloudflareWfpDriver, () => {
    it("posts the deploy job to the project's box, forwards logs, and resolves the result", async () => {
        // The result line arrives split across two reads, with no trailing newline.
        const { box, calls } = fakeBox([
            '{"type":"log","line":"creating d1"}\n{"type":"log","line":"up',
            'loading"}\n{"type":"res',
            'ult","url":"https://x.workers.dev"}',
        ]);
        const onLog = vi.fn<(line: string) => void>();

        const result = await driverFor(box, { onLog }).deploy(spec);

        expect(result).toStrictEqual({
            bundleHash: await sha256HexBytes(spec.bundle),
            url: "https://org-project.lunora.app",
        });
        expect(onLog.mock.calls).toStrictEqual([["creating d1"], ["uploading"]]);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.name).toBe("org-project");

        const job = calls[0]?.job;

        expect(job?.action).toBe("deploy");
        expect(job?.action === "deploy" && atob(job.spec.bundle)).toBe("export default {}");
        // The Cloudflare half the neutral spec does not carry comes from the driver's own configuration.
        expect(job).toMatchObject({ spec: { alias: "org-project", cell: "cell-1", dispatchNamespace: "lunora-production" } });
        expect(job?.action === "deploy" && job.spec.tailConsumers).toBeUndefined();
    });

    it("attaches the platform log tail when the release collects logs", async () => {
        const { box, calls } = fakeBox(['{"type":"result"}\n']);

        await driverFor(box).deploy({ ...spec, collectLogs: true });

        expect(calls[0]?.job).toMatchObject({ spec: { tailConsumers: ["lunora-log-tail"] } });
    });

    it("throws the box's error message", async () => {
        const { box } = fakeBox(['{"type":"log","line":"x"}\n{"type":"error","message":"d1 quota exceeded"}\n']);

        await expect(driverFor(box).deploy(spec)).rejects.toThrow("d1 quota exceeded");
    });

    it("throws when the stream ends without a result", async () => {
        const { box } = fakeBox(['{"type":"log","line":"x"}\n']);

        await expect(driverFor(box).deploy(spec)).rejects.toThrow(/without a result/u);
    });

    it("surfaces a 409 as a retryable busy error", async () => {
        const { box } = fakeBox([], 409);

        await expect(driverFor(box).deploy(spec)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    });

    it("sends the destroy job to the project's box", async () => {
        const { box, calls } = fakeBox(['{"type":"result"}\n']);

        await driverFor(box, { dispatchNamespace: "lunora-preview" }).destroy({ alias: "app" });

        expect(calls).toStrictEqual([{ job: { action: "destroy", alias: "app", dispatchNamespace: "lunora-preview" }, name: "app" }]);
    });
});
