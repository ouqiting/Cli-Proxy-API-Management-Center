import { webuiDataApi } from '@/services/api';
import { LATEST_LOCAL_BACKUP_PATH, LOCAL_BACKUP_DIR, LOCAL_BACKUP_INDEX_PATH } from './constants';

export interface LocalBackupFileInfo {
  filename: string;
  size: number;
  createdAt: string;
}

interface LocalBackupIndex {
  version: 1;
  backups: LocalBackupFileInfo[];
}

const createEmptyIndex = (): LocalBackupIndex => ({
  version: 1,
  backups: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parseIndex = (raw: string): LocalBackupIndex => {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.backups)) {
    return createEmptyIndex();
  }

  const backups = parsed.backups
    .map((entry) => {
      if (!isRecord(entry) || typeof entry.filename !== 'string') {
        return null;
      }
      return {
        filename: entry.filename,
        size: Number.isFinite(Number(entry.size)) ? Math.max(0, Number(entry.size)) : 0,
        createdAt:
          typeof entry.createdAt === 'string' && entry.createdAt.trim()
            ? entry.createdAt
            : new Date().toISOString(),
      } satisfies LocalBackupFileInfo;
    })
    .filter((entry): entry is LocalBackupFileInfo => Boolean(entry))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return {
    version: 1,
    backups,
  };
};

async function readLocalBackupIndex(): Promise<LocalBackupIndex> {
  try {
    const raw = await webuiDataApi.readTextFile(LOCAL_BACKUP_INDEX_PATH);
    if (!raw.trim()) {
      return createEmptyIndex();
    }
    return parseIndex(raw);
  } catch (error) {
    if (webuiDataApi.isNotFoundError(error)) {
      return createEmptyIndex();
    }
    throw error;
  }
}

async function writeLocalBackupIndex(index: LocalBackupIndex): Promise<void> {
  await webuiDataApi.writeTextFile(LOCAL_BACKUP_INDEX_PATH, JSON.stringify(index, null, 2));
}

async function refreshLatestLocalBackup(index: LocalBackupIndex): Promise<void> {
  const latest = index.backups[0];
  if (!latest) {
    try {
      await webuiDataApi.deletePath(LATEST_LOCAL_BACKUP_PATH);
    } catch (error) {
      if (!webuiDataApi.isNotFoundError(error)) {
        throw error;
      }
    }
    return;
  }

  const latestContent = await webuiDataApi.readTextFile(`${LOCAL_BACKUP_DIR}/${latest.filename}`);
  await webuiDataApi.writeTextFile(LATEST_LOCAL_BACKUP_PATH, latestContent);
}

export async function saveLocalBackup(
  filename: string,
  payloadJson: string,
  maxBackupCount: number
): Promise<LocalBackupFileInfo[]> {
  const filePath = `${LOCAL_BACKUP_DIR}/${filename}`;
  await webuiDataApi.writeTextFile(filePath, payloadJson);
  await webuiDataApi.writeTextFile(LATEST_LOCAL_BACKUP_PATH, payloadJson);

  const index = await readLocalBackupIndex();
  const nextBackups = [
    {
      filename,
      size: new Blob([payloadJson]).size,
      createdAt: new Date().toISOString(),
    } satisfies LocalBackupFileInfo,
    ...index.backups.filter((entry) => entry.filename !== filename),
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const backupsToKeep = maxBackupCount > 0 ? nextBackups.slice(0, maxBackupCount) : nextBackups;
  const backupsToDelete =
    maxBackupCount > 0 ? nextBackups.slice(maxBackupCount) : ([] as LocalBackupFileInfo[]);

  for (const entry of backupsToDelete) {
    try {
      await webuiDataApi.deletePath(`${LOCAL_BACKUP_DIR}/${entry.filename}`);
    } catch (error) {
      if (!webuiDataApi.isNotFoundError(error)) {
        console.warn('[Local Backup] Failed to delete old backup:', entry.filename, error);
      }
    }
  }

  const nextIndex: LocalBackupIndex = {
    version: 1,
    backups: backupsToKeep,
  };
  await writeLocalBackupIndex(nextIndex);
  await refreshLatestLocalBackup(nextIndex);
  return nextIndex.backups;
}

export async function listLocalBackups(): Promise<LocalBackupFileInfo[]> {
  const index = await readLocalBackupIndex();
  return index.backups;
}

export async function readLocalBackup(filename: string): Promise<string> {
  return webuiDataApi.readTextFile(`${LOCAL_BACKUP_DIR}/${filename}`);
}

export async function deleteLocalBackup(filename: string): Promise<void> {
  try {
    await webuiDataApi.deletePath(`${LOCAL_BACKUP_DIR}/${filename}`);
  } catch (error) {
    if (!webuiDataApi.isNotFoundError(error)) {
      throw error;
    }
  }

  const index = await readLocalBackupIndex();
  const nextIndex: LocalBackupIndex = {
    version: 1,
    backups: index.backups.filter((entry) => entry.filename !== filename),
  };
  await writeLocalBackupIndex(nextIndex);
  await refreshLatestLocalBackup(nextIndex);
}
