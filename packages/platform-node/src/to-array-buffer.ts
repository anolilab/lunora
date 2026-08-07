/**
 * The package's one "give me a standalone `ArrayBuffer`" helper, shared by the
 * socket host (recording received frames) and the R2 bucket (`arrayBuffer()`
 * and the SHA-256 checksum projection).
 *
 * The `slice` on the view branch is what makes it a copy, and it is the whole
 * point: a Node `Buffer` is a window into a shared allocation pool, so handing
 * out its `.buffer` would expose whatever else happens to live in that pool.
 */
export const toArrayBuffer = (data: string | ArrayBufferLike | Blob | ArrayBufferView): ArrayBuffer => {
    if (typeof data === "string") {
        return new TextEncoder().encode(data).buffer;
    }

    if (data instanceof ArrayBuffer) {
        return data;
    }

    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    }

    // Blob is not supported by this host — same limitation the reference host
    // carries, and the engine never sends one (every Lunora wire frame is JSON
    // text).
    return new ArrayBuffer(0);
};
