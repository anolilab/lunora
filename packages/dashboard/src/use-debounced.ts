import { useEffect, useState } from "react";

/**
 * Debounced mirror of `value`: returns the latest value only after it has been
 * stable for `delayMs`. Used so a per-keystroke search box drives at most one
 * server round-trip per pause, instead of one request per character.
 */
const useDebounced = <T>(value: T, delayMs = 300): T => {
    const [debounced, setDebounced] = useState<T>(value);

    useEffect(() => {
        const id = setTimeout(() => {
            setDebounced(value);
        }, delayMs);

        return () => {
            clearTimeout(id);
        };
    }, [value, delayMs]);

    return debounced;
};

export default useDebounced;
