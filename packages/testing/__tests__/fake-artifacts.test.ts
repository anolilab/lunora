import { createArtifacts } from "@lunora/bindings/artifacts";
import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { createArtifactsFake } from "../src/fake-artifacts";

const commit = {
    author: { email: "dev@example.test", name: "Dev" },
    authoredAt: 1_790_000_000,
    committedAt: 1_790_000_000,
    committer: { email: "dev@example.test", name: "Dev" },
    hash: "a".repeat(40),
    message: "initial",
    parents: [],
    treeHash: "b".repeat(40),
};

describe(createArtifactsFake, () => {
    it("creates, lists, reads metadata and deletes repos through createArtifacts", async () => {
        expect.assertions(5);

        const fake = createArtifactsFake({ namespace: "default" });
        const artifacts = createArtifacts({ binding: fake.binding });

        const created = await artifacts.create("docs", { description: "Docs", setDefaultBranch: "trunk" });

        expect(created).toMatchObject({ defaultBranch: "trunk", name: "docs", remote: "https://artifacts.fake.test/default/docs.git" });
        await expect(artifacts.info("docs")).resolves.toMatchObject({ description: "Docs", name: "docs", readOnly: false });
        await expect(artifacts.list()).resolves.toMatchObject({ repos: [{ name: "docs" }], total: 1 });
        await expect(artifacts.delete("docs")).resolves.toBe(true);

        expect(fake.repoNames()).toStrictEqual([]);
    });

    it("returns the staged Blob instance from readFile, unbuffered", async () => {
        expect.assertions(3);

        const fake = createArtifactsFake();
        const artifacts = createArtifacts({ binding: fake.binding });

        await artifacts.create("docs");

        const staged = fake.putFile("docs", { content: "# hello", path: "README.md", ref: "main" });
        const file = await artifacts.withRepo("docs", async (repo) => repo.readFile({ path: "README.md", ref: "main" }));
        const missing = await artifacts.withRepo("docs", async (repo) => repo.readFile({ path: "nope.md", ref: "main" }));

        expect(file).toBe(staged);
        expect(missing).toBeNull();
        expect(fake.handles).toStrictEqual({ disposed: 2, opened: 2 });
    });

    it("serves seeded history, commits, trees and blobs", async () => {
        expect.assertions(4);

        const fake = createArtifactsFake();
        const artifacts = createArtifacts({ binding: fake.binding });

        await artifacts.create("docs");
        fake.putCommit("docs", commit);
        fake.putTree("docs", commit.treeHash, [{ hash: "c".repeat(40), mode: "100644", name: "README.md", type: "blob" }]);

        const blob = fake.putBlob("docs", "c".repeat(40), "raw");

        await artifacts.withRepo("docs", async (repo) => {
            await expect(repo.log({ ref: "main" })).resolves.toStrictEqual([commit]);
            await expect(repo.readCommit(commit.hash)).resolves.toStrictEqual(commit);
            await expect(repo.readTree(commit.treeHash)).resolves.toHaveLength(1);
            await expect(repo.readBlob("c".repeat(40))).resolves.toBe(blob);
        });
    });

    it("mints, lists and revokes tokens, and builds a remote from one", async () => {
        expect.assertions(4);

        const fake = createArtifactsFake();
        const artifacts = createArtifacts({ binding: fake.binding });
        const { remote } = await artifacts.create("docs");

        const token = await artifacts.withRepo("docs", async (repo) => repo.createToken("write", 600));

        expect(artifacts.authenticatedRemote(remote, token.plaintext)).toBe(
            `https://x:${token.plaintext.split("?")[0] ?? ""}@artifacts.fake.test/default/docs.git`,
        );

        await artifacts.withRepo("docs", async (repo) => {
            await expect(repo.revokeToken(token.id)).resolves.toBe(true);
            await expect(repo.revokeToken(token.id)).resolves.toBe(false);

            const { tokens } = await repo.listTokens();

            expect(tokens.find((entry) => entry.id === token.id)?.state).toBe("revoked");
        });
    });

    it("forks a repo with its files", async () => {
        expect.assertions(2);

        const fake = createArtifactsFake();
        const artifacts = createArtifacts({ binding: fake.binding });

        await artifacts.create("docs");

        const staged = fake.putFile("docs", { content: "x", path: "a.txt", ref: "main" });
        const forked = await artifacts.withRepo("docs", async (repo) => repo.fork("docs-copy"));

        expect(forked.name).toBe("docs-copy");
        await expect(artifacts.withRepo("docs-copy", async (repo) => repo.readFile({ path: "a.txt", ref: "main" }))).resolves.toBe(staged);
    });

    it("raises the binding's errors, which createArtifacts maps to LunoraError", async () => {
        expect.assertions(6);

        const fake = createArtifactsFake();
        const artifacts = createArtifacts({ binding: fake.binding });

        await artifacts.create("docs");

        await expect(artifacts.create("docs")).rejects.toMatchObject({ code: "CONFLICT", data: { code: "ALREADY_EXISTS", numericCode: 10_201 } });
        await expect(artifacts.create("-bad")).rejects.toMatchObject({ code: "BAD_REQUEST", data: { code: "INVALID_REPO_NAME" } });
        await expect(artifacts.info("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(artifacts.withRepo("docs", async (repo) => repo.createToken("read", 10))).rejects.toMatchObject({
            code: "BAD_REQUEST",
            data: { code: "INVALID_TTL" },
        });

        fake.failNext("UPSTREAM_UNAVAILABLE");

        const error: unknown = await artifacts.list().catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(LunoraError);
        expect(fake.handles.opened).toBe(fake.handles.disposed);
    });
});
