import { parse as parseYaml, parseDocument } from 'yaml';
import { authFilesApi } from './authFiles';
import { configFileApi } from './configFile';
import { providersApi } from './providers';
import {
  normalizeApiKeyEntry,
  normalizeOpenAIProvider,
  normalizeModelAliases,
  normalizeHeaders,
} from './transformers';
import type {
  ApiKeyEntry,
  AuthFileItem,
  GeminiKeyConfig,
  ModelAlias,
  OpenAIProviderConfig,
  ProviderKeyConfig,
} from '@/types';

const DISABLE_ALL_MODELS_RULE = '*';
const OPENAI_DISABLE_REGISTRY_PATH = ['management-panel', 'disabled-openai-api-keys'] as const;

export type ProviderKeyKind = 'gemini' | 'codex' | 'claude' | 'vertex';

export interface DisabledOpenAIKeyProviderSnapshot {
  name: string;
  baseUrl: string;
  prefix?: string;
  headers?: Record<string, string>;
  models?: ModelAlias[];
  priority?: number;
  testModel?: string;
}

export interface DisabledOpenAIKeyRegistryEntry {
  provider: DisabledOpenAIKeyProviderSnapshot;
  entry: ApiKeyEntry;
  originalIndex: number;
  disabledAt: string;
}

export type DisableCredentialTarget =
  | {
      kind: 'auth_file';
      name: string;
      authIndex?: string | null;
      displayName: string;
      disabled: boolean;
    }
  | {
      kind: 'provider_key';
      providerKind: ProviderKeyKind;
      apiKey: string;
      prefix?: string;
      displayName: string;
      disabled: boolean;
    }
  | {
      kind: 'openai_api_key_entry';
      providerName: string;
      providerBaseUrl: string;
      apiKey: string;
      displayName: string;
      disabled: boolean;
    };

