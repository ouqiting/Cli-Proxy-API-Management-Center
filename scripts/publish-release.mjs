import fs from 'fs';
import https from 'https';

const token = process.env.CODEX_GITHUB_PERSONAL_ACCESS_TOKEN;
const repo = 'ouqiting/Cli-Proxy-API-Management-Center';
const name = '修复移动端UI及调整Gemini CLI卡片位置';
const body =
  '修复手机端Codex凭证名称和按钮在一行导致的换行问题，并将Gemini CLI额度卡片移至Vercel额度下方。';
const filePath = 'dist/management.html';

async function fetch(url, options, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let result = '';
      res.on('data', (chunk) => (result += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(result));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${result}`));
        }
      });
    });
    req.on('error', reject);
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

async function getLatestRelease() {
  return fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Authorization: `token ${token}`,
      'User-Agent': 'node.js',
      Accept: 'application/vnd.github.v3+json',
    },
  });
}

async function run() {
  try {
    const latest = await getLatestRelease();
    let nextTag = 'v3.1.1';
    if (latest && latest.tag_name) {
      const match = latest.tag_name.match(/^v(\d+)\.(\d+)\.(\d+)$/);
      if (match) {
        nextTag = `v${match[1]}.${match[2]}.${parseInt(match[3]) + 1}`;
      }
    }

    console.log(`Creating release ${nextTag}...`);
    const release = await fetch(
      `https://api.github.com/repos/${repo}/releases`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          'User-Agent': 'node.js',
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
      },
      JSON.stringify({
        tag_name: nextTag,
        target_commitish: 'main',
        name: name,
        body: body,
        draft: false,
        prerelease: false,
      })
    );

    console.log(`Release created. ID: ${release.id}, Upload URL: ${release.upload_url}`);

    const uploadUrl = release.upload_url.replace('{?name,label}', '?name=management.html');
    console.log(`Uploading asset to ${uploadUrl}...`);

    const fileData = fs.readFileSync(filePath);

    const upload = await fetch(
      uploadUrl,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          'User-Agent': 'node.js',
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'text/html',
          'Content-Length': fileData.length,
        },
      },
      fileData
    );

    console.log('Upload complete. Asset URL:', upload.browser_download_url);
  } catch (error) {
    console.error('Error:', error);
  }
}

run();
