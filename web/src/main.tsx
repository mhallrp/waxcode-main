import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');

/** No service worker, and anything left over is removed. */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations?.()
    .then((all) => all.forEach((one) => { void one.unregister(); }))
    .catch(() => {});
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