export interface CredentialDisableSnapshot {
  authFiles: AuthFileItem[];
  geminiKeys: GeminiKeyConfig[];
  codexConfigs: ProviderKeyConfig[];
  claudeConfigs: ProviderKeyConfig[];
  vertexConfigs: ProviderKeyConfig[];
  openaiProviders: OpenAIProviderConfig[];
  disabledOpenAIEntries: DisabledOpenAIKeyRegistryEntry[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const normalizeOpenAIBaseUrl = (baseUrl: string): string => {
  let trimmed = String(baseUrl || '').trim();
  if (!trimmed) return '';
  trimmed = trimmed.replace(/\/?v0\/management\/?$/i, '');
  trimmed = trimmed.replace(/\/+$/g, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `http://${trimmed}`;
  }
  return trimmed;
};

const stripDisableAllModelsRule = (models?: string[]) =>
  Array.isArray(models)
    ? models.filter((model) => String(model ?? '').trim() !== DISABLE_ALL_MODELS_RULE)
    : [];

const withDisableAllModelsRule = (models?: string[]) => {
  const base = stripDisableAllModelsRule(models);
  return [...base, DISABLE_ALL_MODELS_RULE];
};

const withoutDisableAllModelsRule = (models?: string[]) => stripDisableAllModelsRule(models);

const isProviderKeyDisabled = (models?: string[]) =>
  Array.isArray(models) &&
  models.some((model) => String(model ?? '').trim() === DISABLE_ALL_MODELS_RULE);

const serializeHeaders = (headers?: Record<string, string>) =>
  headers && Object.keys(headers).length ? headers : undefined;

const serializeModelAliases = (models?: ModelAlias[]) =>
  Array.isArray(models)
    ? models
        .map((model) => {
          if (!model?.name) return null;
          const payload: Record<string, unknown> = { name: model.name };
          if (model.alias && model.alias !== model.name) {
            payload.alias = model.alias;
          }
          if (model.priority !== undefined) {
            payload.priority = model.priority;
          }
          if (model.testModel) {
            payload['test-model'] = model.testModel;
          }
          return payload;
        })
        .filter(Boolean)
    : undefined;

const serializeApiKeyEntry = (entry: ApiKeyEntry) => {
  const payload: Record<string, unknown> = {
    'api-key': entry.apiKey,
  };
  if (entry.proxyUrl) {
    payload['proxy-url'] = entry.proxyUrl;
  }
  const headers = serializeHeaders(entry.headers);
  if (headers) {
    payload.headers = headers;
  }
  return payload;
};

const serializeOpenAIProvider = (provider: OpenAIProviderConfig) => {
  const payload: Record<string, unknown> = {
    name: provider.name,
    'base-url': provider.baseUrl,
    'api-key-entries': Array.isArray(provider.apiKeyEntries)
      ? provider.apiKeyEntries.map((entry) => serializeApiKeyEntry(entry))
      : [],
  };
  if (provider.prefix?.trim()) payload.prefix = provider.prefix.trim();
  const headers = serializeHeaders(provider.headers);
  if (headers) payload.headers = headers;
  const models = serializeModelAliases(provider.models);
  if (models && models.length) payload.models = models;
  if (provider.priority !== undefined) payload.priority = provider.priority;
  if (provider.testModel) payload['test-model'] = provider.testModel;
  return payload;
};

const serializeProviderSnapshot = (provider: DisabledOpenAIKeyProviderSnapshot) => {
  const payload: Record<string, unknown> = {
    name: provider.name,
    'base-url': provider.baseUrl,
  };
  if (provider.prefix?.trim()) payload.prefix = provider.prefix.trim();
  const headers = serializeHeaders(provider.headers);
  if (headers) payload.headers = headers;
  const models = serializeModelAliases(provider.models);
  if (models && models.length) payload.models = models;
  if (provider.priority !== undefined) payload.priority = provider.priority;
  if (provider.testModel) payload['test-model'] = provider.testModel;
  return payload;
};

const normalizeProviderSnapshot = (input: unknown): DisabledOpenAIKeyProviderSnapshot | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const name = String(record.name ?? '').trim();
  const baseUrl = String(record['base-url'] ?? record.baseUrl ?? '').trim();
  if (!name || !baseUrl) return null;

  const result: DisabledOpenAIKeyProviderSnapshot = {
    name,
    baseUrl: normalizeOpenAIBaseUrl(baseUrl),
  };

  const prefix = String(record.prefix ?? '').trim();
  if (prefix) result.prefix = prefix;
  const headers = normalizeHeaders(record.headers);
  if (headers) result.headers = headers;
  const models = normalizeModelAliases(record.models);
  if (models.length) result.models = models;

  const priorityRaw = record.priority;
  const priority =
    typeof priorityRaw === 'number'
      ? priorityRaw
      : typeof priorityRaw === 'string' && priorityRaw.trim()
        ? Number(priorityRaw)
        : undefined;
  if (priority !== undefined && Number.isFinite(priority)) {
    result.priority = priority;
  }

  const testModel = String(record['test-model'] ?? record.testModel ?? '').trim();
  if (testModel) result.testModel = testModel;

  return result;
};

const normalizeDisabledOpenAIRegistry = (input: unknown): DisabledOpenAIKeyRegistryEntry[] => {
  if (!Array.isArray(input)) return [];

  return input
    .map((entry) => {
      if (!isRecord(entry)) return null;

      const provider = normalizeProviderSnapshot(entry.provider);
      const apiKeyEntry = normalizeApiKeyEntry(entry.entry);
      const originalIndexRaw = entry['original-index'] ?? entry.originalIndex;
      const originalIndex =
        typeof originalIndexRaw === 'number'
          ? Math.max(0, Math.trunc(originalIndexRaw))
          : typeof originalIndexRaw === 'string' && originalIndexRaw.trim()
            ? Math.max(0, Math.trunc(Number(originalIndexRaw)))
            : 0;
      const disabledAt = String(entry['disabled-at'] ?? entry.disabledAt ?? '').trim();

      if (!provider || !apiKeyEntry) return null;

      return {
        provider,
        entry: apiKeyEntry,
        originalIndex,
        disabledAt: disabledAt || new Date().toISOString(),
      } satisfies DisabledOpenAIKeyRegistryEntry;
    })
    .filter(Boolean) as DisabledOpenAIKeyRegistryEntry[];
};

const getRawOpenAIProviders = (rawConfig: unknown): unknown[] => {
  if (!isRecord(rawConfig)) return [];
  const raw = rawConfig['openai-compatibility'] ?? rawConfig.openaiCompatibility;
  return Array.isArray(raw) ? raw : [];
};

const readDisabledOpenAIRegistryFromRawConfig = (
  rawConfig: unknown
): DisabledOpenAIKeyRegistryEntry[] => {
  if (!isRecord(rawConfig)) return [];
  const managementPanel = rawConfig['management-panel'] ?? rawConfig.managementPanel;
  if (!isRecord(managementPanel)) return [];
  const rawRegistry =
    managementPanel['disabled-openai-api-keys'] ??
    managementPanel.disabledOpenAIApiKeys;
  return normalizeDisabledOpenAIRegistry(rawRegistry);
};

const saveOpenAIConfigToYaml = async (
  yamlText: string,
  activeProviders: OpenAIProviderConfig[],
  disabledRegistry: DisabledOpenAIKeyRegistryEntry[]
) => {
  const doc = parseDocument(yamlText || '{}');
  if (doc.errors.length > 0) {
    throw new Error(doc.errors[0]?.message ?? 'Invalid YAML');
  }

  doc.setIn(['openai-compatibility'], activeProviders.map(serializeOpenAIProvider));

  if (disabledRegistry.length > 0) {
    doc.setIn(
      OPENAI_DISABLE_REGISTRY_PATH,
      disabledRegistry.map((entry) => ({
        provider: serializeProviderSnapshot(entry.provider),
        entry: serializeApiKeyEntry(entry.entry),
        'original-index': entry.originalIndex,
        'disabled-at': entry.disabledAt,
      }))
    );
  } else if (doc.hasIn(OPENAI_DISABLE_REGISTRY_PATH)) {
    doc.deleteIn(OPENAI_DISABLE_REGISTRY_PATH);
    if (doc.hasIn(['management-panel'])) {
      const managementPanel = doc.getIn(['management-panel'], true);
      if (managementPanel && typeof (managementPanel as { items?: unknown[] }).items !== 'undefined') {
        const items = (managementPanel as { items?: unknown[] }).items;
        if (Array.isArray(items) && items.length === 0) {
          doc.deleteIn(['management-panel']);
        }
      }
    }
  }

  await configFileApi.saveConfigYaml(String(doc));
};

const loadYamlOpenAIConfig = async () => {
  const yamlText = await configFileApi.fetchConfigYaml();
  const raw = parseYaml(yamlText || '{}');
  const activeProviders = getRawOpenAIProviders(raw)
    .map((item) => normalizeOpenAIProvider(item))
    .filter(Boolean) as OpenAIProviderConfig[];
  const disabledRegistry = readDisabledOpenAIRegistryFromRawConfig(raw);

  return {
    yamlText,
    activeProviders,
    disabledRegistry,
  };
};

export async function loadCredentialDisableSnapshot(): Promise<CredentialDisableSnapshot> {
  const [
    authFilesResponse,
    geminiKeys,
    codexConfigs,
    claudeConfigs,
    vertexConfigs,
    openaiProviders,
    yamlText,
  ] = await Promise.all([
    authFilesApi.list(),
    providersApi.getGeminiKeys(),
    providersApi.getCodexConfigs(),
    providersApi.getClaudeConfigs(),
    providersApi.getVertexConfigs(),
    providersApi.getOpenAIProviders(),
    configFileApi.fetchConfigYaml(),
  ]);

  const raw = parseYaml(yamlText || '{}');

  return {
    authFiles: authFilesResponse?.files || [],
    geminiKeys,
    codexConfigs,
    claudeConfigs,
    vertexConfigs,
    openaiProviders,
    disabledOpenAIEntries: readDisabledOpenAIRegistryFromRawConfig(raw),
  };
}

export async function setAuthFileDisabledState(name: string, disabled: boolean) {
  await authFilesApi.setStatus(name, disabled);
}

const updateProviderKeyList = <T extends ProviderKeyConfig | GeminiKeyConfig>(
  list: T[],
  apiKey: string,
  disabled: boolean
) =>
  list.map((item) => {
    if (item.apiKey !== apiKey) return item;
    return {
      ...item,
      excludedModels: disabled
        ? withDisableAllModelsRule(item.excludedModels)
        : withoutDisableAllModelsRule(item.excludedModels),
    } as T;
  });

export async function setProviderKeyDisabledState(
  providerKind: ProviderKeyKind,
  apiKey: string,
  disabled: boolean
) {
  if (providerKind === 'gemini') {
    const current = await providersApi.getGeminiKeys();
    const next = updateProviderKeyList(current, apiKey, disabled);
    await providersApi.saveGeminiKeys(next);
    return;
  }

  if (providerKind === 'codex') {
    const current = await providersApi.getCodexConfigs();
    const next = updateProviderKeyList(current, apiKey, disabled);
    await providersApi.saveCodexConfigs(next);
    return;
  }

  if (providerKind === 'claude') {
    const current = await providersApi.getClaudeConfigs();
    const next = updateProviderKeyList(current, apiKey, disabled);
    await providersApi.saveClaudeConfigs(next);
    return;
  }

  const current = await providersApi.getVertexConfigs();
  const next = updateProviderKeyList(current, apiKey, disabled);
  await providersApi.saveVertexConfigs(next);
}

const buildProviderSnapshot = (
  provider: OpenAIProviderConfig
): DisabledOpenAIKeyProviderSnapshot => ({
  name: provider.name,
  baseUrl: normalizeOpenAIBaseUrl(provider.baseUrl),
  prefix: provider.prefix,
  headers: provider.headers,
  models: provider.models,
  priority: provider.priority,
  testModel: provider.testModel,
});

export async function setOpenAIApiKeyEntryDisabledState(
  providerName: string,
  providerBaseUrl: string,
  apiKey: string,
  disabled: boolean
) {
  const normalizedBaseUrl = normalizeOpenAIBaseUrl(providerBaseUrl);
  const { yamlText, activeProviders, disabledRegistry } = await loadYamlOpenAIConfig();

  if (disabled) {
    const providerIndex = activeProviders.findIndex(
      (provider) =>
        provider.name === providerName &&
        normalizeOpenAIBaseUrl(provider.baseUrl) === normalizedBaseUrl
    );
    if (providerIndex < 0) {
      throw new Error('OpenAI provider not found');
    }

    const provider = activeProviders[providerIndex];
    const entryIndex = (provider.apiKeyEntries || []).findIndex((entry) => entry.apiKey === apiKey);
    if (entryIndex < 0) {
      return;
    }

    const entry = provider.apiKeyEntries[entryIndex];
    const nextProviders = [...activeProviders];
    const nextEntries = [...provider.apiKeyEntries];
    nextEntries.splice(entryIndex, 1);

    if (nextEntries.length > 0) {
      nextProviders[providerIndex] = {
        ...provider,
        apiKeyEntries: nextEntries,
      };
    } else {
      nextProviders.splice(providerIndex, 1);
    }

    const nextRegistry = [
      ...disabledRegistry.filter(
        (item) =>
          !(
            item.provider.name === providerName &&
            normalizeOpenAIBaseUrl(item.provider.baseUrl) === normalizedBaseUrl &&
            item.entry.apiKey === apiKey
          )
      ),
      {
        provider: buildProviderSnapshot(provider),
        entry,
        originalIndex: entryIndex,
        disabledAt: new Date().toISOString(),
      },
    ];

    await saveOpenAIConfigToYaml(yamlText, nextProviders, nextRegistry);
    return;
  }

  const registryIndex = disabledRegistry.findIndex(
    (item) =>
      item.provider.name === providerName &&
      normalizeOpenAIBaseUrl(item.provider.baseUrl) === normalizedBaseUrl &&
      item.entry.apiKey === apiKey
  );
  if (registryIndex < 0) {
    return;
  }

  const registryEntry = disabledRegistry[registryIndex];
  const nextRegistry = [...disabledRegistry];
  nextRegistry.splice(registryIndex, 1);

  const nextProviders = [...activeProviders];
  const providerIndex = nextProviders.findIndex(
    (provider) =>
      provider.name === registryEntry.provider.name &&
      normalizeOpenAIBaseUrl(provider.baseUrl) ===
        normalizeOpenAIBaseUrl(registryEntry.provider.baseUrl)
  );

  if (providerIndex >= 0) {
    const provider = nextProviders[providerIndex];
    const nextEntries = [...(provider.apiKeyEntries || [])];
    const existingIndex = nextEntries.findIndex((entry) => entry.apiKey === registryEntry.entry.apiKey);
    if (existingIndex === -1) {
      const insertIndex = Math.min(
        Math.max(0, registryEntry.originalIndex),
        nextEntries.length
      );
      nextEntries.splice(insertIndex, 0, registryEntry.entry);
    }
    nextProviders[providerIndex] = {
      ...provider,
      apiKeyEntries: nextEntries,
    };
  } else {
    const restoredProvider: OpenAIProviderConfig = {
      name: registryEntry.provider.name,
      baseUrl: registryEntry.provider.baseUrl,
      prefix: registryEntry.provider.prefix,
      headers: registryEntry.provider.headers,
      models: registryEntry.provider.models,
      priority: registryEntry.provider.priority,
      testModel: registryEntry.provider.testModel,
      apiKeyEntries: [registryEntry.entry],
    };
    nextProviders.push(restoredProvider);
  }

  await saveOpenAIConfigToYaml(yamlText, nextProviders, nextRegistry);
}

export { isProviderKeyDisabled };
