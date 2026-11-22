# AGENTS.md

Monorepo for publishable Model Context Protocol (MCP) servers (`@soulike/*-mcp`) built with pnpm workspaces, Node.js `>=24`, TypeScript, ESLint, and Prettier.

## Repository Boundaries

- `servers/*`: Individual MCP servers. Publishable servers are named `@soulike/<name>-mcp` with a `bin` entry for `npx`. `servers/template-mcp` is `"private": true` and serves as the reference starter and verification package.
- `packages/*`: Internal shared packages (`@repo/*`, `"private": true`).
- `configs/tsconfig`: `@repo/tsconfig` (`"private": true`), exporting `@repo/tsconfig/node.json`. Extend `@repo/tsconfig/node.json` in workspace `tsconfig.json` files instead of using relative `../../` paths.
- Root owns `eslint.config.mjs`, `pnpm-workspace.yaml`, `.prettierignore`, and root `package.json` (`prettier`, `commitlint`, `lint-staged`). Keep workspace packages free of local `eslint.config.*` files so the root flat config remains the single final layer.

## Toolchain and Dependency Policies

- Use `pnpm` exclusively (`devEngines.packageManager` pins `pnpm@12.21.0`; `npm` and `yarn` will fail).
- Manage shared dependency versions in `pnpm-workspace.yaml` under `catalog:` and reference `"catalog:"` in workspace manifests.
- `minimumReleaseAge: 10080` (7 days) is enforced in `pnpm-workspace.yaml`. When adding or upgrading dependencies, select versions published at least 7 days ago rather than relaxing the policy unless explicitly approved.
- `typescript` is pinned to `~6.0.3` because `typescript-eslint` v8 (`<6.1.0` peer range) does not yet support TypeScript 7 typed linting. Keep TypeScript on 6.0.x until `typescript-eslint` supports 7.x.
- Keep ESLint at its default single-threaded concurrency (`--concurrency=off`) unless CI measurements justify a fixed worker count.

## TypeScript and Node Native Execution

- Node.js 24+ runs `.ts` tests natively (`node --test "src/**/*.test.ts"`). Write code compatible with `erasableSyntaxOnly` and `verbatimModuleSyntax` (`import type` / `export type`), and use `.ts` extensions on relative imports (`rewriteRelativeImportExtensions` rewrites them to `.js` in `dist/`).
- Keep `tsconfig.json` covering `src` (including `*.test.ts` for `tsc --noEmit` and ESLint `projectService`), and keep `tsconfig.build.json` extending `./tsconfig.json` with `src/**/*.test.ts` excluded so test artifacts are not emitted to `dist/`.

## Scaffolding and Verification

- To create a new MCP server, copy `servers/template-mcp`, set `"name": "@soulike/<name>-mcp"` and its `bin` entry (removing `"private": true` when ready to publish), add its user guide at `servers/<name>-mcp/README.md`, and list it in the root `README.md`.
- Git hooks (`husky`) run `lint-staged` (`eslint --max-warnings 0`, `prettier --ignore-unknown --check`) on `pre-commit` and `commitlint` (`@commitlint/config-conventional`) on `commit-msg`. Commit through the hooks rather than bypassing with `--no-verify`.
- Run before finishing changes:
  - `pnpm format:check`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm build`
  - `pnpm test`
- When changing publishable `files`, `bin`, or `exports`, also inspect `pnpm --filter <pkg> pack --pack-destination /tmp`.
