import type { DeployJob } from "@lunora/hostd/protocol";
import { describe, expect, it, vi } from "vitest";

import { randomBase64Url } from "../src/boxes/encoding";
import { JobRegistry, MAX_JOBS_IN_FLIGHT } from "../src/boxes/jobs";
import type { SessionAttachment, SessionEffect, SessionPorts } from "../src/boxes/session";
import { FRAME_BUCKET, HANDSHAKE_TIMEOUT_MS, livenessOf, openSession, receiveFrame, SILENCE_LIMIT_MS } from "../src/boxes/session";
import { boxSession } from "../src/boxes/session-client";
import { TICK_MS } from "../src/boxes/session-do";
import type { BoxKey } from "./support/box-session-fakes";
import { authFrame, boxKey, boxRow, fakeSocket, fakeState, handshake, helloFrame, namespaceOver, TestBoxSession } from "./support/box-session-fakes";
import { memoryStore } from "./support/memory-store";

const NOW = 1_700_000_000_000;
const NONCE = randomBase64Url();

const portsFor = (key: BoxKey, box: Partial<{ revoked: boolean }> = {}): SessionPorts => {
    return {
        loadBox: (boxId) => Promise.resolve(boxId === "box_1" ? { publicKey: key.publicKey, revoked: box.revoked ?? false } : null),
        nonce: () => NONCE,
    };
};

/** The effects of one frame on `attachment`. */
const effectsOf = async (attachment: SessionAttachment, frame: string, ports: SessionPorts, now = NOW): Promise<SessionEffect[]> => {
    const outcome = await receiveFrame(attachment, frame, now, ports);

    return outcome.effects;
};

/** A socket for box_1 that has sent `hello` and holds the challenge NONCE. */
const challenged = async (key: BoxKey): Promise<SessionAttachment> => {
    const outcome = await receiveFrame(openSession("box_1", NOW), helloFrame("box_1"), NOW, portsFor(key));

    return outcome.attachment;
};

