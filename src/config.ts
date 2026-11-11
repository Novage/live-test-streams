// These constants are not in src/index.ts: the Worker main module may
// export only handlers, and workerd does not start if it exports a number.

/**
 * Loop 0 of every stream starts at this time. Do not change it: a change
 * moves the live position and the media sequence of all streams.
 */
export const EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * Duration of the live window. P2P needs a long window: peers can share
 * only segments that are still in the playlist. With 6 s segments, this is
 * 10 segments.
 */
export const WINDOW_MS = 60_000;
