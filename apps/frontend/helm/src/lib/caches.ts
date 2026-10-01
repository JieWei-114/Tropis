/**
 * Service-worker caches. The precache holds the app shell only; anything
 * else is runtime data that must not outlive the session that fetched it.
 */
const PRECACHE_PREFIX = 'workbox-precache';

/** Deletes every Cache Storage entry except the app-shell precache. */
export async function clearRuntimeCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => !name.startsWith(PRECACHE_PREFIX))
        .map((name) => caches.delete(name)),
    );
  } catch {
    /* Cache Storage unavailable (private mode, insecure context) */
  }
}
