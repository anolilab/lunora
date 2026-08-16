import { useMutation, useQuery } from "@lunora/react";
import type { ChangeEventHandler, JSX } from "react";
import { useCallback, useState } from "react";

import { api } from "#lunora/_generated/api.js";

interface EditorProperties {
    path: string | undefined;
    projectId: string;
}

/**
 * The file editor.
 *
 * A plain textarea, not Monaco: Monaco is ~2MB and a language server's worth of
 * setup, and until the agent loop is producing files worth editing by hand it
 * would be weight carried for a pane nobody uses yet. The seam is the same
 * either way — read a file, edit it, save it.
 *
 * The local draft is deliberately NOT synced back from the live query while the
 * user is typing. The file row is a live subscription, so an agent write during
 * an edit would otherwise yank the buffer out from under them mid-keystroke.
 *
 * The draft is reset by REMOUNTING on a path change — the parent passes
 * `key={path}` — rather than by an effect that calls `setDraft(undefined)`.
 * Same result, no synchronous set-state in an effect, and the reset is declared
 * where the identity actually changes.
 */
const Editor = ({ path, projectId }: EditorProperties): JSX.Element => {
    const file = useQuery(api.files.read, { path: path ?? "", projectId });
    const { mutate: writeFile } = useMutation(api.files.write);

    const [draft, setDraft] = useState<string | undefined>(undefined);

    const onChange: ChangeEventHandler<HTMLTextAreaElement> = useCallback((event) => {
        setDraft(event.target.value);
    }, []);

    const onSave = useCallback(() => {
        if (path === undefined || draft === undefined) {
            return;
        }

        writeFile({ content: draft, path, projectId }).catch((error: unknown) => {
            // eslint-disable-next-line no-console -- the workbench has no error surface yet; silence would look like a successful save
            console.error("Could not save the file", error);
        });
    }, [draft, path, projectId, writeFile]);

    if (path === undefined) {
        return <p className="muted">Select a file to read it.</p>;
    }

    if (file === undefined) {
        return <p className="muted">Loading {path}…</p>;
    }

    const content = draft ?? file.content ?? "";
    const dirty = draft !== undefined && draft !== (file.content ?? "");

    return (
        <div className="editor">
            <header className="editor-header">
                <span className="file-path">{path}</span>
                <button disabled={!dirty} onClick={onSave} type="button">
                    {dirty ? "Save" : "Saved"}
                </button>
            </header>
            <textarea aria-label={`Contents of ${path}`} className="editor-body" onChange={onChange} spellCheck={false} value={content} />
        </div>
    );
};

export { Editor };
