import { format } from "date-fns";
import type { FC } from "react";

import { Kicker } from "@/kit/layout";
import { isFallbackImage } from "@/lib/seo";

/** Format an ISO/date string into a `MMM D, YYYY` (uppercased) label + ISO datetime. */
export const formatDate = (value?: string): { formatted: string; iso?: string } => {
    if (!value) {
        return { formatted: "" };
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return { formatted: "" };
    }

    return { formatted: format(date, "MMM d, yyyy").toUpperCase(), iso: date.toISOString() };
};

/** The `CATEGORY · DATE` line every entry carries, on the index and on a post. */
export const MetaLine: FC<{ category?: string; publishedAt?: string }> = ({ category, publishedAt }) => {
    const { formatted, iso } = formatDate(publishedAt);

    return (
        <Kicker className="flex items-center gap-2" size="micro">
            {category ?? "Blog"}
            {formatted ? (
                <>
                    <span aria-hidden="true">·</span>
                    <time dateTime={iso}>{formatted}</time>
                </>
            ) : null}
        </Kicker>
    );
};

/**
 * The cover slot.
 *
 * Seven of the eight posts have no cover art — six declare `/og-default.jpg`,
 * the shared social card, and one declares nothing. Rendering that file would
 * put the same image on six entries, so a post without art falls back to its
 * own generated card instead: the exact image it is shared with, built from its
 * title and category, so the index and the link preview cannot disagree.
 *
 * The predicate lives in `lib/seo` because the same rule picks the social card;
 * the two disagreeing is what put one image on six posts to begin with.
 *
 * Drop a real path into a post's frontmatter and it wins, with no change here.
 */
export const Cover: FC<{ category?: string; description?: string; eager?: boolean; image?: string; title?: string }> = ({
    category,
    description,
    eager = false,
    image,
    title,
}) => {
    const generated = new URLSearchParams({ description: description ?? "", eyebrow: category ?? "Blog", title: title ?? "Lunora" });
    const source = isFallbackImage(image) ? `/api/og?${generated.toString()}` : image;

    return (
        <div className="aspect-1200/630 w-full overflow-hidden bg-wash">
            <img
                alt={`Cover for ${title ?? "a Lunora blog post"}`}
                className="size-full object-cover"
                decoding="async"
                loading={eager ? "eager" : "lazy"}
                src={source}
            />
        </div>
    );
};