describe("the box handshake", () => {
    it("challenges a hello for this socket's box and authenticates a signature over the nonce", async () => {
        const key = await boxKey();
        const hello = await receiveFrame(openSession("box_1", NOW), helloFrame("box_1"), NOW, portsFor(key));

        expect(hello.effects).toStrictEqual([
            { fleets: [], kind: "hello", nonce: NONCE },
            { kind: "send", message: { nonce: NONCE, type: "challenge" } },
        ]);
        expect(hello.attachment.phase).toBe("awaiting-auth");

        const auth = await receiveFrame(hello.attachment, await authFrame(key, "box_1", NONCE), NOW + 1, portsFor(key));

        expect(auth.effects).toStrictEqual([
            {
                hello: { resources: { diskFreeMb: 40_960, memMb: 3891 }, versions: { caddy: "v2.11.6", celld: "v0.6.0", hostd: "1.0.0" } },
                kind: "authenticated",
                nonce: NONCE,
            },
        ]);
        expect(auth.attachment).toMatchObject({ phase: "ready", seenAt: NOW + 1 });
        expect(auth.attachment).not.toHaveProperty("nonce");
        expect(auth.attachment).not.toHaveProperty("hello");
    });

    it("holds a hello's fleets outside the attachment between hello and auth", async () => {
        const key = await boxKey();
        const fleets = Array.from({ length: 500 }, (_, index) => {
            return { alias: `web-${String(index)}`, deploymentId: "d".repeat(128), state: "running" as const };
        });
        const hello = await receiveFrame(openSession("box_1", NOW), helloFrame("box_1", { fleets }), NOW, portsFor(key));

        expect(hello.effects[0]).toStrictEqual({ fleets, kind: "hello", nonce: NONCE });
        expect(new TextEncoder().encode(JSON.stringify(hello.attachment)).length).toBeLessThan(1024);
    });

    it("refuses a signature by another key", async () => {
        const key = await boxKey();
        const intruder = await boxKey();

        await expect(effectsOf(await challenged(key), await authFrame(intruder, "box_1", NONCE), portsFor(key))).resolves.toStrictEqual([
            { close: true, code: "AUTH_FAILED", message: expect.stringContaining("does not verify") as string },
        ]);
    });

    it("never accepts a signature for an earlier nonce — each socket gets its own", async () => {
        const key = await boxKey();
        const replayed = await authFrame(key, "box_1", NONCE);
        const second = await receiveFrame(openSession("box_1", NOW), helloFrame("box_1"), NOW, { ...portsFor(key), nonce: () => randomBase64Url() });

        await expect(effectsOf(second.attachment, replayed, portsFor(key))).resolves.toMatchObject([{ close: true, code: "AUTH_FAILED" }]);
    });

    it("answers a hello for another box like an unknown one", async () => {
        const key = await boxKey();

        await expect(effectsOf(openSession("box_1", NOW), helloFrame("box_2"), portsFor(key))).resolves.toMatchObject([
            { close: true, code: "AUTH_FAILED", message: "unknown box" },
        ]);
    });

    it("refuses a revoked box at hello, and one revoked between hello and auth", async () => {
        const key = await boxKey();

        await expect(effectsOf(openSession("box_1", NOW), helloFrame("box_1"), portsFor(key, { revoked: true }))).resolves.toMatchObject([
            { close: true, code: "BOX_REVOKED" },
        ]);
        await expect(effectsOf(await challenged(key), await authFrame(key, "box_1", NONCE), portsFor(key, { revoked: true }))).resolves.toMatchObject([
            { close: true, code: "BOX_REVOKED" },
        ]);
    });

    it("tells a box on a newer protocol to wait — before strictly validating its hello", async () => {
        const key = await boxKey();

        await expect(
            effectsOf(openSession("box_1", NOW), helloFrame("box_1", { capabilities: ["future"], protocol: 2 }), portsFor(key)),
        ).resolves.toMatchObject([{ close: true, code: "PROTOCOL_UNSUPPORTED", message: expect.stringContaining("newer") as string }]);
    });

    it.each([
        ["a frame before hello", JSON.stringify({ type: "pong" })],
        ["invalid JSON", "{not json"],
        ["an unknown field", helloFrame("box_1", { extra: true })],
        ["an oversized frame", "x".repeat(300_000)],
    ])("refuses %s", async (_name, frame) => {
        const key = await boxKey();

        await expect(effectsOf(openSession("box_1", NOW), frame, portsFor(key))).resolves.toMatchObject([{ close: true, code: "BAD_MESSAGE" }]);
    });

    it("refuses a second hello or auth once authenticated", async () => {
        const key = await boxKey();
        const { attachment } = await receiveFrame(await challenged(key), await authFrame(key, "box_1", NONCE), NOW, portsFor(key));

        await expect(effectsOf(attachment, helloFrame("box_1"), portsFor(key))).resolves.toMatchObject([{ close: true, code: "BAD_MESSAGE" }]);
        await expect(effectsOf(attachment, await authFrame(key, "box_1", NONCE), portsFor(key))).resolves.toMatchObject([{ close: true, code: "BAD_MESSAGE" }]);
    });

    it("rate-limits a flood, and the bucket refills", async () => {
        const key = await boxKey();
        const pong = JSON.stringify({ type: "pong" });
        let attachment: SessionAttachment = { ...openSession("box_1", NOW), phase: "ready" };

        for (let index = 0; index < FRAME_BUCKET.capacity; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- one frame at a time, as a socket delivers them
            const outcome = await receiveFrame(attachment, pong, NOW, portsFor(key));

            expect(outcome.effects).toStrictEqual([{ kind: "pong" }]);

            attachment = outcome.attachment;
        }

        await expect(effectsOf(attachment, pong, portsFor(key))).resolves.toMatchObject([{ close: true, code: "RATE_LIMITED" }]);
        await expect(effectsOf(attachment, pong, portsFor(key), NOW + 1000)).resolves.toStrictEqual([{ kind: "pong" }]);
    });

    it("decides liveness: stalled handshakes and silent boxes close, live ones are pinged", () => {
        const handshaking = openSession("box_1", NOW);
        const ready = { ...openSession("box_1", NOW), phase: "ready" as const };

        expect(livenessOf(handshaking, NOW + HANDSHAKE_TIMEOUT_MS)).toBe("wait");
        expect(livenessOf(handshaking, NOW + HANDSHAKE_TIMEOUT_MS + 1)).toBe("close-handshake");
        expect(livenessOf(ready, NOW + SILENCE_LIMIT_MS)).toBe("ping");
        expect(livenessOf(ready, NOW + SILENCE_LIMIT_MS + 1)).toBe("close-silent");
    });
});

