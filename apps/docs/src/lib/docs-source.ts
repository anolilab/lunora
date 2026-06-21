import { loader } from "fumadocs-core/source";
import { docs } from "fumadocs-mdx:collections/server";
import * as icons from "lucide-static";

export const source = loader({
    baseUrl: "/docs",
    icon(icon) {
        if (icon && icon in icons) {
            return icons[icon as keyof typeof icons];
        }

        return undefined;
    },
    source: docs.toFumadocsSource(),
});
