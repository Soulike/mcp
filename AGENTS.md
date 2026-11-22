# AGENTS.md

Monorepo for publishable Model Context Protocol (MCP) servers (`@soulike/*-mcp`) built with pnpm workspaces, Node.js `>=24`, TypeScript, ESLint, and Prettier.

## Repository Boundaries

- `servers/*`: Individual MCP servers. Publishable servers are named `@soulike/<name>-mcp` with a `bin` entry for `npx`.
- `packages/*`: Internal shared packages (`@repo/*`, `"private": true`).
- `configs/tsconfig`: `@repo/tsconfig` (`"private": true`), exporting `@repo/tsconfig/node.json` (base Node config for libraries and scripts) and `@repo/tsconfig/mcp-server.json` (extends `node.json` with `declaration`, `declarationMap`, and `sourceMap` disabled for CLI MCP server packages). Extend `@repo/tsconfig/*` in workspace `tsconfig.json` files instead of using relative `../../` paths.
- `scripts/*`: Internal repository automation and CI scripts (`@repo/*`, `"private": true`).
- Root owns `eslint.config.mjs`, `pnpm-workspace.yaml`, `.prettierignore`, and root `package.json` (`prettier`, `commitlint`, `lint-staged`). Keep workspace packages free of local `eslint.config.*` files so the root flat config remains the single final layer.

## Toolchain and Dependency Policies

- Use `pnpm` (`^12.0.0`) for installing dependencies and running workspace scripts; do not generate `package-lock.json` or `yarn.lock`.
- Support the previous and current Node.js LTS release lines (currently Node 24 and 26). When the two-LTS window advances, update `engines.node` in package manifests, `@types/node` in `pnpm-workspace.yaml` `catalog:`, `target`/`lib` in `configs/tsconfig/node.json` to match the older supported LTS, the `matrix.node-version` list in `.github/workflows/ci.yml`, and the minimum Node version in `README.md`.
- Manage shared dependency versions in `pnpm-workspace.yaml` under `catalog:` and reference `"catalog:"` in workspace manifests.
- `minimumReleaseAge: 10080` (7 days) is enforced in `pnpm-workspace.yaml`. When adding or upgrading dependencies, select versions published at least 7 days ago rather than relaxing the policy unless explicitly approved.
- `typescript` is pinned to `~6.0.3` because `typescript-eslint` v8 (`<6.1.0` peer range) does not yet support TypeScript 7 typed linting. Keep TypeScript on 6.0.x until `typescript-eslint` supports 7.x.
- Keep ESLint at its default single-threaded concurrency (`--concurrency=off`) unless CI measurements justify a fixed worker count.

## TypeScript and Node Native Execution

- Node.js 24+ runs `.ts` tests natively (`node --test "src/**/*.test.ts"`). Write code compatible with `erasableSyntaxOnly` and `verbatimModuleSyntax` (`import type` / `export type`), and use `.ts` extensions on relative imports (`rewriteRelativeImportExtensions` rewrites them to `.js` in `dist/`).
- Keep `tsconfig.json` covering `src` (including `*.test.ts` for `tsc --noEmit` and ESLint `projectService`), and keep `tsconfig.build.json` extending `./tsconfig.json` with `src/**/*.test.ts` excluded so test artifacts are not emitted to `dist/`.

## Scaffolding and Verification

- To create a new MCP server under `servers/<name>-mcp`, follow an existing server layout (such as `servers/deepseek-web-mcp`), set `"name": "@soulike/<name>-mcp"`, its `bin` entry, `"repository"` (`https://github.com/Soulike/mcp.git` + `"directory": "servers/<name>-mcp"`), and initial Semver `"version"` in `package.json`, add its user guide at `servers/<name>-mcp/README.md`, list it in the root `README.md`, and add `.github/workflows/release-<name>-mcp.yml` calling `./.github/workflows/release-mcp.yml`.
- **Releasing to npm (OIDC Trusted Publishing)**: Trigger `.github/workflows/release-<name>-mcp.yml` via `workflow_dispatch` on `main` (which runs `pnpm verify`, packs the tarball, publishes with npm OIDC + automatic provenance, and creates a `<name>-mcp@<version>` tag + GitHub Release). Because npm requires a package to exist before configuring Trusted Publishing, publish a brand-new package's first release manually once (`pnpm --filter @soulike/<name>-mcp pack --pack-destination /tmp/npm-init && (cd /tmp/npm-init && npm publish ./*.tgz --access public)`), configure the GitHub Actions Trusted Publisher on npmjs.com (workflow filename `release-<name>-mcp.yml`, `npm publish` allowed), and run the workflow within 48 hours.
- **Single source of truth for version**: Each MCP server's `package.json` `version` is its sole version source. Read it at runtime via `readFileSync(new URL('../package.json', import.meta.url), 'utf8')` rather than duplicating version constants in `src/`.
- **Semver bump policy**: Whenever modifying non-test files (`src/` excluding `src/**/*.test.ts`, `package.json`, `README.md`, or build configs) in a publishable (`"private"` omitted / not `true`) `servers/<name>-mcp` package, bump its `package.json` `version` according to Semver:
  - Under `0.x`: bump `patch` (`0.1.0 -> 0.1.1`) for bug fixes, docs, or backwards-compatible adjustments; bump `minor` (`0.1.0 -> 0.2.0`) for new features or breaking changes.
  - Under `>=1.0.0`: bump `patch` for backwards-compatible fixes/docs, `minor` for backwards-compatible additions (new tools or optional fields), and `major` for breaking changes (renamed/removed tools, new required inputs, or breaking output changes).
  - CI enforces strict Semver progression on publishable `servers/*` packages via `version_check` in `.github/workflows/ci.yml` (`scripts/check-server-versions`).
- Git hooks (`husky`) run `lint-staged` (`eslint --max-warnings 0`, `prettier --ignore-unknown --check`) on `pre-commit` and `commitlint` (`@commitlint/config-conventional`) on `commit-msg`. Commit through the hooks rather than bypassing with `--no-verify`.
- Run `pnpm verify` before finishing changes (runs `format:check`, `lint`, `typecheck`, `build`, and `test`).
- When changing publishable `files`, `bin`, or `exports`, also inspect `pnpm --filter <pkg> pack --pack-destination /tmp`.

## Agent skills

### Issue tracker

GitHub Issues in `Soulike/mcp` via `gh` CLI (PRs as a request surface: off). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root, created lazily when needed). See `docs/agents/domain.md`.