describe("job correlation", () => {
    it("routes progress and the result by jobId, and drops frames for jobs that are not pending", async () => {
        const jobs = new JobRegistry();
        const lines: string[] = [];
        const outcome = jobs.start("job_a", { onProgress: (line) => lines.push(line), timeoutMs: 60_000 });

        jobs.progress({ jobId: "job_b", line: "not mine", type: "progress" });
        jobs.progress({ jobId: "job_a", line: "fetching release", type: "progress" });
        jobs.result({ jobId: "job_b", ok: true, type: "result" });
        jobs.result({ jobId: "job_a", ok: true, type: "result", url: "https://app.bslug.boxes.lunora.app" });
        jobs.result({ error: { code: "LATE", message: "a second result" }, jobId: "job_a", ok: false, type: "result" });

        await expect(outcome).resolves.toStrictEqual({ ok: true, url: "https://app.bslug.boxes.lunora.app" });
        expect(lines).toStrictEqual(["fetching release"]);
        expect(jobs.size).toBe(0);
    });

    it("times a job out, and fails every pending job when the box goes", async () => {
        vi.useFakeTimers();

        try {
            const jobs = new JobRegistry();
            const slow = jobs.start("job_slow", { onProgress: () => undefined, timeoutMs: 1000 });
            const orphan = jobs.start("job_orphan", { onProgress: () => undefined, timeoutMs: 60_000 });

            vi.advanceTimersByTime(1001);
            jobs.failAll("BOX_OFFLINE", "gone");

            await expect(slow).resolves.toMatchObject({ error: { code: "JOB_TIMEOUT" }, ok: false });
            await expect(orphan).resolves.toStrictEqual({ error: { code: "BOX_OFFLINE", message: "gone" }, ok: false });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("job ownership", () => {
    it("fails only the jobs sent on a socket that went away", async () => {
        const jobs = new JobRegistry();
        const old = {};
        const current = {};
        const stranded = jobs.start("job_old", { onProgress: () => undefined, owner: old, timeoutMs: 60_000 });
        const live = jobs.start("job_new", { onProgress: () => undefined, owner: current, timeoutMs: 60_000 });

        jobs.failOwner(old, "SUPERSEDED", "reconnected");

        await expect(stranded).resolves.toStrictEqual({ error: { code: "SUPERSEDED", message: "reconnected" }, ok: false });
        expect(jobs.size).toBe(1);

        jobs.result({ jobId: "job_new", ok: true, type: "result" });

        await expect(live).resolves.toStrictEqual({ ok: true });
    });

    it("keeps fire-and-forget jobs out of the in-flight count", () => {
        const jobs = new JobRegistry();

        for (let index = 0; index < MAX_JOBS_IN_FLIGHT; index += 1) {
            jobs.start(`upgrade_${String(index)}`, { counted: false, onProgress: () => undefined, timeoutMs: 60_000 }).catch(() => undefined);
        }

        jobs.start("deploy", { onProgress: () => undefined, timeoutMs: 60_000 }).catch(() => undefined);

        expect(jobs.size).toBe(1);

        jobs.failAll("BOX_OFFLINE", "test cleanup");
    });
});

describe("boxSessionDO", () => {
    const setup = async (row: Record<string, unknown> = {}) => {
        const key = await boxKey();
        const store = memoryStore({ boxes: [boxRow(key, row)], deployments: [], domains: [], projects: [] });
        const state = fakeState();
        const session = new TestBoxSession(state, store, { LUNORA_BOX_DOMAIN: "boxes.test" });

        await state.storage.put("boxId", "box_1");

        return { key, session, state, store };
    };

    it("records an authenticated box online with what it reported, and pushes its routing table", async () => {
        const { key, session, state, store } = await setup();

        store.tables["projects"] = [{ _id: "proj_1", activeScriptName: "web", boxId: "box_1", organizationId: "org_1" }];
        store.tables["deployments"] = [
            { _id: "dep_1", alias: "web", projectId: "proj_1", status: "live" },
            { _id: "dep_2", alias: "web-pr-7", projectId: "proj_1", status: "verifying" },
            { _id: "dep_3", alias: "web-pr-6", projectId: "proj_1", status: "destroyed" },
        ];
        store.tables["domains"] = [{ _id: "dom_1", hostname: "www.example.com", projectId: "proj_1", verifiedAt: 1 }];

        const socket = await handshake(session, state, key, "box_1");

        expect(store.tables["boxes"]?.[0]).toMatchObject({ resources: { diskFreeMb: 40_960, memMb: 3891 }, status: "online", versions: { celld: "v0.6.0" } });
        expect(socket.received().at(-1)).toStrictEqual({
            table: [
                { alias: "web-pr-7", hostname: "web-pr-7.bslug000001.boxes.test" },
                { alias: "web", hostname: "web.bslug000001.boxes.test" },
                { alias: "web", hostname: "www.example.com" },
            ],
            type: "routes",
        });
    });

    it("records the fleets a box reports in hello, one per alias, sorted", async () => {
        const { key, session, state, store } = await setup();

        await handshake(session, state, key, "box_1", {
            hello: {
                fleets: [
                    { alias: "web", deploymentId: "dep_2", state: "running" },
                    { alias: "api", state: "stopped" },
                ],
            },
        });

        expect(store.tables["boxes"]?.[0]?.["fleets"]).toStrictEqual([
            { alias: "api", state: "stopped" },
            { alias: "web", deploymentId: "dep_2", state: "running" },
        ]);
    });

    it("keeps a full fleet list out of the socket attachment, which workerd caps at 16 KiB, and still records it", async () => {
        const { key, session, state, store } = await setup();
        // The protocol's maximum: 500 fleets, each with a 63-character alias and a 128-character deployment id.
        const fleets = Array.from({ length: 500 }, (_, index) => {
            return { alias: `${"a".repeat(59)}${String(index).padStart(4, "0")}`, deploymentId: "d".repeat(128), state: "running" };
        });
        const socket = await handshake(session, state, key, "box_1", { hello: { fleets } });

        expect(new TextEncoder().encode(JSON.stringify(socket.attachment)).length).toBeLessThan(1024);
        expect(store.tables["boxes"]?.[0]?.["fleets"]).toHaveLength(500);
    });

    it("moves the stored fleets on as deploy and destroy jobs succeed, and leaves them on a failure", async () => {
        const { key, session, state, store } = await setup();
        const socket = await handshake(session, state, key, "box_1", { hello: { fleets: [{ alias: "old", deploymentId: "dep_0", state: "running" }] } });
        const client = boxSession(namespaceOver(session), "box_1");
        let answered = 0;
        const answer = async (ok: boolean): Promise<void> => {
            await vi.waitFor(() => {
                expect(socket.received().filter((frame) => frame.type === "job").length).toBeGreaterThan(answered);
            });

            const job = socket.received().filter((frame) => frame.type === "job")[answered];

            answered += 1;
            await session.webSocketMessage(
                socket,
                JSON.stringify(
                    ok
                        ? { jobId: job?.type === "job" ? job.jobId : "", ok: true, type: "result" }
                        : { error: { code: "DEPLOY_FAILED", message: "no" }, jobId: job?.type === "job" ? job.jobId : "", ok: false, type: "result" },
                ),
            );
        };
        const deploy = (deploymentId: string): DeployJob => {
            return { alias: "web", crons: [], deploymentId, kind: "deploy", releaseUrl: "https://cloud.test/v1/boxes/releases/x", vars: {} };
        };

        const first = client.dispatch(deploy("dep_1"));

        await answer(true);

        await expect(first).resolves.toStrictEqual({ ok: true });

        expect(store.tables["boxes"]?.[0]?.["fleets"]).toStrictEqual([
            { alias: "old", deploymentId: "dep_0", state: "running" },
            { alias: "web", deploymentId: "dep_1", state: "running" },
        ]);

        const failed = client.dispatch(deploy("dep_2"));

        await answer(false);

        await expect(failed).resolves.toMatchObject({ ok: false });

        expect(store.tables["boxes"]?.[0]?.["fleets"]).toContainEqual({ alias: "web", deploymentId: "dep_1", state: "running" });

        const destroyed = client.dispatch({ alias: "old", deleteData: false, kind: "destroy" });

        await answer(true);

        await expect(destroyed).resolves.toStrictEqual({ ok: true });

        expect(store.tables["boxes"]?.[0]?.["fleets"]).toStrictEqual([{ alias: "web", deploymentId: "dep_1", state: "running" }]);
    });

    it("refuses a wrong signature with one error frame and a close, and leaves the box as it was", async () => {
        const { session, state, store } = await setup();
        const intruder = await boxKey();
        const socket = fakeSocket(openSession("box_1", Date.now()));

        state.acceptWebSocket(socket);
        await session.webSocketMessage(socket, helloFrame("box_1"));

        const challenge = socket.received()[0];

        await session.webSocketMessage(socket, await authFrame(intruder, "box_1", challenge?.type === "challenge" ? challenge.nonce : ""));

        expect(socket.received().at(-1)).toMatchObject({ code: "AUTH_FAILED", type: "error" });
        expect(socket.closedWith).toStrictEqual({ code: 1008, reason: "AUTH_FAILED" });
        expect(store.tables["boxes"]?.[0]).toMatchObject({ status: "pending" });
    });

    it("fails a dispatch fast when the box is not connected (BOX_OFFLINE)", async () => {
        const { session } = await setup();

        await expect(boxSession(namespaceOver(session), "box_1").dispatch({ kind: "diagnose" })).resolves.toStrictEqual({
            error: { code: "BOX_OFFLINE", message: "the box is not connected" },
            ok: false,
        });
    });

    it("dispatches a job, streams its progress, and resolves with the box's result", async () => {
        const { key, session, state } = await setup();
        const socket = await handshake(session, state, key, "box_1");
        const lines: string[] = [];
        const running = boxSession(namespaceOver(session), "box_1").dispatch(
            { alias: "web", deleteData: true, kind: "destroy" },
            {
                onProgress: (line) => {
                    lines.push(line);
                },
            },
        );

        await vi.waitFor(() => {
            expect(socket.received().some((frame) => frame.type === "job")).toBe(true);
        });

        const job = socket.received().find((frame) => frame.type === "job");
        const jobId = job?.type === "job" ? job.jobId : "";

        expect(job).toMatchObject({ job: { alias: "web", deleteData: true, kind: "destroy" }, type: "job" });

        await session.webSocketMessage(socket, JSON.stringify({ jobId, line: "stopping fleet", type: "progress" }));
        await session.webSocketMessage(socket, JSON.stringify({ jobId: "someone-elses", line: "ignored", type: "progress" }));
        await session.webSocketMessage(socket, JSON.stringify({ jobId, ok: true, type: "result" }));

        await expect(running).resolves.toStrictEqual({ ok: true });
        expect(lines).toStrictEqual(["stopping fleet"]);
    });

    it("refuses a job the protocol would reject before sending anything", async () => {
        const { key, session, state } = await setup();
        const socket = await handshake(session, state, key, "box_1");
        const sentBefore = socket.sent.length;

        await expect(boxSession(namespaceOver(session), "box_1").dispatch({ alias: "Not An Alias", kind: "reload" })).resolves.toMatchObject({
            error: { code: "BAD_JOB" },
            ok: false,
        });
        expect(socket.sent).toHaveLength(sentBefore);
    });

    it("fails the jobs of a superseded socket at once, instead of at their timeout", async () => {
        const { key, session, state } = await setup();
        const first = await handshake(session, state, key, "box_1");
        const running = boxSession(namespaceOver(session), "box_1").dispatch({ kind: "diagnose" });

        await vi.waitFor(() => {
            expect(first.received().some((frame) => frame.type === "job")).toBe(true);
        });

        // The box reconnects: its new socket authenticates and supersedes the first.
        const second = await handshake(session, state, key, "box_1");

        await expect(running).resolves.toMatchObject({ error: { code: "SUPERSEDED" }, ok: false });
        expect(first.closedWith).toMatchObject({ reason: "SUPERSEDED" });
        expect(second.closedWith).toBeUndefined();
    });

    it("closes every socket on revoke and fails the jobs in flight", async () => {
        const { key, session, state } = await setup();
        const socket = await handshake(session, state, key, "box_1");
        const client = boxSession(namespaceOver(session), "box_1");
        const running = client.dispatch({ kind: "diagnose" });

        await vi.waitFor(() => {
            expect(socket.received().some((frame) => frame.type === "job")).toBe(true);
        });
        await client.close("BOX_REVOKED", "revoked");

        await expect(running).resolves.toMatchObject({ error: { code: "BOX_REVOKED" }, ok: false });
        expect(socket.received().at(-1)).toStrictEqual({ code: "BOX_REVOKED", message: "revoked", type: "error" });
        expect(socket.closedWith?.reason).toBe("BOX_REVOKED");
    });

    it("pings a live box, and marks a silent one offline on the liveness tick", async () => {
        const { key, session, state, store } = await setup();
        const socket = await handshake(session, state, key, "box_1");

        await session.alarm();

        expect(socket.received().at(-1)).toStrictEqual({ type: "ping" });
        expect(state.alarmAt).toBeGreaterThan(Date.now() + TICK_MS - 1000);

        socket.attachment = { ...socket.attachment, seenAt: Date.now() - SILENCE_LIMIT_MS - 1 };
        await session.alarm();

        expect(socket.received().at(-1)).toMatchObject({ code: "TIMEOUT", type: "error" });
        expect(store.tables["boxes"]?.[0]).toMatchObject({ status: "offline" });
    });

    it("cuts a box off on the next tick once its row is revoked, wherever the revoke came from", async () => {
        const { key, session, state, store } = await setup();
        const socket = await handshake(session, state, key, "box_1");

        await store.patch("box_1", { revokedAt: 1, status: "revoked" });
        await session.alarm();

        expect(socket.received().at(-1)).toMatchObject({ code: "BOX_REVOKED", type: "error" });
        expect(store.tables["boxes"]?.[0]).toMatchObject({ status: "revoked" });
    });

    it("cuts a box off on the next tick once its row is gone — its organization was purged", async () => {
        const { key, session, state, store } = await setup();
        const socket = await handshake(session, state, key, "box_1");

        await store.delete("box_1", "boxes");
        await session.alarm();

        expect(socket.received().at(-1)).toMatchObject({ code: "BOX_REVOKED", type: "error" });
        expect(socket.closedWith?.reason).toBe("BOX_REVOKED");
    });

    it("claims a request nonce once and refuses its replay", async () => {
        const { session } = await setup();
        const client = boxSession(namespaceOver(session), "box_1");
        const expiresAt = Date.now() + 60_000;

        const nonce = randomBase64Url();

        await expect(client.claimNonce(nonce, expiresAt)).resolves.toBe(true);
        await expect(client.claimNonce(nonce, expiresAt)).resolves.toBe(false);
        await expect(client.claimNonce(randomBase64Url(), expiresAt)).resolves.toBe(true);
        // A nonce of the wrong shape is never claimed: the signed request it came with is refused.
        await expect(client.claimNonce("short", expiresAt)).resolves.toBe(false);
    });

    it("accepts only a WebSocket upgrade of a box id over fetch — the rest is RPC", async () => {
        const { session } = await setup();

        await expect(session.fetch(new Request("https://box-session.internal/connect?box=../x", { headers: { upgrade: "websocket" } }))).resolves.toMatchObject(
            {
                status: 400,
            },
        );
        await expect(session.fetch(new Request("https://box-session.internal/dispatch?box=box_1", { method: "POST" }))).resolves.toMatchObject({ status: 426 });
    });
});
