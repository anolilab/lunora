import { getRouteApi, Link } from "@tanstack/react-router";
import { compareAsc, format } from "date-fns";

import Section from "@/components/sections/section";
import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
} from "@/components/ui/pagination";
import { cn } from "@/lib/utils";

// Define BlogEntry type based on usage and linter errors for clarity
type BlogEntry = {
    data: {
        category?: string; // Adding optional category field
        content: string; // From linter error, assuming it's part of the base type
        description?: string;
        icon?: string;
        image?: string;
        publishedAt?: string | number | Date; // For sorting and display
        title?: string;
    };
    file: {
        dirname: string;
        ext: string;
        flattenedPath: string; // Used for unique keys
        name: string;
        path: string;
    };
    locale?: string;
    slugs: string[];
    url: string;
};

const routeApi = getRouteApi("/blog/" as "/");

const blogsPerPage = 5; // As per original code context
const maxLinksToShowInPagination = 5; // Number of direct page links (e.g., 1,2,3,4,5 or 3,4,5,6,7)

const Overview = () => {
    const allBlogsRaw = routeApi.useLoaderData();
    // Explicitly type allBlogs to ensure downstream types are correct.
    // It's better if useLoaderData() is generically typed or the loader itself provides a typed response.
    const allBlogs: BlogEntry[] = allBlogsRaw ?? [];

    // `getRouteApi("/blog/" as "/")` casts to root (no /blog route file yet), so
    // search params come back as `{}`. Re-type to the shape the page actually uses.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const { includeCategories, pageIndex = 1 } = routeApi.useSearch() as { includeCategories?: string[]; pageIndex?: number };

    // Sort blogs by publishedAt date, handling undefined dates (they go to the end)
    const sortedBlogs = allBlogs.toSorted((a, b) => {
        const dateA = a.data.publishedAt ? new Date(a.data.publishedAt) : null;
        const dateB = b.data.publishedAt ? new Date(b.data.publishedAt) : null;

        if (dateA === null && dateB === null) {
            return 0;
        }

        if (dateA === null) {
            return 1; // Blogs without date go to the end
        }

        if (dateB === null) {
            return -1;
        }

        return compareAsc(dateA, dateB);
    });

    const [first4Blogs, restOfBlogs]: [BlogEntry[], BlogEntry[]] = sortedBlogs.reduce<[BlogEntry[], BlogEntry[]]>(
        (accumulator, blog) => {
            if (accumulator[0].length < 4) {
                accumulator[0].push(blog);

                if (accumulator[0].length === 4) {
                    accumulator[1].push(blog);
                }
            } else {
                accumulator[1].push(blog);
            }

            return accumulator;
        },
        [[], []],
    );

    const totalRestBlogsCount = restOfBlogs.length;
    const totalPages = Math.ceil(totalRestBlogsCount / blogsPerPage);

    const currentStartIndex = (pageIndex - 1) * blogsPerPage;
    const paginatedRestBlogs = restOfBlogs.slice(currentStartIndex, currentStartIndex + blogsPerPage);

    // Generate page numbers for pagination links
    const pageNumbersForLinks: number[] = [];

    if (totalPages > 0) {
        for (let index = 0; index < maxLinksToShowInPagination; index++) {
            const pageNumber = pageIndex + index;

            if (pageNumber <= totalPages) {
                pageNumbersForLinks.push(pageNumber);
            } else {
                break; // Stop if pageNum exceeds totalPages
            }
        }
    }

    const getSafeDateTime = (dateValue: string | number | Date | undefined): string | undefined => {
        if (!dateValue) {
            return undefined;
        }

        try {
            return new Date(dateValue).toISOString();
        } catch {
            return undefined;
        }
    };

    const getFormattedDate = (dateValue: string | number | Date | undefined): string | undefined => {
        if (!dateValue) {
            return undefined;
        }

        try {
            return format(new Date(dateValue), "yyyy-MM-dd");
        } catch {
            return undefined;
        }
    };

    return (
        <Section data-nav-theme="light">
            <div className="col-span-4 flex flex-col">
                <p className="mt-20 text-sm font-medium text-royal-amethyst">// Blog</p>
                <h1 className="text-4.5xl sm:text-5.5xl mt-4 text-gray-950 md:text-6xl inline-block text-balance align-top">News, insights and more</h1>
                <p className="mt-4 text-lg text-gray-700">Learn more about Lunora and our news.</p>
                {/* <nav className="mt-20 hidden sm:block">
                    <ul className="flex gap-4 text-sm font-medium" role="list">
                        <li>
                            <a aria-current="page" className="block rounded-full bg-gray-950 px-2 py-[0.0625rem] text-white transition-colors" href="/blog">
                                All categories
                            </a>
                        </li>
                        <li>
                            <a className="block rounded-full px-2 py-[0.0625rem] text-gray-950 transition-colors hover:text-gray-700" href="/blog/company">
                                Company
                            </a>
                        </li>
                    </ul>
                </nav> */}

                {totalPages === 0 && (
                    <div className="mt-20 py-10 text-center">
                        <p className="text-xl font-semibold text-gray-700">No Blog Posts Yet</p>
                        <p className="mt-2 text-gray-500">There are currently no blog posts available. Please check back soon for news and insights!</p>
                    </div>
                )}

                {totalPages > 0 && (
                    <>
                        <div className="mt-6 grid grid-cols-1 gap-x-8 gap-y-12 sm:mt-10 md:grid-cols-2 xl:grid-cols-3">
                            {first4Blogs.map((blog, index) => (
                                <Link key={`main-blog-${blog.file.flattenedPath}`} to={`/blog${blog.url}` as unknown as "."}>
                                    <div
                                        className={cn("relative isolate", {
                                            "min-xl:hidden": index > 2, // Original logic for hiding items
                                        })}
                                    >
                                        <div className="relative aspect-1200/630 overflow-hidden rounded-2xl bg-gray-950/5 shadow-[0_2px_10px] shadow-gray-900/20">
                                            <img
                                                alt={blog.data.title || "Blog post image"}
                                                className="absolute inset-0 size-full object-cover"
                                                decoding="async"
                                                src={blog.data.image}
                                                style={{ color: "transparent" }}
                                            />
                                        </div>
                                        <div className="mt-6 flex flex-col lg:px-4">
                                            <h2 className="mt-3 text-xl font-bold tracking-[-0.015em] text-pretty text-gray-950">{blog.data.title}</h2>
                                            <p className="mt-3 mb-auto line-clamp-2 text-sm/5 text-gray-600">{blog.data.description}</p>
                                            <dl className="order-first">
                                                <dt className="sr-only">Published</dt>
                                                <dd className="text-sm text-gray-950">
                                                    {blog.data.publishedAt && (
                                                        <time dateTime={getSafeDateTime(blog.data.publishedAt)}>{getFormattedDate(blog.data.publishedAt)}</time>
                                                    )}
                                                </dd>
                                            </dl>
                                        </div>
                                    </div>
                                </Link>
                            ))}
                        </div>

                        <ul className="mt-20 flex flex-col gap-4" role="list">
                            {paginatedRestBlogs.map((blog, index) => (
                                <li key={`rest-blog-${blog.file.flattenedPath}`}>
                                    <Link
                                        className={cn("group/post relative flex flex-col", {
                                            hidden: pageIndex !== 1,
                                            "hidden xl:flex": index === 0,
                                        })}
                                        to={`/blog${blog.url}` as unknown as "."}
                                    >
                                        <svg
                                            aria-hidden="true"
                                            className="relative w-full h-px text-gray-400 group-hover/post:text-royal-amethyst"
                                            focusable="false"
                                            preserveAspectRatio="none"
                                            xmlns="http://www.w3.org/2000/svg"
                                        >
                                            <line stroke="currentColor" strokeDasharray="1 3" strokeWidth="1px" x1="0" x2="100%" y1="50%" y2="50%" />
                                        </svg>
                                        <div className="flex flex-row pt-4">
                                            <h2 className="flex-auto pr-6 text-base font-medium text-pretty transition-colors group-hover/post:text-gray-600">
                                                {blog.data.title}
                                            </h2>
                                            <dl className="absolute inset-x-0 top-[1.125rem] left-0 mt-0.5 flex text-sm sm:static">
                                                <div className="sm:absolute sm:top-[1.125rem] sm:left-0 sm:w-28 sm:flex-none md:static">
                                                    <dt className="sr-only">Category</dt>
                                                    <dd>{blog.data.category}</dd>
                                                </div>
                                                <div className="flex-auto sm:w-24 sm:flex-none sm:text-right lg:w-32">
                                                    <dt className="sr-only">Published</dt>
                                                    <dd className="flex sm:block">
                                                        <svg
                                                            aria-hidden="true"
                                                            className="mx-1.5 h-6 w-2.5 flex-none text-gray-300 sm:hidden"
                                                            fill="none"
                                                            viewBox="0 0 10 10"
                                                        >
                                                            <path
                                                                d="m6.25 1.75-2.5 6.5"
                                                                stroke="currentColor"
                                                                strokeLinecap="round"
                                                                strokeLinejoin="round"
                                                                strokeWidth="1.5"
                                                            />
                                                        </svg>
                                                        {blog.data.publishedAt && (
                                                            <time dateTime={getSafeDateTime(blog.data.publishedAt)}>
                                                                {getFormattedDate(blog.data.publishedAt)}
                                                            </time>
                                                        )}
                                                    </dd>
                                                </div>
                                                <div className="flex w-20 flex-none flex-row-reverse lg:w-[calc(136/16*1rem)]">
                                                    <dt className="sr-only">Authors</dt>
                                                    <dd className="-mr-2 first-of-type:mr-0">
                                                        <img
                                                            alt={blog.data.title || "Author image"} // Consider specific author alt text
                                                            className="size-6 rounded-full"
                                                            decoding="async"
                                                            height="20"
                                                            loading="lazy"
                                                            src={blog.data.image} // Assuming blog image is author image; consider blog.data.author.image
                                                            style={{ color: "transparent" }}
                                                            width="20"
                                                        />
                                                    </dd>
                                                </div>
                                            </dl>
                                        </div>
                                    </Link>
                                </li>
                            ))}
                        </ul>

                        <Pagination>
                            <PaginationContent>
                                {pageIndex > 1 ? (
                                    <PaginationItem>
                                        <PaginationPrevious search={{ includeCategories, pageIndex: pageIndex - 1 } as never} to="/blog/" />
                                    </PaginationItem>
                                ) : null}

                                {pageNumbersForLinks.map((pageNumber) => (
                                    <PaginationItem key={`pagination-item-${pageNumber}`}>
                                        <PaginationLink
                                            isActive={pageIndex === pageNumber}
                                            search={{ includeCategories, pageIndex: pageNumber } as never}
                                            to="/blog/"
                                        >
                                            {pageNumber}
                                        </PaginationLink>
                                    </PaginationItem>
                                ))}

                                {pageNumbersForLinks.length > 0 && pageNumbersForLinks[pageNumbersForLinks.length - 1] < totalPages ? (
                                    <PaginationItem>
                                        <PaginationEllipsis />
                                    </PaginationItem>
                                ) : null}

                                {pageIndex < totalPages ? (
                                    <PaginationItem>
                                        <PaginationNext search={{ includeCategories, pageIndex: pageIndex + 1 } as never} to="/blog/" />
                                    </PaginationItem>
                                ) : null}
                            </PaginationContent>
                        </Pagination>
                    </>
                )}
            </div>
        </Section>
    );
};

export default Overview;
