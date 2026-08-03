import { useLunora, useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { Doc, Id } from "../../lunora/_generated/dataModel.js";
import { Detail } from "./Detail.js";
import { STATUSES, StatusBadge } from "./status.js";

/** Stands in for a signed-in identity — swap for `ctx.auth.userId` and `useAuth()` when you add auth. */
const VOTER_EMAIL = "you@example.com";

type Sort = "recent" | "votes";

export const App = (): ReactElement => {
    const client = useLunora();

    const [sortBy, setSortBy] = useState<Sort>("votes");
    const [filter, setFilter] = useState<Doc<"feedback">["status"] | "">("");
    const [selected, setSelected] = useState<Id<"feedback"> | null>(null);
    const [composing, setComposing] = useState(false);
    const [summarising, setSummarising] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const posts = useQuery(api.feedback.list, filter ? { sortBy, status: filter } : { sortBy });
    const myVotes = useQuery(api.feedback.myVotes, { voterEmail: VOTER_EMAIL });
    const summaries = useQuery(api.summaries.list, {});

    const { mutate: create } = useMutation(api.feedback.create);

    // A Set, not `myVotes.includes(...)` inside the row loop: that is a linear
    // scan per row, so rendering the board is quadratic in the number of votes.
    const votedIds = new Set(myVotes ?? []);

    /**
     * Flip the vote in the cache before the round trip. The count and the
     * "have I voted" list live in two different queries, so both layers are
     * written in one callback — that is what `withOptimisticUpdate` is for,
     * as opposed to the single-query `optimistic` call option.
     */
    const { mutate: toggleVote } = useMutation(api.feedback.toggleVote).withOptimisticUpdate((localStore, { feedbackId, voterEmail }) => {
        const voted = localStore.getQuery(api.feedback.myVotes, { voterEmail }) ?? [];
        const isVoted = voted.includes(feedbackId);

        localStore.setQuery(api.feedback.myVotes, { voterEmail }, isVoted ? voted.filter((id) => id !== feedbackId) : [...voted, feedbackId]);

        for (const { args, value } of localStore.getAllQueries(api.feedback.list)) {
            if (value) {
                localStore.setQuery(
                    api.feedback.list,
                    args,
                    (value as Doc<"feedback">[]).map((post) =>
                        post._id === feedbackId ? { ...post, upvoteCount: Math.max(0, post.upvoteCount + (isVoted ? -1 : 1)) } : post,
                    ),
                );
            }
        }
    });

    const onSummarise = async (): Promise<void> => {
        setSummarising(true);
        setError(null);

        try {
            // Actions are not subscriptions — call them straight on the client.
            await client.action(api.summaries.generate, {});
        } catch (cause: unknown) {
            // Inference is the one call here that leaves the shard, so it is the
            // one that fails for reasons the board cannot fix — say so.
            setError(cause instanceof Error ? cause.message : "could not generate a summary");
        }

        // After the catch, not in a `finally`: the React Compiler cannot lower a
        // finalizer, and the catch above cannot throw.
        setSummarising(false);
    };

    if (selected) {
        return <Detail id={selected} onBack={() => setSelected(null)} voterEmail={VOTER_EMAIL} />;
    }

    return (
        <main className="page">
            <header className="page-header">
                <div>
                    <h1>Feature requests</h1>
                    <p className="muted">Help us build the right things.</p>
                </div>

                <div className="row">
                    <button disabled={summarising} onClick={() => void onSummarise()} type="button">
                        {summarising ? "Summarising…" : "✨ Summarise"}
                    </button>
                    <button className="primary" onClick={() => setComposing((previous) => !previous)} type="button">
                        {composing ? "Cancel" : "Submit feedback"}
                    </button>
                </div>
            </header>

            {error && <p className="error">{error}</p>}

            {composing && (
                <form
                    className="card compose"
                    onSubmit={(event) => {
                        event.preventDefault();

                        const form = new FormData(event.currentTarget);
                        const title = String(form.get("title") ?? "").trim();
                        const authorName = String(form.get("authorName") ?? "").trim();

                        if (!title || !authorName) {
                            return;
                        }

                        void create({
                            authorEmail: VOTER_EMAIL,
                            authorName,
                            description: String(form.get("description") ?? "").trim(),
                            title,
                        });

                        setComposing(false);
                    }}
                >
                    <input required aria-label="Your name" name="authorName" placeholder="Your name" />
                    <input required aria-label="Title" name="title" placeholder="Short, specific title" />
                    <textarea aria-label="Description" name="description" placeholder="What problem does this solve?" rows={3} />
                    <button className="primary" type="submit">
                        Post
                    </button>
                </form>
            )}

            <div className="row toolbar">
                <div className="tabs">
                    <button aria-pressed={sortBy === "votes"} onClick={() => setSortBy("votes")} type="button">
                        Top
                    </button>
                    <button aria-pressed={sortBy === "recent"} onClick={() => setSortBy("recent")} type="button">
                        Newest
                    </button>
                </div>

                <select aria-label="Filter by status" onChange={(event) => setFilter(event.target.value as Doc<"feedback">["status"] | "")} value={filter}>
                    <option value="">All statuses</option>
                    {STATUSES.map((value) => (
                        <option key={value} value={value}>
                            {value}
                        </option>
                    ))}
                </select>
            </div>

            {summaries && summaries.length > 0 && (
                <section className="card summary">
                    <h2>{summaries[0].title}</h2>
                    <pre>{summaries[0].summary}</pre>
                </section>
            )}

            {posts === undefined ? (
                <p className="muted">Connecting…</p>
            ) : (
                <ul className="list">
                    {posts.map((post) => {
                        const voted = votedIds.has(post._id);

                        return (
                            <li key={post._id} className="card post">
                                <button
                                    // The visible label is a caret and a number, which reads as
                                    // "▲ 3" to a screen reader — no indication of what it does.
                                    aria-label={`${voted ? "Remove upvote from" : "Upvote"} ${post.title}`}
                                    aria-pressed={voted}
                                    className={voted ? "vote voted" : "vote"}
                                    onClick={() => void toggleVote({ feedbackId: post._id, voterEmail: VOTER_EMAIL })}
                                    type="button"
                                >
                                    ▲<span>{post.upvoteCount}</span>
                                </button>

                                <button className="post-body" onClick={() => setSelected(post._id)} type="button">
                                    <span className="post-title">{post.title}</span>
                                    <span className="muted">{post.description}</span>
                                    <span className="row">
                                        <StatusBadge status={post.status} />
                                        <span className="muted">
                                            {post.authorName} · {post.commentCount} comments
                                        </span>
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </main>
    );
};
