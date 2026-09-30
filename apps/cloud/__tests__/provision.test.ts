import { describe, expect, it, vi } from "vitest";

import { sha256HexBytes } from "../src/deploy/keys";
import type { AlchemyProvisionerOptions } from "../src/provision";
import { createAlchemyProvisioner } from "../src/provision";
import type { ProvisionJob, TenantDeploymentSpec } from "../src/provision-contract";

const spec: TenantDeploymentSpec = {
    alias: "org__project",
    bundle: new TextEncoder().encode("export default {}").buffer,
    cell: "cell-1",
    dispatchNamespace: "lunora-production",
    manifest: { bindings: [{ binding: "DB", type: "d1" }] },
    scriptName: "org__project-v1",
    secrets: { LUNORA_ADMIN_TOKEN: "t" },
    tags: ["org:org", "project:project", "env:production"],
};

/** A fake provision box: records each instance name + job, answers these chunks (split wherever the test says). */
const fakeBox = (chunks: ReadonlyArray<string>, status = 200): { box: AlchemyProvisionerOptions["box"]; calls: { job: ProvisionJob; name: string }[] } => {
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

const urlForScript = (script: string): string => `https://${script}.lunora.app`;

describe(createAlchemyProvisioner, () => {
    it("posts the deploy job to the project's box, forwards logs, and resolves the result", async () => {
        // The result line arrives split across two reads, with no trailing newline.
        const { box, calls } = fakeBox([
            '{"type":"log","line":"creating d1"}\n{"type":"log","line":"up',
            'loading"}\n{"type":"res',
            'ult","url":"https://x.workers.dev"}',
        ]);
        const onLog = vi.fn<(line: string) => void>();

        const result = await createAlchemyProvisioner({ box, onLog, urlForScript }).deploy(spec);

        expect(result).toStrictEqual({
            bundleHash: await sha256HexBytes(spec.bundle),
            scriptName: "org__project-v1",
            url: "https://org__project-v1.lunora.app",
        });
        expect(onLog.mock.calls).toStrictEqual([["creating d1"], ["uploading"]]);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.name).toBe("org__project");

        const job = calls[0]?.job;

        expect(job?.action).toBe("deploy");
        expect(job?.action === "deploy" && atob(job.spec.bundle)).toBe("export default {}");
    });

    it("throws the box's error message", async () => {
        const { box } = fakeBox(['{"type":"log","line":"x"}\n{"type":"error","message":"d1 quota exceeded"}\n']);

        await expect(createAlchemyProvisioner({ box, urlForScript }).deploy(spec)).rejects.toThrow("d1 quota exceeded");
    });

    it("throws when the stream ends without a result", async () => {
        const { box } = fakeBox(['{"type":"log","line":"x"}\n']);

        await expect(createAlchemyProvisioner({ box, urlForScript }).deploy(spec)).rejects.toThrow(/without a result/u);
    });

    it("surfaces a 409 as a retryable busy error", async () => {
        const { box } = fakeBox([], 409);

        await expect(createAlchemyProvisioner({ box, urlForScript }).deploy(spec)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    });

    it("sends the destroy job, carrying deleteResources as deleteProjectResources", async () => {
        const { box, calls } = fakeBox(['{"type":"result"}\n']);

        await createAlchemyProvisioner({ box, urlForScript }).destroy({
            alias: "app",
            deleteResources: true,
            dispatchNamespace: "lunora-preview",
            scriptName: "app-v2",
        });

        expect(calls).toStrictEqual([
            { job: { action: "destroy", alias: "app", deleteProjectResources: true, dispatchNamespace: "lunora-preview", scriptName: "app-v2" }, name: "app" },
        ]);
    });
});
