const fs = require('fs');
const file = 'src/pages/AuthFilesPage.tsx';
let code = fs.readFileSync(file, 'utf8');

// 1. Imports
code = code.replace(
  "import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';",
  "import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';\nimport { webuiDataApi } from '@/services/api/webuiData';\nimport { downloadBlob } from '@/utils/download';"
);

// 2. Constants
code = code.replace(/const DEFAULT_KEY_COMMAND_COUNT = '20';\r?\n/, '');
code = code.replace(/const DEFAULT_KEY_COMMAND_CONCURRENCY = '10';\r?\n/, '');
code = code.replace(/type KeyCommandPlatform = 'linux' \| 'windows';\r?\n/, '');

// 3. States
code = code.replace(/\s*const \[keyCommandModalOpen, setKeyCommandModalOpen\] = useState\(false\);\r?\n/, '');
code = code.replace(/\s*const \[keyCommandPlatform, setKeyCommandPlatform\] = useState<KeyCommandPlatform>\('linux'\);\r?\n/, '');
code = code.replace(/\s*const \[keyCommandCount, setKeyCommandCount\] = useState\(DEFAULT_KEY_COMMAND_COUNT\);\r?\n/, '');
code = code.replace(/\s*const \[keyCommandConcurrency, setKeyCommandConcurrency\] = useState\(\s*DEFAULT_KEY_COMMAND_CONCURRENCY\s*\);\r?\n/, '');

// 4. normalizePositiveIntegerText and commands
const removeRegex = /\s*const normalizePositiveIntegerText = useCallback[\s\S]*?const keyCopyCommand = useMemo\(\s*\(\)[\s\S]*?'cp -a \/srv[\s\S]*?\],?\s*\);/;
code = code.replace(removeRegex, '');

// 5. Download Function
const downloadFunc = `
  const handleDownloadCodexConfig = useCallback(async () => {
    try {
      showNotification(t('auth_files.config_downloading', { defaultValue: '正在获取配置文件...' }), 'info');
      const [configToml, authJson] = await Promise.all([
        webuiDataApi.readTextFile('config/config.toml').catch(() => null),
        webuiDataApi.readTextFile('config/auth.json').catch(() => null)
      ]);

      if (configToml === null && authJson === null) {
        showNotification(t('auth_files.config_not_found', { defaultValue: '配置文件不存在' }), 'error');
        return;
      }

      if (configToml !== null) {
        downloadBlob({
          filename: 'config.toml',
          blob: new Blob([configToml], { type: 'text/plain' })
        });
      }

      if (authJson !== null) {
        setTimeout(() => {
          downloadBlob({
            filename: 'auth.json',
            blob: new Blob([authJson], { type: 'application/json' })
          });
        }, 300);
      }
      
      showNotification(t('auth_files.config_download_success', { defaultValue: '配置文件下载成功' }), 'success');
    } catch (e) {
      showNotification(t('auth_files.config_download_failed', { defaultValue: '下载配置文件失败' }), 'error');
    }
  }, [showNotification, t]);
`;
code = code.replace(/  const openExcludedEditor = useCallback\(/, downloadFunc + '\n  const openExcludedEditor = useCallback(');

// 6. Button
const oldButton = `<Button
              variant="secondary"
              size="sm"
              onClick={() => setKeyCommandModalOpen(true)}
            >
              {t('auth_files.key_command_button', { defaultValue: '获取密钥命令' })}
            </Button>`;
const newButton = `<Button
              variant="secondary"
              size="sm"
              onClick={handleDownloadCodexConfig}
            >
              {t('auth_files.download_codex_config', { defaultValue: '获取codex配置文件' })}
            </Button>`;
code = code.replace(oldButton, newButton);

// 7. Remove Modal
const modalRegex = /\s*<Modal[\s\S]*?open={keyCommandModalOpen}[\s\S]*?<\/Modal>/;
code = code.replace(modalRegex, '');

fs.writeFileSync(file, code);
console.log('Modifications applied');