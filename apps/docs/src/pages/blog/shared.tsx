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
 * A post declaring the shared social card has no cover of its own, so it takes
 * a typographic tile rather than a stand-in image: six posts declare it, and
 * six identical covers in a grid read as a broken page. The predicate lives in
 * `lib/seo`, because the same rule decides what a post's social card is — the
 * two disagreeing is how those six ended up sharing an image in the first place.
 */
export const Cover: FC<{ category?: string; eager?: boolean; image?: string; title?: string }> = ({ category, eager = false, image, title }) => (
    <div className="aspect-1200/630 w-full overflow-hidden bg-wash">
        {isFallbackImage(image) ? (
            <div className="flex size-full items-center justify-center border border-hairline p-6">
                <Kicker size="micro">{category ?? "Blog"}</Kicker>
            </div>
        ) : (
            <img
                alt={`Cover for ${title ?? "a Lunora blog post"}`}
                className="size-full object-cover"
                decoding="async"
                loading={eager ? "eager" : "lazy"}
                src={image}
            />
        )}
    </div>
);
