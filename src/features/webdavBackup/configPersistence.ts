import { isMap, parse as parseYaml, parseDocument } from 'yaml';
import { configFileApi } from '@/services/api/configFile';
import { secureStorage } from '@/services/storage/secureStorage';
import type {
  AutoBackupInterval,
  BackupScope,
  WebdavConnectionConfig,
} from './types';
import {
  AUTO_BACKUP_INTERVALS,
  DEFAULT_BASE_PATH,
  DEFAULT_MAX_BACKUP_COUNT,
  WEBDAV_STORE_KEY,
} from './constants';
import { normalizeDavPath, normalizeServerUrl } from './utils';

const MANAGEMENT_CENTER_PATH = ['management-center'] as const;
const WEBDAV_BACKUP_PATH = [...MANAGEMENT_CENTER_PATH, 'webdav-backup'] as const;

export interface PersistedWebdavSettings {
  connection: WebdavConnectionConfig;
  backupScope: BackupScope;
  autoBackupEnabled: boolean;
  autoBackupInterval: AutoBackupInterval;
  maxBackupCount: number;
  lastBackupTime: string | null;
}

export const DEFAULT_PERSISTED_WEBDAV_SETTINGS: PersistedWebdavSettings = {
  connection: {
    serverUrl: '',
    username: '',
    password: '',
    basePath: DEFAULT_BASE_PATH,
  },
  backupScope: {
    localStorage: true,
    config: false,
    usage: true,
  },
  autoBackupEnabled: false,
  autoBackupInterval: '24h',
  maxBackupCount: DEFAULT_MAX_BACKUP_COUNT,
  lastBackupTime: null,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function ensureMapInDoc(doc: ReturnType<typeof parseDocument>, path: readonly string[]): void {
  const existing = doc.getIn(path, true);
  if (isMap(existing)) return;
  doc.setIn(path, doc.createNode({}));
}

function normalizeInterval(value: unknown): AutoBackupInterval {
  return AUTO_BACKUP_INTERVALS.some((item) => item.value === value)
    ? (value as AutoBackupInterval)
    : DEFAULT_PERSISTED_WEBDAV_SETTINGS.autoBackupInterval;
}

function normalizeMaxBackupCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PERSISTED_WEBDAV_SETTINGS.maxBackupCount;
  return Math.max(0, Math.trunc(parsed));
}

function normalizeConnection(raw: Record<string, unknown> | null): WebdavConnectionConfig {
  const defaults = DEFAULT_PERSISTED_WEBDAV_SETTINGS.connection;
  const serverUrl = typeof raw?.['server-url'] === 'string'
    ? raw['server-url']
    : typeof raw?.serverUrl === 'string'
      ? raw.serverUrl
      : defaults.serverUrl;
  const username = typeof raw?.username === 'string' ? raw.username : defaults.username;
  const password = typeof raw?.password === 'string' ? raw.password : defaults.password;
  const basePath = typeof raw?.['base-path'] === 'string'
    ? raw['base-path']
    : typeof raw?.basePath === 'string'
      ? raw.basePath
      : defaults.basePath;

  return {
    serverUrl: normalizeServerUrl(serverUrl),
    username,
    password,
    basePath: normalizeDavPath(basePath || DEFAULT_BASE_PATH),
  };
}

function normalizeBackupScope(raw: Record<string, unknown> | null): BackupScope {
  const defaults = DEFAULT_PERSISTED_WEBDAV_SETTINGS.backupScope;
  return {
    localStorage: Boolean(raw?.['local-storage'] ?? raw?.localStorage ?? defaults.localStorage),
    config: Boolean(raw?.config ?? defaults.config),
    usage: Boolean(raw?.usage ?? defaults.usage),
  };
}

export function normalizePersistedWebdavSettings(
  raw: Partial<PersistedWebdavSettings> | Record<string, unknown> | null | undefined
): PersistedWebdavSettings {
  const record = asRecord(raw);
  const connection = normalizeConnection(
    asRecord(record?.connection) ?? asRecord((raw as Partial<PersistedWebdavSettings>)?.connection)
  );
  const backupScope = normalizeBackupScope(
    asRecord(record?.['backup-scope']) ??
      asRecord(record?.backupScope) ??
      asRecord((raw as Partial<PersistedWebdavSettings>)?.backupScope)
  );

  const autoBackupEnabled =
    typeof record?.['auto-backup-enabled'] === 'boolean'
      ? record['auto-backup-enabled']
      : typeof record?.autoBackupEnabled === 'boolean'
        ? record.autoBackupEnabled
        : Boolean((raw as Partial<PersistedWebdavSettings>)?.autoBackupEnabled ?? false);

  const autoBackupInterval = normalizeInterval(
    record?.['auto-backup-interval'] ??
      record?.autoBackupInterval ??
      (raw as Partial<PersistedWebdavSettings>)?.autoBackupInterval
  );

  const maxBackupCount = normalizeMaxBackupCount(
    record?.['max-backup-count'] ??
      record?.maxBackupCount ??
      (raw as Partial<PersistedWebdavSettings>)?.maxBackupCount
  );

  const lastBackupTimeRaw =
    record?.['last-backup-time'] ??
    record?.lastBackupTime ??
    (raw as Partial<PersistedWebdavSettings>)?.lastBackupTime;
  const lastBackupTime = typeof lastBackupTimeRaw === 'string' && lastBackupTimeRaw.trim()
    ? lastBackupTimeRaw
    : null;

  return {
    connection,
    backupScope,
    autoBackupEnabled,
    autoBackupInterval,
    maxBackupCount,
    lastBackupTime,
  };
}

