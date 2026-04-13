# AGENTS.md

This file defines the required workflow for AI when working in this repository.

## Required Release Workflow

When Codex changes code in this repository, it must complete the following steps before finishing:

1. Run `npm run build` from the repository root.
2. Confirm the build succeeds and `dist/management.html` is generated.
3. Run the automated release script to publish the changes to GitHub:
   ```bash
   node scripts/auto-release.mjs "Your Release Title" ["Optional Release Body"]
   ```
   _The release title should summarize the update in one short sentence or phrase in Chinese (e.g., "修复移动端UI及调整卡片位置")._
4. Verify the script outputs a successful upload message with the download URL.

## Automated Release Script Usage

The `scripts/auto-release.mjs` script handles version bumping (increments the minor version automatically), release creation, and asset uploading.

- **Usage**: `node scripts/auto-release.mjs "<title>" ["<body>"]`
- **Requirements**: Ensure the `CODEX_GITHUB_PERSONAL_ACCESS_TOKEN` environment variable is available.
- **Example**: `node scripts/auto-release.mjs "增加手动更新" "详细的更新说明..."`

---

## Fallback Manual Release Workflow

**Use these instructions ONLY if the `scripts/auto-release.mjs` script fails.**

1. Read and follow `skills/github-release-minimal/SKILL.md` before any manual Release operation.
2. Upload the generated `dist/management.html` file to a GitHub Release for `ouqiting/Cli-Proxy-API-Management-Center`.

### GitHub CLI Policy

1. Do not use `gh` CLI commands.
2. Use GitHub REST API only.
3. Follow `skills/github-release-minimal/SKILL.md` as the single source of truth for release commands.

### Versioning Rule

1. Read the existing Releases or tags first.
2. Continue the existing version pattern already used by this repository.
3. Pick the next logical version number instead of inventing a different scheme.

### Release Asset Rule

The file that must be uploaded is:

- `dist/management.html`

### Release Title Rule

The Release title should summarize the update in one short sentence or phrase in Chinese.
Examples:

- `增加手动更新 webui 和重启`
- `修复关闭动画`
- `完善查询逻辑`

### Practical Notes From Previous Uploads

1. **This repository is a fork**: GitHub repository search may not show this repository unless forked repositories are included.
2. **Releases and tags are more reliable than repository search for version lookup**.
3. **The upload target should come from the Release metadata**: Use the `upload_url` returned by the Release API and replace the `{?name,label}` template.
4. **Asset upload and Release creation are separate steps**.
5. **Keep a usable GitHub token available**: `CODEX_GITHUB_PERSONAL_ACCESS_TOKEN` is required.

## Default Completion Standard

A Codex task that changes repository code is not complete until all of the following are true:

1. The code changes are finished.
2. `npm run build` has been run successfully.
3. A new GitHub Release has been created (preferably via the auto-release script).
4. The generated `dist/management.html` has been uploaded to that Release.
5. The Release title summarizes the update.
