import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The build box's HTTP contract (GAPS.md A3).
 *
 * Covers the half that needs nothing but Node: the exec protocol
 * `@lunora/container` will call, the routing, and the guards that fire before a
 * package manager is ever invoked. The install-and-build half needs a registry
 * and a container runtime, so it is a documented smoke test in
 * `containers/build/README.md` rather than a unit test that would need the
 * network to pass.
 *
 * The distinction the exec contract draws — a command that RAN and failed
 * returns a `code`, a command that could not be run throws — is the one thing
 * here a caller's error handling depends on, so both directions are pinned.
 */

const SERVER = fileURLToPath(new URL("../containers/build/server.mjs", import.meta.url));

let child: ReturnType<typeof spawn>;
let origin: string;

const post = async (path: string, body: unknown): Promise<{ json: () => Promise<unknown>; status: number }> => {
    const response = await fetch(`${origin}${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

    return { json: () => response.json(), status: response.status };
};

describe("build box", () => {
    beforeAll(async () => {
        // `PORT=0` so a busy port on a developer's machine cannot fail the
        // suite; the server reports which one it got on stdout.
        child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });

        for await (const chunk of child.stdout ?? []) {
            const port = /listening on (\d+)/u.exec(String(chunk))?.[1];

            if (port !== undefined) {
                origin = `http://127.0.0.1:${port}`;
                break;
            }
        }
    }, 20_000);

    afterAll(async () => {
        child.kill("SIGKILL");
        await once(child, "close");
    });

    it("answers the health probe", async () => {
        expect.assertions(1);

        const response = await fetch(`${origin}/__lunora/health`);

        expect(response.status).toBe(200);
    });

    it("returns a non-zero exit code as a RESULT, not an error", async () => {
        expect.assertions(2);

        const { json, status } = await post("/__lunora/exec", { args: ["-e", "console.log('out');process.exit(7)"], command: "node" });

        expect(status).toBe(200);
        await expect(json()).resolves.toStrictEqual({ code: 7, stderr: "", stdout: "out\n" });
    });

    it("throws — not a code — when the command could not be run at all", async () => {
        expect.assertions(1);

        // The contract's one hard line: "ran and failed" must never be
        // indistinguishable from "could not run", or a caller retries a
        // genuine build failure forever.
        const { status } = await post("/__lunora/exec", { command: "definitely-not-a-real-binary" });

        expect(status).toBe(500);
    });

    it("rejects an exec with no command", async () => {
        expect.assertions(1);

        const { status } = await post("/__lunora/exec", { args: ["x"] });

        expect(status).toBe(400);
    });

    it("400s a malformed exec body without quoting it back", async () => {
        expect.assertions(2);

        const response = await fetch(`${origin}/__lunora/exec`, { body: "{not json", method: "POST" });

        expect(response.status).toBe(400);
        // The parser's own message quotes the input; it must not travel.
        await expect(response.text()).resolves.not.toMatch(/not json/u);
    });

    it.each(["/constructor", "/toString", "/__proto__", "/valueOf"])("cannot be routed to %s", async (path) => {
        expect.assertions(2);

        // The shape CodeQL flagged twice: a route table indexed by a
        // user-controlled key. There is no table any more — three explicit
        // branches — so none of these can resolve to anything callable.
        const response = await fetch(`${origin}${path}`, { method: "POST" });

        expect(response.status).toBe(404);
        // And the path is not reflected back into the body.
        await expect(response.text()).resolves.toBe(JSON.stringify({ error: "no such route" }));
    });

    it("404s an unknown route rather than treating it as a build", async () => {
        expect.assertions(1);

        const response = await fetch(`${origin}/exec`, { method: "POST" });

        expect(response.status).toBe(404);
    });

    it("refuses a source tree with no lockfile", async () => {
        expect.assertions(1);

        // An empty tarball: extraction succeeds and finds no lockfile, which is
        // the guard that runs before any package manager is invoked.
        const empty = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        const response = await fetch(`${origin}/__lunora/build`, { body: empty, method: "POST" });
        const text = await response.text();
        const lines = text.trim().split("\n");
        const last = JSON.parse(lines.at(-1) ?? "{}") as { error?: string };

        expect(last.error).toMatch(/no lockfile found|tar failed/u);
    });
});
