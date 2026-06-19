import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { setTransport } from './store.ts';

// Electron shell: route data calls over the IPC bridge.
setTransport((method, args) => window.idagents.call(method, ...args));

createRoot(document.getElementById('root')!).render(<App />);
