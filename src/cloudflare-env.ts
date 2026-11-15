// `env` from "cloudflare:test" / "cloudflare:workers" is typed as the global Cloudflare.Env.
// Point it at the app's own binding list so tests see MERCHANT, BACKUPS, IMAGES...
// (Types only: this file emits no code.)
import type { Env as AppEnv } from './types';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}
