/**
 * Compiled by `consumer-types.test.ts` under an app-like tsconfig: `lib: ["ES2024"]`
 * plus workers-types, with neither `@types/node` nor `lib.esnext.disposable`. If
 * a repo client type is ever derived through `typeof Symbol.dispose` again, that
 * resolves to `any` here and every call below stops type-checking.
 */
import type { ArtifactsClient, ArtifactsRepoClient, ArtifactsRepoLike } from "../../../src/artifacts/types";

declare const artifacts: ArtifactsClient;

export const readme = async (): Promise<string | null> => {
    const file = await artifacts.withRepo("docs", async (repo) => repo.readFile({ path: "README.md", ref: "main" }));

    return file === null ? null : await file.text();
};

export const firstCommit = async (repo: ArtifactsRepoClient): Promise<string | undefined> => {
    const [commit] = await repo.log({ limit: 1 });

    return commit?.hash;
};

/** The raw handle is a repo client plus an optional disposer. */
export const asClient = (handle: ArtifactsRepoLike): ArtifactsRepoClient => handle;
