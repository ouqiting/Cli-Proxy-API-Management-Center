import { create } from 'zustand';
import type {
  CredentialDisableSnapshot,
  DisableCredentialTarget,
} from '@/services/api/credentialDisable';
import {
  loadCredentialDisableSnapshot,
  setAuthFileDisabledState,
  setOpenAIApiKeyEntryDisabledState,
  setProviderKeyDisabledState,
} from '@/services/api/credentialDisable';

interface DisabledCredentialsStoreState {
  snapshot: CredentialDisableSnapshot | null;
  loading: boolean;
  error: string | null;
  refreshSnapshot: (force?: boolean) => Promise<CredentialDisableSnapshot | null>;
  setSnapshot: (snapshot: CredentialDisableSnapshot) => void;
  setTargetDisabledState: (
    target: DisableCredentialTarget,
    disabled: boolean
  ) => Promise<void>;
}

let inFlightSnapshotRequest: Promise<CredentialDisableSnapshot | null> | null = null;

export const useDisabledCredentialsStore = create<DisabledCredentialsStoreState>((set, get) => ({
  snapshot: null,
  loading: false,
  error: null,

  refreshSnapshot: async (force = false) => {
    if (!force) {
      const existing = get().snapshot;
      if (existing) {
        return existing;
      }
    }

    if (inFlightSnapshotRequest) {
      return inFlightSnapshotRequest;
    }

    set({ loading: true, error: null });

    const request = (async () => {
      try {
        const snapshot = await loadCredentialDisableSnapshot();
        set({ snapshot, loading: false, error: null });
        return snapshot;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Failed to load credential disable snapshot';
        set({ loading: false, error: message });
        return null;
      } finally {
        inFlightSnapshotRequest = null;
      }
    })();

    inFlightSnapshotRequest = request;
    return request;
  },

  setSnapshot: (snapshot) => {
    set({ snapshot, error: null });
  },

  setTargetDisabledState: async (target, disabled) => {
    if (target.kind === 'auth_file') {
      await setAuthFileDisabledState(target.name, disabled);
      await get().refreshSnapshot(true);
      return;
    }

    if (target.kind === 'provider_key') {
      await setProviderKeyDisabledState(target.providerKind, target.apiKey, disabled);
      await get().refreshSnapshot(true);
      return;
    }

    await setOpenAIApiKeyEntryDisabledState(
      target.providerName,
      target.providerBaseUrl,
      target.apiKey,
      disabled
    );
    await get().refreshSnapshot(true);
  },
}));
