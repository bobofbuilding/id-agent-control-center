import type { IdAgentsApi } from '../preload/preload.ts';

declare global {
  interface Window {
    idagents: IdAgentsApi;
  }
}
export {};
