import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { Id } from "../../lunora/_generated/dataModel.js";
import type { Status } from "./status.js";
import { STATUSES } from "./status.js";
import { StatusBadge } from "./StatusBadge.js";

/**
 * One text field out of a `FormData`.
 *
 * `FormData.get` is typed `string | File | null`, so `String(form.get(name) ?? "")`
 * stringifies a `File` to `"[object File]"` — a file input sharing a text field's
 * name would submit that verbatim. Narrowing instead yields `""` for anything
 * that is not text.
 */
const textField = (form: FormData, name: string): string => {
    const value = form.get(name);

    return typeof value === "string" ? value : "";
};

interface DetailProperties {
    id: Id<"feedback">;
    onBack: () => void;
    voterEmail: string;
}

export const Detail = ({ id, onBack, voterEmail }: DetailProperties): ReactElement => {
    const post = useQuery(api.feedback.get, { id });
    const comments = useQuery(api.feedback.comments, { feedbackId: id });

    const { mutate: addComment } = useMutation(api.feedback.addComment);
    const { mutate: setStatus } = useMutation(api.feedback.setStatus);

    if (post === undefined) {
        return <p className="muted">Loading…</p>;
    }

    if (post === null) {
        return (
            <main className="page">
                <button onClick={onBack} type="button">
                    ← Back
                </button>
                <p className="muted">This request was deleted.</p>
            </main>
        );
    }

    return (
        <main className="page">
            <button onClick={onBack} type="button">
                ← Back
            </button>

            <section className="card">
                <div className="row">
                    <h1>{post.title}</h1>
                    <StatusBadge status={post.status} />
                </div>
                <p className="muted">
                    {post.authorName} · {post.upvoteCount} votes
                </p>
                <p>{post.description}</p>

                <label htmlFor="detail-field1">
                    Status
                    <select
                        id="detail-field1"
                        onChange={(event) => {
                            void setStatus({ id, status: event.target.value as Status });
                        }}
                        value={post.status}
                    >
                        {STATUSES.map((value) => (
                            <option key={value} value={value}>
                                {value}
                            </option>
                        ))}
                    </select>
                </label>
            </section>

            <section className="card">
                <h2>Discussion</h2>

                <ul className="list">
                    {(comments ?? []).map((comment) => (
                        <li className="comment" key={comment._id}>
                            <strong>{comment.authorName}</strong>
                            {comment.isOfficial && <span className="badge badge-official">team</span>}
                            <p>{comment.content}</p>
                        </li>
                    ))}
                </ul>

                <form
                    onSubmit={(event) => {
                        event.preventDefault();

                        const form = new FormData(event.currentTarget);
                        const content = textField(form, "content").trim();

                        if (!content) {
                            return;
                        }

                        void addComment({ authorEmail: voterEmail, authorName: "You", content, feedbackId: id });
                        event.currentTarget.reset();
                    }}
                >
                    <textarea aria-label="Add a comment" name="content" placeholder="Add a comment" required rows={2} />
                    <button className="primary" type="submit">
                        Comment
                    </button>
                </form>
            </section>
        </main>
    );
};
