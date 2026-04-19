import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/global.scss';
import { INLINE_LOGO_JPEG } from '@/assets/logoInline';
import { apiClient } from '@/services/api/client';
import { secureStorage } from '@/services/storage/secureStorage';
import { initializeLocalPersistence } from '@/services/localPersistence';
import { detectApiBaseFromLocation, normalizeApiBase } from '@/utils/connection';
import { STORAGE_KEY_AUTH } from '@/utils/constants';

document.title = 'CLI Proxy API Management Center Ouqiting';

const faviconEl = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (faviconEl) {
  faviconEl.href = INLINE_LOGO_JPEG;
  faviconEl.type = 'image/jpeg';
} else {
  const newFavicon = document.createElement('link');
  newFavicon.rel = 'icon';
  newFavicon.type = 'image/jpeg';
  newFavicon.href = INLINE_LOGO_JPEG;
  document.head.appendChild(newFavicon);
}

const getBootstrapAuthConfig = (): { apiBase: string; managementKey: string } => {
  const persisted = secureStorage.getItem<Record<string, unknown>>(STORAGE_KEY_AUTH);
  const state =
    persisted && typeof persisted === 'object' && 'state' in persisted
      ? (persisted.state as Record<string, unknown>)
      : persisted;

  const apiBase =
    state && typeof state.apiBase === 'string' && state.apiBase.trim()
      ? normalizeApiBase(state.apiBase)
      : detectApiBaseFromLocation();
  const managementKey =
    state && typeof state.managementKey === 'string' ? state.managementKey : '';

  return { apiBase, managementKey };
};

async function bootstrap() {
  const { apiBase, managementKey } = getBootstrapAuthConfig();
  if (apiBase) {
    apiClient.setConfig({ apiBase, managementKey });
  }

  await initializeLocalPersistence();

  const { default: App } = await import('./App.tsx');

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void bootstrap();