export async function loadWebdavSettingsFromConfig(): Promise<{
  settings: PersistedWebdavSettings;
  exists: boolean;
}> {
  const yamlText = await configFileApi.fetchConfigYaml();
  const parsed = asRecord(parseYaml(yamlText || '{}'));
  const managementCenter = asRecord(parsed?.['management-center']);
  const webdavBackup = asRecord(managementCenter?.['webdav-backup']);

  if (!webdavBackup) {
    return {
      settings: { ...DEFAULT_PERSISTED_WEBDAV_SETTINGS },
      exists: false,
    };
  }

  return {
    settings: normalizePersistedWebdavSettings(webdavBackup),
    exists: true,
  };
}

export async function saveWebdavSettingsToConfig(
  settings: PersistedWebdavSettings
): Promise<void> {
  const yamlText = await configFileApi.fetchConfigYaml();
  const doc = parseDocument(yamlText || '{}');

  if (doc.errors.length > 0) {
    throw new Error(doc.errors[0]?.message ?? 'Invalid config.yaml');
  }

  if (!isMap(doc.contents)) {
    doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
  }

  ensureMapInDoc(doc, MANAGEMENT_CENTER_PATH);
  ensureMapInDoc(doc, WEBDAV_BACKUP_PATH);
  ensureMapInDoc(doc, [...WEBDAV_BACKUP_PATH, 'connection']);
  ensureMapInDoc(doc, [...WEBDAV_BACKUP_PATH, 'backup-scope']);

  doc.setIn([...WEBDAV_BACKUP_PATH, 'connection', 'server-url'], settings.connection.serverUrl);
  doc.setIn([...WEBDAV_BACKUP_PATH, 'connection', 'username'], settings.connection.username);
  doc.setIn([...WEBDAV_BACKUP_PATH, 'connection', 'password'], settings.connection.password);
  doc.setIn([...WEBDAV_BACKUP_PATH, 'connection', 'base-path'], settings.connection.basePath);

  doc.setIn(
    [...WEBDAV_BACKUP_PATH, 'backup-scope', 'local-storage'],
    settings.backupScope.localStorage
  );
  doc.setIn([...WEBDAV_BACKUP_PATH, 'backup-scope', 'config'], settings.backupScope.config);
  doc.setIn([...WEBDAV_BACKUP_PATH, 'backup-scope', 'usage'], settings.backupScope.usage);

  doc.setIn([...WEBDAV_BACKUP_PATH, 'auto-backup-enabled'], settings.autoBackupEnabled);
  doc.setIn([...WEBDAV_BACKUP_PATH, 'auto-backup-interval'], settings.autoBackupInterval);
  doc.setIn([...WEBDAV_BACKUP_PATH, 'max-backup-count'], settings.maxBackupCount);

  if (settings.lastBackupTime) {
    doc.setIn([...WEBDAV_BACKUP_PATH, 'last-backup-time'], settings.lastBackupTime);
  } else if (doc.hasIn([...WEBDAV_BACKUP_PATH, 'last-backup-time'])) {
    doc.deleteIn([...WEBDAV_BACKUP_PATH, 'last-backup-time']);
  }

  await configFileApi.saveConfigYaml(
    doc.toString({ indent: 2, lineWidth: 120, minContentWidth: 0 })
  );
}

export function readLegacyWebdavSettings(): PersistedWebdavSettings | null {
  const legacy = secureStorage.getItem<unknown>(WEBDAV_STORE_KEY);
  const record = asRecord(legacy);
  const candidate = asRecord(record?.state) ?? record;
  if (!candidate) return null;

  const hasKnownField =
    Object.prototype.hasOwnProperty.call(candidate, 'connection') ||
    Object.prototype.hasOwnProperty.call(candidate, 'backupScope') ||
    Object.prototype.hasOwnProperty.call(candidate, 'backup-scope') ||
    Object.prototype.hasOwnProperty.call(candidate, 'autoBackupEnabled') ||
    Object.prototype.hasOwnProperty.call(candidate, 'auto-backup-enabled');

  return hasKnownField ? normalizePersistedWebdavSettings(candidate) : null;
}

export function clearLegacyWebdavSettings(): void {
  secureStorage.removeItem(WEBDAV_STORE_KEY);
}
