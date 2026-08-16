import { useMutation, useQuery } from "@lunora/react";
import { createFileRoute } from "@tanstack/react-router";
import type { ChangeEventHandler, FormEventHandler, JSX } from "react";
import { useCallback, useState } from "react";

import { api } from "#lunora/_generated/api.js";

import { ChatPane } from "../workbench/chat-pane";
import { Editor } from "../workbench/editor";
import { FileTree } from "../workbench/file-tree";
import { Terminal } from "../workbench/terminal";

/**
 * The workbench — plan 335 W5.
 *
 * Four panes over one live subscription each: chat, file tree, editor, terminal.
 * None of them polls and none of them invalidates a cache — an agent write lands
 * in the `files`/`messages` tables and every open pane re-renders, which is
 * §D18's "reuse the agent's message stream, add no second protocol" taken
 * literally.
 */
const Workbench = (): JSX.Element => {
    const { projectId } = Route.useParams();

    const chats = useQuery(api.chats.list, { projectId });
    const tree = useQuery(api.files.tree, { projectId });

    const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);
    const [prompt, setPrompt] = useState("");

    const { mutate: startChat } = useMutation(api.chats.start);
    const { mutate: sendMessage } = useMutation(api.chats.send);

    // The newest chat is the active one. A project usually has exactly one; a
    // fork creates a second, and the newest is the one being worked on.
    const activeChat = chats?.chats[0];

    const onPromptChange: ChangeEventHandler<HTMLTextAreaElement> = useCallback((event) => {
        setPrompt(event.target.value);
    }, []);

    const onSubmit: FormEventHandler<HTMLFormElement> = useCallback(
        (event) => {
            event.preventDefault();

            const trimmed = prompt.trim();

            if (trimmed.length === 0) {
                return;
            }

            setPrompt("");

            const sent =
                activeChat === undefined ? startChat({ projectId, prompt: trimmed }) : sendMessage({ chatId: activeChat._id, projectId, prompt: trimmed });

            sent.catch((error: unknown) => {
                // Put the text back rather than losing it: a rejected send is
                // usually a rate limit, and retyping a lost prompt is the worst
                // possible response to "you are going too fast".
                setPrompt(trimmed);
                // eslint-disable-next-line no-console -- until the workbench grows an error surface, a swallowed failure looks like a silent no-op
                console.error("Could not send the message", error);
            });
        },
        [activeChat, projectId, prompt, sendMessage, startChat],
    );

    return (
        <div className="workbench">
            <aside className="pane pane-chat">
                <ChatPane chatId={activeChat?._id} projectId={projectId} />

                <form className="composer" onSubmit={onSubmit}>
                    <textarea aria-label="Message the builder" onChange={onPromptChange} placeholder="Describe a change…" rows={3} value={prompt} />
                    <button disabled={prompt.trim().length === 0} type="submit">
                        Send
                    </button>
                </form>
            </aside>

            <nav className="pane pane-tree">
                <FileTree files={tree?.files} onSelect={setSelectedPath} selectedPath={selectedPath} />
            </nav>

            <section className="pane pane-editor">
                <Editor key={selectedPath ?? "none"} path={selectedPath} projectId={projectId} />
            </section>

            <section className="pane pane-terminal">
                <Terminal projectId={projectId} />
            </section>
        </div>
    );
};

export const Route = createFileRoute("/p/$projectId")({ component: Workbench });
