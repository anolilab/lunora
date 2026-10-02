import { describe, expect, expectTypeOf, it } from "vitest";

import type { ArtifactsEvent, ArtifactsRepoActivityEvent, ArtifactsRepoLifecycleEvent } from "../../src/artifacts/types";

const metadata = {
    accountId: "f9f79265f388666de8122cfb508d7776",
    eventSchemaVersion: 1,
    eventSubscriptionId: "1830c4bb612e43c3af7f4cada31fbf3f",
    eventTimestamp: "2026-05-18T15:53:48.187Z",
} as const;

const repoState = {
    createdAt: "2026-05-18T15:53:46.833Z",
    defaultBranch: "main",
    description: "My Artifacts repository",
    lastPushAt: null,
    readOnly: false,
    repoId: "0tvugavnogssnwzk",
    updatedAt: "2026-05-18T15:53:46.833Z",
};

const lifecycleSource = { namespace: "my-namespace", repoName: "my-repo", type: "artifacts" } as const;
const activitySource = { namespace: "my-namespace", repoName: "my-repo", type: "artifacts.repo" } as const;
const identity = { email: "developer@example.com", name: "Developer Name" };

/** Narrow the union by its `type` discriminant. */
type EventOf<T extends ArtifactsEvent["type"]> = Extract<ArtifactsEvent, { type: T }>;

/** Route an event the way a `defineQueue` consumer would, so narrowing on `type` is exercised. */
const describeEvent = (event: ArtifactsEvent): string => {
    switch (event.type) {
        case "cf.artifacts.repo.cloned":
        case "cf.artifacts.repo.fetched": {
            return `${event.type}:${event.source.repoName}`;
        }
        case "cf.artifacts.repo.created":
        case "cf.artifacts.repo.deleted": {
            return `${event.type}:${event.payload.repoId}`;
        }
        case "cf.artifacts.repo.forked": {
            return `${event.type}:${event.payload.repoName}`;
        }
        case "cf.artifacts.repo.imported": {
            return `${event.type}:${event.payload.sourceUrl}`;
        }
        case "cf.artifacts.repo.pushed": {
            return `${event.type}:${event.payload.after}`;
        }
        case "cf.artifacts.repo.token.created":
        case "cf.artifacts.repo.token.revoked": {
            return `${event.type}:${event.payload.tokenId}`;
        }
        default: {
            return "unknown";
        }
    }
};

// Each event below is the documented example for that type
// (developers.cloudflare.com/artifacts/guides/event-subscriptions). Annotating it
// with the union member makes a drift between our types and the published
// schema a `tsc` failure; the runtime assertion checks the narrowing.
describe("artifactsEvent", () => {
    it("types cf.artifacts.repo.created", () => {
        expect.assertions(1);

        const event: EventOf<"cf.artifacts.repo.created"> = { metadata, payload: repoState, source: lifecycleSource, type: "cf.artifacts.repo.created" };

        expect(describeEvent(event)).toBe("cf.artifacts.repo.created:0tvugavnogssnwzk");
    });

    it("types cf.artifacts.repo.deleted", () => {
        expect.assertions(1);

        const event: EventOf<"cf.artifacts.repo.deleted"> = { metadata, payload: repoState, source: lifecycleSource, type: "cf.artifacts.repo.deleted" };

        expect(describeEvent(event)).toBe("cf.artifacts.repo.deleted:0tvugavnogssnwzk");
    });

    it("types cf.artifacts.repo.forked with the new repo in the payload", () => {
        expect.assertions(1);

        const event: EventOf<"cf.artifacts.repo.forked"> = {
            metadata,
            payload: { ...repoState, namespace: "target-namespace", repoName: "target-repo" },
            source: lifecycleSource,
            type: "cf.artifacts.repo.forked",
        };

        expect(describeEvent(event)).toBe("cf.artifacts.repo.forked:target-repo");
    });

    it("types cf.artifacts.repo.imported with its source url and branch", () => {
        expect.assertions(1);

        const event: EventOf<"cf.artifacts.repo.imported"> = {
            metadata,
            payload: { ...repoState, branch: "main", sourceUrl: "https://github.com/example/repo.git" },
            source: lifecycleSource,
            type: "cf.artifacts.repo.imported",
        };

        expect(describeEvent(event)).toBe("cf.artifacts.repo.imported:https://github.com/example/repo.git");
    });

    it("types cf.artifacts.repo.pushed", () => {
        expect.assertions(1);

        const event: EventOf<"cf.artifacts.repo.pushed"> = {
            metadata,
            payload: {
                after: "def789ghi012def789ghi012def789ghi012def7",
                before: "abc123def456abc123def456abc123def456abc1",
                commits: [
                    {
                        author: identity,
                        committer: identity,
                        id: "def789ghi012def789ghi012def789ghi012def7",
                        message: "Fix bug in authentication",
                        messageTruncated: false,
                        parents: ["abc123def456abc123def456abc123def456abc1"],
                        timestamp: "2025-05-01T02:48:57.000Z",
                    },
                ],
                commitsTruncated: false,
                ref: "refs/heads/main",
                totalCommitsCount: 1,
            },
            source: activitySource,
            type: "cf.artifacts.repo.pushed",
        };

        expect(describeEvent(event)).toBe(`cf.artifacts.repo.pushed:${event.payload.after}`);
    });

    it("types cf.artifacts.repo.cloned with an empty payload", () => {
        expect.assertions(1);

        const event: EventOf<"cf.artifacts.repo.cloned"> = { metadata, payload: {}, source: activitySource, type: "cf.artifacts.repo.cloned" };

        expect(describeEvent(event)).toBe("cf.artifacts.repo.cloned:my-repo");
    });

    it("types cf.artifacts.repo.fetched with an empty payload", () => {
        expect.assertions(1);

        const event: EventOf<"cf.artifacts.repo.fetched"> = { metadata, payload: {}, source: activitySource, type: "cf.artifacts.repo.fetched" };

        expect(describeEvent(event)).toBe("cf.artifacts.repo.fetched:my-repo");
    });

    it("types cf.artifacts.repo.token.created without any plaintext", () => {
        expect.assertions(1);

        const event: EventOf<"cf.artifacts.repo.token.created"> = {
            metadata,
            payload: { expiresAt: "2026-05-20T16:58:14.548Z", scope: "read", tokenId: "7ngdf3ww3u84t33x" },
            source: activitySource,
            type: "cf.artifacts.repo.token.created",
        };

        expectTypeOf(event.payload).not.toHaveProperty("plaintext");

        expect(describeEvent(event)).toBe("cf.artifacts.repo.token.created:7ngdf3ww3u84t33x");
    });

    it("types cf.artifacts.repo.token.revoked", () => {
        expect.assertions(1);

        const event: EventOf<"cf.artifacts.repo.token.revoked"> = {
            metadata,
            payload: { tokenId: "7ngdf3ww3u84t33x" },
            source: activitySource,
            type: "cf.artifacts.repo.token.revoked",
        };

        expect(describeEvent(event)).toBe("cf.artifacts.repo.token.revoked:7ngdf3ww3u84t33x");
    });

    it("splits the union by subscription source", () => {
        expect.assertions(1);

        expectTypeOf<ArtifactsRepoLifecycleEvent["source"]["type"]>().toEqualTypeOf<"artifacts">();
        expectTypeOf<ArtifactsRepoActivityEvent["source"]["type"]>().toEqualTypeOf<"artifacts.repo">();

        const lifecycle: ArtifactsRepoLifecycleEvent["source"] = lifecycleSource;

        expect(lifecycle.type).toBe("artifacts");
    });
});
