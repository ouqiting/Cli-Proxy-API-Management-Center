import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDisabledCredentialsStore, useNotificationStore } from '@/stores';
import type {
  CredentialDisableSnapshot,
  DisableCredentialTarget,
  ProviderKeyKind,
} from '@/services/api/credentialDisable';
import { buildCandidateUsageSourceIds, normalizeAuthIndex, normalizeUsageSourceId } from '@/utils/usage';
import { maskApiKey } from '@/utils/format';
import type { SourceInfo } from '@/types/sourceInfo';

export interface DisableCredentialLocator {
  source: string;
  authIndex?: string | number | null;
  displayName?: string;
}

export interface DisableState {
  target: DisableCredentialTarget;
  displayName: string;
  action: 'disable' | 'restore';
}

export interface UseDisableModelOptions {
  providerMap?: Record<string, string>;
  sourceInfoMap?: Map<string, SourceInfo>;
  providerModels?: Record<string, Set<string>>;
}

export interface UseDisableModelReturn {
  disableState: DisableState | null;
  disabling: boolean;
  handleDisableClick: (locator: DisableCredentialLocator) => void;
  handleConfirmDisable: () => Promise<void>;
  handleCancelDisable: () => void;
  isCredentialDisabled: (locator: DisableCredentialLocator) => boolean;
  canDisableCredential: (locator: DisableCredentialLocator) => boolean;
}

type IndexedTarget = {
  target: DisableCredentialTarget;
  displayName: string;
};

type ResolutionIndexes = {
  byAuthIndex: Map<string, IndexedTarget>;
  bySourceId: Map<string, IndexedTarget[]>;
};

const buildProviderDisplayName = (
  kind: ProviderKeyKind,
  apiKey: string,
  prefix?: string
) => `${prefix?.trim() || kind} (${maskApiKey(apiKey)})`;

const buildOpenAIDisplayName = (providerName: string, apiKey: string) =>
  `${providerName} (${maskApiKey(apiKey)})`;

const addSourceCandidates = (
  map: Map<string, IndexedTarget[]>,
  candidates: string[],
  entry: IndexedTarget
) => {
  candidates.forEach((candidate) => {
    if (!candidate) return;
    const bucket = map.get(candidate);
    if (bucket) {
      bucket.push(entry);
      return;
    }
    map.set(candidate, [entry]);
  });
};

const buildResolutionIndexes = (snapshot: CredentialDisableSnapshot | null): ResolutionIndexes => {
  const byAuthIndex = new Map<string, IndexedTarget>();
  const bySourceId = new Map<string, IndexedTarget[]>();

  if (!snapshot) {
    return { byAuthIndex, bySourceId };
  }

  snapshot.authFiles.forEach((file) => {
    const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
    if (!authIndex) return;
    byAuthIndex.set(authIndex, {
      target: {
        kind: 'auth_file',
        name: file.name,
        authIndex,
        displayName: file.name,
        disabled: file.disabled === true,
      },
      displayName: file.name,
    });
  });

  const providerKeyGroups: Array<{
    kind: ProviderKeyKind;
    items: Array<{ apiKey: string; prefix?: string; excludedModels?: string[] }>;
  }> = [
    { kind: 'gemini', items: snapshot.geminiKeys },
    { kind: 'codex', items: snapshot.codexConfigs },
    { kind: 'claude', items: snapshot.claudeConfigs },
    { kind: 'vertex', items: snapshot.vertexConfigs },
  ];

  providerKeyGroups.forEach(({ kind, items }) => {
    items.forEach((item) => {
      const apiKey = String(item.apiKey ?? '').trim();
      if (!apiKey) return;
      const indexedTarget: IndexedTarget = {
        target: {
          kind: 'provider_key',
          providerKind: kind,
          apiKey,
          prefix: item.prefix,
          displayName: buildProviderDisplayName(kind, apiKey, item.prefix),
          disabled:
            Array.isArray(item.excludedModels) &&
            item.excludedModels.some((model) => String(model ?? '').trim() === '*'),
        },
        displayName: buildProviderDisplayName(kind, apiKey, item.prefix),
      };

      addSourceCandidates(
        bySourceId,
        buildCandidateUsageSourceIds({ apiKey, prefix: item.prefix }),
        indexedTarget
      );
    });
  });

  const openAIProviderCounts = new Map<string, number>();
  const buildOpenAIProviderKey = (providerName: string, providerBaseUrl: string) =>
    `${providerName.toLowerCase()}||${providerBaseUrl.toLowerCase()}`;

  snapshot.openaiProviders.forEach((provider) => {
    const providerKey = buildOpenAIProviderKey(provider.name, provider.baseUrl);
    openAIProviderCounts.set(
      providerKey,
      (openAIProviderCounts.get(providerKey) ?? 0) + (provider.apiKeyEntries || []).length
    );
  });

  snapshot.disabledOpenAIEntries.forEach((entry) => {
    const providerKey = buildOpenAIProviderKey(entry.provider.name, entry.provider.baseUrl);
    openAIProviderCounts.set(providerKey, (openAIProviderCounts.get(providerKey) ?? 0) + 1);
  });

  const addOpenAITarget = (
    providerName: string,
    providerBaseUrl: string,
    providerPrefix: string | undefined,
    apiKey: string,
    disabled: boolean
  ) => {
    const providerKey = buildOpenAIProviderKey(providerName, providerBaseUrl);
    const indexedTarget: IndexedTarget = {
      target: {
        kind: 'openai_api_key_entry',
        providerName,
        providerBaseUrl,
        apiKey,
        displayName: buildOpenAIDisplayName(providerName, apiKey),
        disabled,
      },
      displayName: buildOpenAIDisplayName(providerName, apiKey),
    };

    addSourceCandidates(bySourceId, buildCandidateUsageSourceIds({ apiKey }), indexedTarget);

    if ((openAIProviderCounts.get(providerKey) ?? 0) === 1 && providerPrefix?.trim()) {
      addSourceCandidates(
        bySourceId,
        buildCandidateUsageSourceIds({ prefix: providerPrefix }),
        indexedTarget
      );
    }
  };

  snapshot.openaiProviders.forEach((provider) => {
    (provider.apiKeyEntries || []).forEach((entry) => {
      const apiKey = String(entry.apiKey ?? '').trim();
      if (!apiKey) return;
      addOpenAITarget(provider.name, provider.baseUrl, provider.prefix, apiKey, false);
    });
  });

  snapshot.disabledOpenAIEntries.forEach((entry) => {
    const apiKey = String(entry.entry.apiKey ?? '').trim();
    if (!apiKey) return;
    addOpenAITarget(
      entry.provider.name,
      entry.provider.baseUrl,
      entry.provider.prefix,
      apiKey,
      true
    );
  });

  return { byAuthIndex, bySourceId };
};

