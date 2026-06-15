import type { Collection } from "@tanstack/db";
import { createCollection, localStorageCollectionOptions } from "@tanstack/db";

/** A per-channel unsent message draft. */
export interface Draft {
    channelId: string;
    text: string;
}

/**
 * Client-only drafts, backed by a TanStack DB **localStorage collection** — so an
 * unsent message survives a reload and stays in sync across tabs (the collection
 * listens for `storage` events) without any server involvement. Keyed by channel.
 */
const draftsCollection: Collection<Draft, string> = createCollection(
    localStorageCollectionOptions<Draft, string>({
        getKey: (draft) => draft.channelId,
        storageKey: "lunora-playground-drafts",
    }),
);

export const getDraftsCollection = (): Collection<Draft, string> => draftsCollection;

/** Upsert (or clear, when empty) the draft for a channel. */
export const writeDraft = (channelId: string, text: string): void => {
    const exists = draftsCollection.has(channelId);

    if (text === "") {
        if (exists) {
            draftsCollection.delete(channelId);
        }

        return;
    }

    if (exists) {
        draftsCollection.update(channelId, (draft) => {
            // eslint-disable-next-line no-param-reassign -- TanStack DB's update callback mutates a draft proxy by design (Immer-style)
            draft.text = text;
        });
    } else {
        draftsCollection.insert({ channelId, text });
    }
};

/** Drop a channel's draft (after a successful send). */
export const clearDraft = (channelId: string): void => {
    if (draftsCollection.has(channelId)) {
        draftsCollection.delete(channelId);
    }
};
