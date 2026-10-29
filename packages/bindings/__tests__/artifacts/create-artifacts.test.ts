import { LunoraError } from "@lunora/errors";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { createArtifacts } from "../../src/artifacts/create-artifacts";
import type { ArtifactsBindingLike, ArtifactsErrorCode, ArtifactsRepoLike } from "../../src/artifacts/types";

/** The `{ name, code, numericCode }` shape the binding's `ArtifactsError` carries across RPC. */
const artifactsError = (code: string, numericCode?: number): Error => {
    const error = new Error(`binding said ${code} for token art_secret_123`) as Error & { code: string; numericCode?: number };

    error.name = "ArtifactsError";
    error.code = code;

    if (numericCode !== undefined) {
        error.numericCode = numericCode;
    }

    return error;
};

const repoInfo = {
    createdAt: "2026-10-01T00:00:00.000Z",
    defaultBranch: "main",
    description: null,
    id: "repo1",
    lastPushAt: null,
    name: "docs",
    readOnly: false,
    remote: "https://artifacts.example.test/default/docs.git",
    source: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
};

const createFakeRepo = (overrides: Partial<ArtifactsRepoLike> = {}): { dispose: Mock<() => void>; repo: ArtifactsRepoLike } => {
    const dispose = vi.fn<() => void>();
    const repo: ArtifactsRepoLike = {
        [Symbol.dispose]: dispose,
        createToken: vi.fn<ArtifactsRepoLike["createToken"]>(async (scope = "write") => {
            return { expiresAt: "2026-10-01T01:00:00.000Z", id: "tok1", plaintext: "art_secret_123?expires=1", scope };
        }),
        fork: vi.fn<ArtifactsRepoLike["fork"]>(async (name: string) => {
            return { defaultBranch: "main", description: null, id: "repo2", name, remote: "https://artifacts.example.test/default/copy.git", token: "t" };
        }),
        info: vi.fn<ArtifactsRepoLike["info"]>(async () => repoInfo),
        listTokens: vi.fn<ArtifactsRepoLike["listTokens"]>(async () => {
            return { tokens: [], total: 0 };
        }),
        log: vi.fn<ArtifactsRepoLike["log"]>(async () => []),
        readBlob: vi.fn<ArtifactsRepoLike["readBlob"]>(async () => null),
        readCommit: vi.fn<ArtifactsRepoLike["readCommit"]>(async () => null),
        readFile: vi.fn<ArtifactsRepoLike["readFile"]>(async () => null),
        readTree: vi.fn<ArtifactsRepoLike["readTree"]>(async () => null),
        revokeToken: vi.fn<ArtifactsRepoLike["revokeToken"]>(async () => true),
        ...overrides,
    };

    return { dispose, repo };
};

const createFakeBinding = (repo: ArtifactsRepoLike, overrides: Partial<ArtifactsBindingLike> = {}): ArtifactsBindingLike => {
    return {
        create: vi.fn<ArtifactsBindingLike["create"]>(async (name: string) => {
            return { defaultBranch: "main", description: null, id: "repo1", name, remote: repoInfo.remote, token: "art_secret_123" };
        }),
        delete: vi.fn<ArtifactsBindingLike["delete"]>(async () => true),
        get: vi.fn<ArtifactsBindingLike["get"]>(async () => repo),
        import: vi.fn<ArtifactsBindingLike["import"]>(async ({ target }: { target: { name: string } }) => {
            return { defaultBranch: "main", description: null, id: "repo3", name: target.name, remote: repoInfo.remote, token: "t" };
        }),
        list: vi.fn<ArtifactsBindingLike["list"]>(async () => {
            return { repos: [], total: 0 };
        }),
        ...overrides,
    };
};

