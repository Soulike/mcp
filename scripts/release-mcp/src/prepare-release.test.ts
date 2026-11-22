import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { prepareRelease } from './prepare-release.ts';

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function writeJson(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function withRepoAndBareOrigin(
  run: (paths: { repoDir: string; remoteDir: string }) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'mcp-release-prep-'));
  const remoteDir = join(rootDir, 'origin.git');
  const repoDir = join(rootDir, 'work');
  try {
    await mkdir(remoteDir);
    await mkdir(repoDir);
    git(remoteDir, ['init', '--bare']);
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['remote', 'add', 'origin', remoteDir]);
    await run({ repoDir, remoteDir });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

function commitAndPushMain(repoDir: string, message: string): void {
  git(repoDir, ['add', '-A']);
  git(repoDir, [
    '-c',
    'user.name=Test Runner',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    message,
  ]);
  git(repoDir, ['push', '-u', 'origin', 'main']);
}

const VALID_MANIFEST = {
  name: '@soulike/alpha-mcp',
  version: '0.1.0',
  repository: {
    type: 'git',
    url: 'https://github.com/Soulike/mcp.git',
    directory: 'servers/alpha-mcp',
  },
};

await describe('prepareRelease', async () => {
  await it('validates metadata, npm absence (404), and missing origin tag on main', async () => {
    await withRepoAndBareOrigin(async ({ repoDir }) => {
      await mkdir(join(repoDir, 'servers/alpha-mcp'), { recursive: true });
      await writeJson(
        join(repoDir, 'servers/alpha-mcp/package.json'),
        VALID_MANIFEST,
      );
      commitAndPushMain(repoDir, 'init');

      let checkedUrl: string | undefined;
      const stubFetch: typeof fetch = (input) => {
        checkedUrl =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      };

      const result = await prepareRelease({
        repoDir,
        packageDir: 'servers/alpha-mcp',
        ref: 'refs/heads/main',
        requireRef: 'refs/heads/main',
        fetchFn: stubFetch,
      });

      assert.equal(
        checkedUrl,
        'https://registry.npmjs.org/%40soulike%2Falpha-mcp/0.1.0',
      );
      assert.deepEqual(result, {
        name: '@soulike/alpha-mcp',
        version: '0.1.0',
        tag: 'alpha-mcp@0.1.0',
      });
    });
  });

  await it('rejects non-main refs, private packages, and invalid package-dir or repository', async () => {
    await withRepoAndBareOrigin(async ({ repoDir }) => {
      await mkdir(join(repoDir, 'servers/private-mcp'), { recursive: true });
      await writeJson(join(repoDir, 'servers/private-mcp/package.json'), {
        ...VALID_MANIFEST,
        name: '@soulike/private-mcp',
        private: true,
      });
      commitAndPushMain(repoDir, 'init');

      const stubFetch: typeof fetch = () =>
        Promise.resolve(new Response('Not Found', { status: 404 }));

      await assert.rejects(
        () =>
          prepareRelease({
            repoDir,
            packageDir: 'servers/private-mcp',
            ref: 'refs/heads/feat/other',
            requireRef: 'refs/heads/main',
            fetchFn: stubFetch,
          }),
        /refs\/heads\/main/,
      );

      await assert.rejects(
        () =>
          prepareRelease({
            repoDir,
            packageDir: '../escape',
            fetchFn: stubFetch,
          }),
        /Invalid package-dir/,
      );

      await assert.rejects(
        () =>
          prepareRelease({
            repoDir,
            packageDir: 'servers/private-mcp',
            fetchFn: stubFetch,
          }),
        /private package/,
      );
    });
  });

  await it('fails when the version already exists on npm, registry errors, or git tag exists on origin', async () => {
    await withRepoAndBareOrigin(async ({ repoDir }) => {
      await mkdir(join(repoDir, 'servers/alpha-mcp'), { recursive: true });
      await writeJson(
        join(repoDir, 'servers/alpha-mcp/package.json'),
        VALID_MANIFEST,
      );
      commitAndPushMain(repoDir, 'init');

      await assert.rejects(
        () =>
          prepareRelease({
            repoDir,
            packageDir: 'servers/alpha-mcp',
            fetchFn: () => Promise.resolve(new Response('{}', { status: 200 })),
          }),
        /already published on npm/,
      );

      await assert.rejects(
        () =>
          prepareRelease({
            repoDir,
            packageDir: 'servers/alpha-mcp',
            fetchFn: () =>
              Promise.resolve(new Response('Server Error', { status: 503 })),
          }),
        /Unexpected npm registry status 503/,
      );

      git(repoDir, ['tag', 'alpha-mcp@0.1.0']);
      git(repoDir, ['push', 'origin', 'alpha-mcp@0.1.0']);

      await assert.rejects(
        () =>
          prepareRelease({
            repoDir,
            packageDir: 'servers/alpha-mcp',
            fetchFn: () =>
              Promise.resolve(new Response('Not Found', { status: 404 })),
          }),
        /already exists on origin/,
      );
    });
  });
});