export function useDisableModel(_options: UseDisableModelOptions): UseDisableModelReturn {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const snapshot = useDisabledCredentialsStore((state) => state.snapshot);
  const refreshSnapshot = useDisabledCredentialsStore((state) => state.refreshSnapshot);
  const setTargetDisabledState = useDisabledCredentialsStore((state) => state.setTargetDisabledState);

  const [disableState, setDisableState] = useState<DisableState | null>(null);
  const [disabling, setDisabling] = useState(false);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  const indexes = useMemo(() => buildResolutionIndexes(snapshot), [snapshot]);

  const resolveTarget = useCallback(
    (locator: DisableCredentialLocator): IndexedTarget | null => {
      const authIndex = normalizeAuthIndex(locator.authIndex);
      if (authIndex) {
        const byAuthIndex = indexes.byAuthIndex.get(authIndex);
        if (byAuthIndex) return byAuthIndex;
      }

      const normalizedSource = normalizeUsageSourceId(locator.source);
      if (!normalizedSource) return null;
      const matches = indexes.bySourceId.get(normalizedSource) ?? [];
      return matches.length === 1 ? matches[0] : null;
    },
    [indexes]
  );

  const canDisableCredential = useCallback(
    (locator: DisableCredentialLocator) => resolveTarget(locator) !== null,
    [resolveTarget]
  );

  const isCredentialDisabled = useCallback(
    (locator: DisableCredentialLocator) => {
      const resolved = resolveTarget(locator);
      return resolved ? resolved.target.disabled : false;
    },
    [resolveTarget]
  );

  const handleDisableClick = useCallback(
    (locator: DisableCredentialLocator) => {
      const resolved = resolveTarget(locator);
      if (!resolved) return;

      setDisableState({
        target: resolved.target,
        displayName: locator.displayName || resolved.displayName,
        action: resolved.target.disabled ? 'restore' : 'disable',
      });
    },
    [resolveTarget]
  );

  const handleConfirmDisable = useCallback(async () => {
    if (!disableState) return;

    setDisabling(true);
    try {
      await setTargetDisabledState(
        disableState.target,
        disableState.action === 'disable'
      );
      showNotification(
        disableState.action === 'disable'
          ? t('monitor.credential_disable_success', { defaultValue: '已禁用当前 key/凭证' })
          : t('monitor.credential_restore_success', { defaultValue: '已恢复当前 key/凭证' }),
        'success'
      );
      setDisableState(null);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t('monitor.logs.disable_error');
      showNotification(message, 'error');
    } finally {
      setDisabling(false);
    }
  }, [disableState, setTargetDisabledState, showNotification, t]);

  const handleCancelDisable = useCallback(() => {
    setDisableState(null);
  }, []);

  return {
    disableState,
    disabling,
    handleDisableClick,
    handleConfirmDisable,
    handleCancelDisable,
    isCredentialDisabled,
    canDisableCredential,
  };
}