describe(createArtifacts, () => {
    it("passes namespace operations straight through", async () => {
        expect.assertions(4);

        const { repo } = createFakeRepo();
        const binding = createFakeBinding(repo);
        const artifacts = createArtifacts({ binding });

        await expect(artifacts.create("docs", { setDefaultBranch: "trunk" })).resolves.toMatchObject({ name: "docs" });
        await expect(artifacts.delete("docs")).resolves.toBe(true);
        await expect(artifacts.list({ limit: 5 })).resolves.toStrictEqual({ repos: [], total: 0 });

        expect(binding.create).toHaveBeenCalledWith("docs", { setDefaultBranch: "trunk" });
    });

    it("reads metadata through info() and disposes the handle", async () => {
        expect.assertions(2);

        const { dispose, repo } = createFakeRepo();
        const artifacts = createArtifacts({ binding: createFakeBinding(repo) });

        await expect(artifacts.info("docs")).resolves.toStrictEqual(repoInfo);

        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("disposes the repo handle when the withRepo callback throws", async () => {
        expect.assertions(2);

        const { dispose, repo } = createFakeRepo();
        const artifacts = createArtifacts({ binding: createFakeBinding(repo) });
        const failure = new Error("callback failed");

        await expect(
            artifacts.withRepo("docs", () => {
                throw failure;
            }),
        ).rejects.toBe(failure);

        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("returns the callback's value and forwards repo operations", async () => {
        expect.assertions(3);

        const { dispose, repo } = createFakeRepo();
        const artifacts = createArtifacts({ binding: createFakeBinding(repo) });

        const token = await artifacts.withRepo("docs", async (handle) => handle.createToken("read", 600));

        expect(token).toMatchObject({ id: "tok1", scope: "read" });
        expect(repo.createToken).toHaveBeenCalledWith("read", 600);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("hands readFile's Blob back as the same, unbuffered instance", async () => {
        expect.assertions(2);

        const blob = new Blob(["# hello"], { type: "text/markdown" });
        const textSpy = vi.spyOn(blob, "text");
        const { repo } = createFakeRepo({ readFile: vi.fn<ArtifactsRepoLike["readFile"]>(async () => blob) });
        const artifacts = createArtifacts({ binding: createFakeBinding(repo) });

        const file = await artifacts.withRepo("docs", async (handle) => handle.readFile({ path: "README.md", ref: "main" }));

        expect(file).toBe(blob);
        expect(textSpy).not.toHaveBeenCalled();
    });

    it("tolerates a handle without Symbol.dispose", async () => {
        expect.assertions(1);

        const { repo } = createFakeRepo();

        Reflect.deleteProperty(repo, Symbol.dispose);

        const artifacts = createArtifacts({ binding: createFakeBinding(repo) });

        await expect(artifacts.withRepo("docs", async (handle) => handle.log())).resolves.toStrictEqual([]);
    });

    it.each<[ArtifactsErrorCode, string]>([
        ["NOT_FOUND", "NOT_FOUND"],
        ["ALREADY_EXISTS", "CONFLICT"],
        ["CREATE_IN_PROGRESS", "CONFLICT"],
        ["IMPORT_IN_PROGRESS", "CONFLICT"],
        ["FORK_IN_PROGRESS", "CONFLICT"],
        ["INVALID_INPUT", "BAD_REQUEST"],
        ["INVALID_REPO_NAME", "BAD_REQUEST"],
        ["INVALID_TTL", "BAD_REQUEST"],
        ["INVALID_URL", "BAD_REQUEST"],
        ["REMOTE_AUTH_REQUIRED", "FORBIDDEN"],
        ["UPSTREAM_UNAVAILABLE", "INTERNAL"],
        ["MEMORY_LIMIT", "INTERNAL"],
        ["INTERNAL_ERROR", "INTERNAL"],
    ])("maps the binding's %s to LunoraError %s", async (bindingCode, lunoraCode) => {
        expect.assertions(5);

        const { repo } = createFakeRepo();
        const original = artifactsError(bindingCode, 10_200);
        const artifacts = createArtifacts({
            binding: createFakeBinding(repo, {
                create: vi.fn<ArtifactsBindingLike["create"]>(async () => {
                    throw original;
                }),
            }),
        });

        const error: unknown = await artifacts.create("docs").catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(LunoraError);
        expect((error as LunoraError).code).toBe(lunoraCode);
        expect((error as LunoraError).data).toStrictEqual({ code: bindingCode, numericCode: 10_200 });
        expect((error as LunoraError).cause).toBe(original);
        // The binding's message (which could echo a token) is never copied into ours.
        expect((error as LunoraError).message).not.toContain("art_secret_123");
    });

    it("maps errors thrown by repo operations, including get()", async () => {
        expect.assertions(2);

        const { repo } = createFakeRepo({
            revokeToken: vi.fn<ArtifactsRepoLike["revokeToken"]>(async () => {
                throw artifactsError("INVALID_INPUT");
            }),
        });
        const notFound = createArtifacts({
            binding: createFakeBinding(repo, {
                get: vi.fn<ArtifactsBindingLike["get"]>(async () => {
                    throw artifactsError("NOT_FOUND");
                }),
            }),
        });
        const invalid = createArtifacts({ binding: createFakeBinding(repo) });

        await expect(notFound.info("missing")).rejects.toMatchObject({ code: "NOT_FOUND", data: { code: "NOT_FOUND" } });
        await expect(invalid.withRepo("docs", async (handle) => handle.revokeToken(""))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("maps an unknown code on a named ArtifactsError to INTERNAL", async () => {
        expect.assertions(1);

        const { repo } = createFakeRepo();
        const artifacts = createArtifacts({
            binding: createFakeBinding(repo, {
                list: vi.fn<ArtifactsBindingLike["list"]>(async () => {
                    throw artifactsError("SOMETHING_NEW");
                }),
            }),
        });

        await expect(artifacts.list()).rejects.toMatchObject({ code: "INTERNAL", data: { code: "SOMETHING_NEW" } });
    });

    it("rethrows a non-Artifacts error untouched", async () => {
        expect.assertions(1);

        const { repo } = createFakeRepo();
        const failure = new TypeError("network down");
        const artifacts = createArtifacts({
            binding: createFakeBinding(repo, {
                delete: vi.fn<ArtifactsBindingLike["delete"]>(async () => {
                    throw failure;
                }),
            }),
        });

        await expect(artifacts.delete("docs")).rejects.toBe(failure);
    });
});
