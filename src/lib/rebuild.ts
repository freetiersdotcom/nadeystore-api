// src/lib/rebuild.ts
// Asks the Durable Object to (debounced) trigger a frontstore rebuild.
// Only does anything when REBUILD_HOOK_URL is configured. It must never make
// the API call that triggered it fail, so errors are logged and swallowed.
import type { DOStub } from '../types';

export async function requestSiteRebuild(db: DOStub): Promise<void> {
  try {
    await db.scheduleRebuild();
  } catch (e) {
    console.error('[rebuild] could not schedule rebuild', e);
  }
}
