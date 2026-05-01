import type { ApiKeyRoutingStrategy, RoutingStrategy } from '@/types/visualConfig';
import { buildCandidateUsageSourceIds } from '@/utils/usage';

export const API_KEY_NOTE_MAX_LENGTH = 20;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function extractApiKeyValue(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
  }

  const record = asRecord(raw);
  if (!record) return null;

  const candidates = [record['api-key'], record.apiKey, record.key, record.Key];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
    }
  }

  return null;
}

export function normalizeModelNameList(raw: unknown): string[] {
  const rawList = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]+/) : [];
  const seen = new Set<string>();
  const models: string[] = [];

  for (const item of rawList) {
    const trimmed = String(item ?? '').trim();
    if (!trimmed) continue;
    const dedupeKey = trimmed.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    models.push(trimmed);
  }

  return models;
}

export function normalizeRoutingStrategy(raw: unknown): RoutingStrategy {
  return raw === 'fill-first' ? 'fill-first' : 'round-robin';
}

export function normalizeOptionalRoutingStrategy(raw: unknown): ApiKeyRoutingStrategy {
  if (raw === 'round-robin' || raw === 'fill-first') return raw;
  return '';
}

export function normalizeApiKeyNote(raw: unknown): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return Array.from(trimmed).slice(0, API_KEY_NOTE_MAX_LENGTH).join('');
}

export type ApiKeySettingsEntry = {
  apiKey: string;
  disabledModels: string[];
  strategy: ApiKeyRoutingStrategy;
  disableLogging: boolean;
  note: string;
};

export function normalizeApiKeySettingsEntries(raw: unknown): ApiKeySettingsEntry[] {
  if (!Array.isArray(raw)) return [];

  const entries: ApiKeySettingsEntry[] = [];
  for (const item of raw) {
    const apiKey = extractApiKeyValue(item);
    if (!apiKey) continue;

    const record = asRecord(item);
    entries.push({
      apiKey,
      disabledModels: normalizeModelNameList(record?.['disabled-models'] ?? record?.disabledModels),
      strategy: normalizeOptionalRoutingStrategy(record?.strategy),
      disableLogging: record?.['disable-logging'] === true || record?.disableLogging === true,
      note: normalizeApiKeyNote(record?.note),
    });
  }

  return entries;
}

export function normalizeLegacyApiKeyModelEntries(
  raw: unknown
): Array<Pick<ApiKeySettingsEntry, 'apiKey' | 'disabledModels'>> {
  if (!Array.isArray(raw)) return [];

  const entries: Array<Pick<ApiKeySettingsEntry, 'apiKey' | 'disabledModels'>> = [];
  for (const item of raw) {
    const apiKey = extractApiKeyValue(item);
    if (!apiKey) continue;

    const record = asRecord(item);
    const disabledModels = normalizeModelNameList(
      record?.['disabled-models'] ?? record?.disabledModels
    );
    if (disabledModels.length === 0) continue;
    entries.push({ apiKey, disabledModels });
  }

  return entries;
}

export function shouldPersistApiKeySettingsEntry(entry: ApiKeySettingsEntry): boolean {
  return (
    entry.disabledModels.length > 0 ||
    Boolean(entry.strategy) ||
    entry.disableLogging === true ||
    entry.note.trim().length > 0
  );
}

export function collectConfiguredDisabledModelNames(rawConfig: unknown): string[] {
  const raw = asRecord(rawConfig);
  if (!raw) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  const addNames = (items: string[]) => {
    items.forEach((item) => {
      const trimmed = String(item ?? '').trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      names.push(trimmed);
    });
  };

  normalizeApiKeySettingsEntries(raw['api-key-settings']).forEach((entry) => {
    addNames(entry.disabledModels);
  });
  normalizeLegacyApiKeyModelEntries(raw['api-key-models']).forEach((entry) => {
    addNames(entry.disabledModels);
  });

  return names;
}

export function collectLoggingDisabledSourceIds(rawConfig: unknown): Set<string> {
  const raw = asRecord(rawConfig);
  const ids = new Set<string>();
  if (!raw) return ids;

  normalizeApiKeySettingsEntries(raw['api-key-settings']).forEach((entry) => {
    if (!entry.disableLogging) return;
    buildCandidateUsageSourceIds({ apiKey: entry.apiKey }).forEach((id) => ids.add(id));
  });

  return ids;
}

export function collectLoggingDisabledApiKeys(rawConfig: unknown): Set<string> {
  const raw = asRecord(rawConfig);
  const keys = new Set<string>();
  if (!raw) return keys;

  normalizeApiKeySettingsEntries(raw['api-key-settings']).forEach((entry) => {
    if (entry.disableLogging && entry.apiKey) {
      keys.add(entry.apiKey);
    }
  });

  return keys;
}
