const DOT_PREFIX_RE = /^\.+/u;

const EXTENSION_MIME_MAP: Record<string, string> = {
    // Images
    avif: "image/avif",
    bmp: "image/bmp",
    gif: "image/gif",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    tiff: "image/tiff",
    tif: "image/tiff",
    webp: "image/webp",

    // Video
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    mp4: "video/mp4",
    mpeg: "video/mpeg",
    mpg: "video/mpeg",
    webm: "video/webm",
    wmv: "video/x-ms-wmv",

    // Audio
    aac: "audio/aac",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    opus: "audio/opus",
    wav: "audio/wav",
    wma: "audio/x-ms-wma",

    // Documents (office / PDF)
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    odp: "application/vnd.oasis.opendocument.presentation",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odt: "application/vnd.oasis.opendocument.text",
    pdf: "application/pdf",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rtf: "application/rtf",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

    // Text / markup
    css: "text/css",
    html: "text/html",
    htm: "text/html",
    ini: "text/plain",
    json: "application/json",
    js: "text/javascript",
    mjs: "text/javascript",
    md: "text/markdown",
    jsx: "text/javascript",
    ts: "text/typescript",
    tsx: "text/typescript",
    txt: "text/plain",
    xml: "application/xml",
    yaml: "application/x-yaml",
    yml: "application/x-yaml",

    // Archives / binaries
    "7z": "application/x-7z-compressed",
    bz2: "application/x-bzip2",
    gz: "application/gzip",
    jar: "application/java-archive",
    rar: "application/vnd.rar",
    tar: "application/x-tar",
    zip: "application/zip",

    // Fonts
    otf: "font/otf",
    ttf: "font/ttf",
    woff: "font/woff",
    woff2: "font/woff2",

    // Other common
    bin: "application/octet-stream",
    epub: "application/epub+zip",
    exe: "application/vnd.microsoft.portable-executable",
    iso: "application/x-iso9660-image",
    sql: "application/sql",
    toml: "application/toml",
};

/**
 * Guess a MIME type from a file extension. Lowercases and strips a leading `.`
 * from `extension`; returns `"application/octet-stream"` for unknown extensions.
 *
 * Covers the broad set of extensions users are likely to encounter in a web /
 * document-processing context — images, video, audio, office docs, PDF, text,
 * archives, and source code. Follows the same approach as Convex's
 * `guessMimeType` helper.
 * @experimental
 */
const guessMimeTypeFromExtension = (extension: string): string => {
    const normalizedExtension = extension.replace(DOT_PREFIX_RE, "").toLowerCase();

    return EXTENSION_MIME_MAP[normalizedExtension] ?? "application/octet-stream";
};

/**
 * SHA-256 hex digest of binary data. Accepts a `BufferSource` (`ArrayBuffer` or
 * `ArrayBufferView` such as `Uint8Array`). Useful for content-addressable
 * storage — pair with `IndexInput.text` to detect duplicates across re-indexes.
 * @experimental
 */
const contentHash = async (data: BufferSource): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", data);

    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export { contentHash, guessMimeTypeFromExtension };
