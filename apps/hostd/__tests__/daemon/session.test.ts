import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BoxIdentity } from "../../src/daemon/identity";
import { generateIdentity } from "../../src/daemon/identity";
import { silentLogger } from "../../src/daemon/log";
import { connectUrlOf, reconnectDelay, Session } from "../../src/daemon/session";
import type { HelloMessage, JobMessage, RouteEntry } from "../../src/wire/types";
import type { TestBox } from "./helpers/box";
import { createTestBox } from "./helpers/box";
import { FakeControlPlane } from "./helpers/fake-control-plane";

describe(reconnectDelay, () => {
    it("doubles from one second to a minute, jittered between half and all of it", () => {
        expect.assertions(4);

        expect(reconnectDelay(0, () => 0)).toBe(1000);
        expect(reconnectDelay(3, () => 1)).toBe(8000);
        expect(reconnectDelay(3, () => 0)).toBe(4000);
        expect(reconnectDelay(40, () => 1)).toBe(60_000);
    });
});

describe(connectUrlOf, () => {
    it("dials wss for an https control plane, with the box id", () => {
        expect.assertions(2);

        expect(connectUrlOf("https://cloud.example", "box_1")).toBe("wss://cloud.example/v1/boxes/connect?box=box_1");
        expect(connectUrlOf("http://127.0.0.1:4000", "box_1")).toBe("ws://127.0.0.1:4000/v1/boxes/connect?box=box_1");
    });
});

describe(Session, () => {
    let plane: FakeControlPlane;
    let box: TestBox;
    let session: Session;
    let routes: RouteEntry[][];
    let jobs: JobMessage[];
    let started: Promise<unknown> | undefined;

    const hello = (): HelloMessage => {
        return {
            boxId: plane.boxId,
            fleets: [],
            protocol: 1,
            resources: { diskFreeMb: 1, memMb: 1 },
            type: "hello",
            versions: { caddy: "x", celld: "y", hostd: "z" },
        };
    };

    const start = (identity: BoxIdentity = box.identity): Promise<Awaited<ReturnType<Session["run"]>>> => {
        session = new Session({
            boxId: plane.boxId,
            controlPlane: plane.origin,
            hello,
            identity,
            logger: silentLogger,
            onJob: (message) => {
                jobs.push(message);
            },
            onRoutes: (table) => {
                routes.push(table);
            },
            random: () => 0,
        });

        return session.run();
    };

    beforeEach(async () => {
        plane = new FakeControlPlane();
        await plane.listen();
        box = await createTestBox(plane);
        routes = [];
        jobs = [];
    });

    afterEach(async () => {
        session.stop();
        await started;
        started = undefined;
        await plane.close();
        box.cleanup();
    });

    it("says hello, answers the challenge, and takes the routing table", async () => {
        expect.assertions(3);

        plane.routes = [{ alias: "a", hostname: "a.example.com" }];

        const ended = start();

        await plane.authenticated();

        await expect.poll(() => routes).toStrictEqual([[{ alias: "a", hostname: "a.example.com" }]]);

        expect(session.ready).toBe(true);

        session.stop();

        await expect(ended).resolves.toStrictEqual({ code: "STOPPED" });
    });

    it("hands jobs over once authenticated", async () => {
        expect.assertions(1);

        started = start();
        await plane.authenticated();
        plane.send({ job: { kind: "diagnose" }, jobId: "job_9", type: "job" });

        await expect.poll(() => jobs).toStrictEqual([{ job: { kind: "diagnose" }, jobId: "job_9", type: "job" }]);
    });

    it("stops for good, without reconnecting, when the box is revoked", async () => {
        expect.assertions(2);

        const ended = start();

        await plane.authenticated();
        plane.refuse("BOX_REVOKED", "this box has been revoked");

        await expect(ended).resolves.toStrictEqual({ code: "BOX_REVOKED", message: "this box has been revoked" });
        expect(plane.connections).toBe(1);
    });

    it("stops when revoked at hello, too", async () => {
        expect.assertions(1);

        plane.refuseNext = { code: "BOX_REVOKED", message: "revoked" };

        await expect(start()).resolves.toMatchObject({ code: "BOX_REVOKED" });
    });

    it("reconnects after a lost connection and authenticates again", async () => {
        expect.assertions(2);

        started = start();
        await plane.authenticated();
        plane.refuse("TIMEOUT", "no frame from this box for 90 seconds");
        await plane.authenticated(2);

        expect(plane.connections).toBe(2);
        await expect.poll(() => session.ready).toBe(true);
    });

    it("backs off and reconnects when superseded", async () => {
        expect.assertions(1);

        started = start();
        await plane.authenticated();

        const before = Date.now();

        plane.refuse("SUPERSEDED", "a newer session for this box authenticated");
        await plane.authenticated(2);

        expect(Date.now() - before).toBeGreaterThanOrEqual(900);
    });

    it("keeps retrying, never authenticating, with a key the control plane does not know", async () => {
        expect.assertions(2);

        const stranger = generateIdentity(`${box.root}/etc/stranger.key`);

        plane.publicKey = box.identity.publicKey;
        started = start(stranger);

        await expect.poll(() => plane.connections, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
        expect(plane.authentications).toBe(0);
    });

    it("drops a frame it cannot decode by reconnecting", async () => {
        expect.assertions(1);

        started = start();
        await plane.authenticated();
        // A job of an unknown kind is invalid for this protocol version.
        (plane as unknown as { socket: { send: (data: string) => void } }).socket.send(
            JSON.stringify({ job: { kind: "format-disk" }, jobId: "j", type: "job" }),
        );

        await plane.authenticated(2);

        expect(jobs).toStrictEqual([]);
    });

    it("refuses to send before it is authenticated", () => {
        expect.assertions(1);

        started = start();

        expect(session.send({ type: "pong" })).toBe(false);
    });
});
