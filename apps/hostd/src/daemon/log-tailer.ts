/**
 * Following Caddy's access log (plan 458 W6): the lines appended since the
 * last read, across Caddy's own rotation.
 */
import { closeSync, constants, lstatSync, openSync, readSync } from "node:fs";

/** Bytes of access log read per poll; the rest is read on the next one. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

/** Reads the lines appended to a file since the last read, following a rotation or truncation. */
class LogTailer {
    private inode: number | undefined;

    private offset = 0;

    private partial = "";

    private readonly path: string;

    /**
     * Start following `path`: from its current end when it exists — history
     * from before the daemon started is not recounted — and from its start
     * once it appears when it does not.
     */
    public constructor(path: string) {
        this.path = path;

        try {
            const stats = lstatSync(path);

            this.inode = stats.ino;
            this.offset = stats.size;
        } catch {
            // Not written yet: read it whole when it appears.
        }
    }

    /** The complete lines appended since the last call. */
    public read(): string[] {
        let stats: { ino: number; size: number };

        try {
            stats = lstatSync(this.path);
        } catch {
            return [];
        }

        if (this.inode === undefined) {
            this.inode = stats.ino;
        } else if (stats.ino !== this.inode || stats.size < this.offset) {
            // Rotated or truncated: the new file is read from its start.
            this.inode = stats.ino;
            this.offset = 0;
            this.partial = "";
        }

        const length = Math.min(stats.size - this.offset, MAX_READ_BYTES);

        if (length <= 0) {
            return [];
        }

        const buffer = Buffer.alloc(length);
        // Never through a link: the log's directory belongs to Caddy's user, which could plant one.
        const descriptor = openSync(this.path, constants.O_RDONLY + constants.O_NOFOLLOW);

        try {
            readSync(descriptor, buffer, 0, length, this.offset);
        } finally {
            closeSync(descriptor);
        }

        this.offset += length;

        const text = this.partial + buffer.toString("utf8");
        const lines = text.split("\n");

        this.partial = lines.pop() ?? "";

        return lines.filter((line) => line !== "");
    }
}

export default LogTailer;
