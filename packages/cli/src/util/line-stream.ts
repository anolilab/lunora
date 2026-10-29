import { createInterface } from "node:readline";

/**
 * Call `onLine` for every line a child's output stream produces, as it arrives.
 * `readline` does the buffering a hand-rolled `split("\n")` gets wrong: a line
 * split across two chunks is rejoined, a multi-byte character split across two
 * chunks is decoded once, `\r\n` counts as one break, and the unterminated last
 * line is still delivered when the stream ends.
 */
const forEachLine = (stream: NodeJS.ReadableStream, onLine: (line: string) => void): void => {
    createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: stream }).on("line", onLine);
};

export default forEachLine;
