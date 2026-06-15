import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { Doc } from "../../lunora/_generated/dataModel.js";

/**
 * Author dashboard. Lets a signed-in user write a markdown post, attach a
 * featured image (uploaded to R2 via signed URL), and publish.
 */
export const Dashboard = (): ReactElement => {
    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [uploadingImage, setUploadingImage] = useState(false);
    const [imageKey, setImageKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const posts = useQuery(api.posts.list, {}) as Array<Doc<"posts">> | undefined;

    const { mutate: requestUpload } = useMutation(api.posts.requestImageUpload);
    const { mutate: publish, pending: publishing } = useMutation(api.posts.publish);

    return (
        <main style={{ display: "grid", fontFamily: "system-ui", gap: 24, margin: "2rem auto", maxWidth: 720 }}>
            <h1>Dashboard</h1>
            <form
                onSubmit={(event) => {
                    event.preventDefault();

                    if (title.trim() === "" || body.trim() === "") {
                        return;
                    }

                    void (async () => {
                        await publish({ body, imageKey: imageKey ?? undefined, title });
                        setBody("");
                        setImageKey(null);
                        setTitle("");
                    })();
                }}
                style={{ display: "grid", gap: 12 }}
            >
                <input
                    onChange={(event) => {
                        setTitle(event.target.value);
                    }}
                    placeholder="Post title"
                    style={{ fontSize: 18, padding: 8 }}
                    value={title}
                />
                <textarea
                    onChange={(event) => {
                        setBody(event.target.value);
                    }}
                    placeholder="Write your post in Markdown..."
                    rows={10}
                    style={{ fontFamily: "monospace", padding: 8 }}
                    value={body}
                />
                <label>
                    Featured image
                    <input
                        accept="image/*"
                        disabled={uploadingImage}
                        onChange={(event) => {
                            const file = event.target.files?.[0];

                            if (!file) {
                                return;
                            }

                            setUploadingImage(true);
                            setError(null);

                            void (async () => {
                                try {
                                    const { url, key } = (await requestUpload({ contentType: file.type })) as { key: string; url: string };

                                    // Stream the bytes straight to R2 — the Worker never proxies them.
                                    const upload = await fetch(url, { body: file, headers: { "content-type": file.type }, method: "PUT" });

                                    if (!upload.ok) {
                                        throw new Error(`R2 PUT failed (${upload.status})`);
                                    }

                                    setImageKey(key);
                                } catch (error_: unknown) {
                                    setError(error_ instanceof Error ? error_.message : "upload failed");
                                } finally {
                                    setUploadingImage(false);
                                }
                            })();
                        }}
                        type="file"
                    />
                </label>
                {imageKey ? <p style={{ fontSize: 12, opacity: 0.7 }}>Uploaded: {imageKey}</p> : null}
                <button disabled={publishing || uploadingImage} type="submit">
                    Publish
                </button>
                {error ? <p role="alert">{error}</p> : null}
            </form>

            <section>
                <h2>Recent posts</h2>
                <ul style={{ listStyle: "none", padding: 0 }}>
                    {(posts ?? []).map((post) => (
                        <li key={post._id} style={{ padding: "12px 0" }}>
                            <h3>{post.title}</h3>
                            <small style={{ opacity: 0.6 }}>{new Date(post.publishedAt).toLocaleString()}</small>
                            <p>{post.body.slice(0, 200)}</p>
                        </li>
                    ))}
                </ul>
            </section>
        </main>
    );
};
