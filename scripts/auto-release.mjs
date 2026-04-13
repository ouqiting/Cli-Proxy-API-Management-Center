import fs from 'fs';
import https from 'https';

const token = process.env.CODEX_GITHUB_PERSONAL_ACCESS_TOKEN;
const repo = 'ouqiting/Cli-Proxy-API-Management-Center';
const args = process.argv.slice(2);
const releaseTitle = args[0] || '默认更新';
const body = args[1] || releaseTitle;
const filePath = 'dist/management.html';

console.log(`[1] 开始发布流程. 目标仓库: ${repo}`);
console.log(`[2] 发布标题: ${releaseTitle}`);

if (!token) {
  console.error('错误: 未找到 CODEX_GITHUB_PERSONAL_ACCESS_TOKEN 环境变量');
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error(`错误: 找不到要上传的文件 ${filePath}，请先运行 npm run build`);
  process.exit(1);
}

function fetchGithub(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
    const options = {
      method,
      headers: {
        Authorization: `token ${token}`,
        'User-Agent': 'auto-release-script',
        Accept: 'application/vnd.github.v3+json',
      },
    };

    if (data && !(data instanceof Buffer)) {
      options.headers['Content-Type'] = 'application/json';
      data = JSON.stringify(data);
    } else if (data instanceof Buffer) {
      options.headers['Content-Type'] = 'text/html';
      options.headers['Content-Length'] = data.length;
    }

    const req = https.request(url, options, (res) => {
      let result = '';
      res.on('data', (chunk) => (result += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(result ? JSON.parse(result) : null);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${result}`));
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function run() {
  try {
    console.log('[3] 正在获取最新版本号...');
    let latest;
    try {
      latest = await fetchGithub('GET', `/repos/${repo}/releases/latest`);
      console.log(`- 当前最新版本为: ${latest.tag_name}`);
    } catch (e) {
      console.log('- 无法获取最新版本，可能还没有 Release');
    }

    let nextTag = 'v1.0.0';
    if (latest && latest.tag_name) {
      // 匹配诸如 v4.5.0 或 v4.5 的格式
      const match = latest.tag_name.match(/^v(\d+)\.(\d+)(?:\.(\d+))?$/);
      if (match) {
        // 次版本号（第二位）加 1，补全 0
        nextTag = `v${match[1]}.${parseInt(match[2]) + 1}.0`;
      } else {
        nextTag = `${latest.tag_name}-next`;
      }
    }

    console.log(`[4] 计算出的下一个版本号: ${nextTag}`);

    console.log(`[5] 正在创建新的 Release...`);
    const releaseData = {
      tag_name: nextTag,
      target_commitish: 'main',
      name: releaseTitle,
      body: body,
      draft: false,
      prerelease: false,
    };

    const release = await fetchGithub('POST', `/repos/${repo}/releases`, releaseData);
    console.log(`- Release 创建成功! ID: ${release.id}`);

    console.log(`[6] 准备上传文件: ${filePath}`);
    const fileBuffer = fs.readFileSync(filePath);
    // 替换上传URL里的占位符
    const uploadUrl = release.upload_url.replace('{?name,label}', '?name=management.html');

    console.log(`- 上传地址: ${uploadUrl}`);
    const upload = await fetchGithub('POST', uploadUrl, fileBuffer);

    console.log(`[7] 上传完成!`);
    console.log(`- 资源下载地址: ${upload.browser_download_url}`);
    console.log(`- Release 页面: ${release.html_url}`);
  } catch (error) {
    console.error('[错误]', error.message);
    process.exit(1);
  }
}

run();
