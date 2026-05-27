import { DocsBody, DocsPage } from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactElement } from "react";

import { source } from "@/lib/source";

interface PageProps {
    params: Promise<{ slug?: string[] }>;
}

const Page = async ({ params }: PageProps): Promise<ReactElement> => {
    const { slug } = await params;
    const page = source.getPage(slug);

    if (!page) {
        notFound();
    }

    const MDX = page.data.body;
    const data = page.data as typeof page.data & { description?: string; title?: string };

    return (
        <DocsPage toc={page.data.toc}>
            <DocsBody>
                <h1>{data.title}</h1>
                <MDX />
            </DocsBody>
        </DocsPage>
    );
};

export default Page;

export const generateStaticParams = async (): Promise<ReadonlyArray<{ slug: string[] }>> => source.generateParams();

export const generateMetadata = async ({ params }: PageProps): Promise<Metadata> => {
    const { slug } = await params;
    const page = source.getPage(slug);

    if (!page) {
        return {};
    }

    const data = page.data as typeof page.data & { description?: string; title?: string };

    return {
        description: data.description,
        title: data.title,
    };
};
