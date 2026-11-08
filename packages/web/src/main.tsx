import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createApiClient } from './api/client';
import { ToastProvider } from './components/Toast';
import { createStorage } from './lib/storage';
import './styles.css';

// Even reading window.localStorage can throw (blocked storage); createStorage handles it.
const storage = createStorage({
  getItem: (k) => window.localStorage.getItem(k),
  setItem: (k, v) => window.localStorage.setItem(k, v),
});
const api = createApiClient({
  fetchFn: window.fetch.bind(window),
  getDevUser: () => storage.getDevUser(),
});

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <App api={api} storage={storage} />
    </ToastProvider>
  </StrictMode>,
);
