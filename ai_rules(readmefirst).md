# AGENTS.md

This file defines the required workflow for ai when working in this repository.

## Required Release Workflow

When Codex changes code in this repository, it must complete the following steps before finishing:

1. Read and follow `skills/github-release-minimal/SKILL.md` before any Release operation.
2. Run `npm run build` from the repository root.
3. Confirm the build succeeds.
4. Use the generated release asset at `dist/management.html`.
5. Upload that file to a GitHub Release for `ouqiting/Cli-Proxy-API-Management-Center`.
6. Set the Release title to a concise summary of the current update.

Do not skip the Release upload step after a code change.

## GitHub CLI Policy

For release operations in this repository:

1. Do not use `gh` CLI commands.
2. Use GitHub REST API only.
3. Follow `skills/github-release-minimal/SKILL.md` as the single source of truth for release commands.

## Versioning Rule

When creating a new Release:

1. Read the existing Releases or tags first.
2. Continue the existing version pattern already used by this repository.
3. Pick the next logical version number instead of inventing a different scheme.

If there is any ambiguity, prefer checking both the Release list and the tag list before publishing.

## Release Asset Rule

The file that must be uploaded is:

- `dist/management.html`

If `npm run build` regenerates both `dist/index.html` and `dist/management.html`, use `dist/management.html` as the Release asset.

## Release Title Rule

The Release title should summarize the update in one short sentence or phrase in chinese.

Examples:

- `增加手动更新 webui 和重启`
- `修复关闭动画`
- `完善查询逻辑`

Avoid generic titles such as `update`, `test`, or `fix` unless the actual change is genuinely that narrow.

## Practical Notes From Previous Uploads

### 1. This repository is a fork

GitHub repository search may not show this repository unless forked repositories are included.

If searching by repository name, remember that fork repositories may require `fork:true`.

### 2. Releases and tags are more reliable than repository search for version lookup

To determine the next version, checking Releases and tags is more reliable than relying on repository search results.

### 3. The upload target should come from the Release metadata

When uploading a Release asset, use the `upload_url` returned by the Release API.

That URL contains a template suffix like `{?name,label}` and must be converted into a real upload URL by replacing the template with a concrete query string such as `?name=management.html`.

### 4. Asset upload and Release creation are separate steps

Creating the Release does not automatically upload the build artifact.

After the Release is created, upload `dist/management.html` as a second step.

### 5. Keep a usable GitHub token available

A GitHub token with permission to create Releases and upload assets is required.

In previous successful uploads, `CODEX_GITHUB_PERSONAL_ACCESS_TOKEN` was available and worked for Release creation and asset upload.

## Default Completion Standard

A Codex task that changes repository code is not complete until all of the following are true:

1. The code changes are finished.
2. `npm run build` has been run successfully.
3. `dist/management.html` has been generated.
4. A new GitHub Release has been created or updated.
5. The generated `dist/management.html` has been uploaded to that Release.
6. The Release title summarizes the update.
