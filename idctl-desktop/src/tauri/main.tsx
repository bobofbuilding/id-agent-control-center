import './errorhook.ts'; // FIRST — catches errors in the modules below
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
// Route ManagerClient's global fetch through Tauri (Rust performs the request,
// so the manager's missing CORS headers don't block us).
(globalThis as any).fetch = tauriFetch;

import '../renderer/styles.css';
import { createRoot } from 'react-dom/client';
import { App } from '../renderer/App.tsx';
import { setTransport } from '../renderer/store.ts';
import { tauriCall } from './adapter.ts';

setTransport(tauriCall);
createRoot(document.getElementById('root')!).render(<App />);
