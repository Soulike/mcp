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

function getRequestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
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

function commitAndPushMain(repoDir: string, message: string): string {
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
  return git(repoDir, ['rev-parse', 'HEAD']);
}

const VALID_MANIFEST = {
  name: '@soulike/alpha-mcp',
  version: '0.1.0',
  repository: {
    type: 'git',
    url: 'git+https://github.com/Soulike/mcp.git',
    directory: 'servers/alpha-mcp',
  },
};

function createProvenancePayload(gitCommit: string): string {
  const dssePayload = Buffer.from(
    JSON.stringify({
      predicate: {
        buildDefinition: {
          resolvedDependencies: [
            {
              uri: 'git+https://github.com/Soulike/mcp@refs/heads/main',
              digest: { gitCommit },
            },
          ],
        },
      },
    }),
    'utf8',
  ).toString('base64');

  return JSON.stringify({
    attestations: [
      {
        predicateType: 'https://slsa.dev/provenance/v1',
        bundle: {
          dsseEnvelope: {
            payload: dssePayload,
          },
        },
      },
    ],
  });
}

function createStubFetch(options: {
  npmStatus: number;
  githubReleaseStatus: number;
  provenanceStatus?: number | undefined;
  provenanceCommit?: string | undefined;
  seenUrls?: string[] | undefined;
}): typeof fetch {
  return (input) => {
    const url = getRequestUrl(input);
    options.seenUrls?.push(url);
    if (url.startsWith('https://registry.npmjs.org/-/npm/v1/attestations/')) {
      const status = options.provenanceStatus ?? 200;
      const body =
        status === 200 && options.provenanceCommit !== undefined
          ? createProvenancePayload(options.provenanceCommit)
          : '{}';
      return Promise.resolve(new Response(body, { status }));
    }
    if (url.startsWith('https://registry.npmjs.org/')) {
      return Promise.resolve(new Response('{}', { status: options.npmStatus }));
    }
    if (url.startsWith('https://api.github.com/repos/Soulike/mcp/releases/')) {
      return Promise.resolve(
        new Response('{}', { status: options.githubReleaseStatus }),
      );
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  };
}

await describe('prepareRelease', async () => {
  await it('validates metadata, npm absence (404), and missing origin tag/release on main', async () => {
    await withRepoAndBareOrigin(async ({ repoDir }) => {
      await mkdir(join(repoDir, 'servers/alpha-mcp'), { recursive: true });
      await writeJson(
        join(repoDir, 'servers/alpha-mcp/package.json'),
        VALID_MANIFEST,
      );
      commitAndPushMain(repoDir, 'init');

      const seenUrls: string[] = [];
      const result = await prepareRelease({
        repoDir,
        packageDir: 'servers/alpha-mcp',
        ref: 'refs/heads/main',
        requireRef: 'refs/heads/main',
        fetchFn: createStubFetch({
          npmStatus: 404,
          githubReleaseStatus: 404,
          seenUrls,
        }),
      });

      assert.deepEqual(seenUrls, [
        'https://registry.npmjs.org/%40soulike%2Falpha-mcp/0.1.0',
        'https://api.github.com/repos/Soulike/mcp/releases/tags/alpha-mcp%400.1.0',
      ]);
      assert.deepEqual(result, {
        name: '@soulike/alpha-mcp',
        version: '0.1.0',
        tag: 'alpha-mcp@0.1.0',
        skipNpmPublish: false,
        tagExistsOnOrigin: false,
      });
    });
  });

  await it('rejects non-main refs, private packages, and invalid package-dir', async () => {
    await withRepoAndBareOrigin(async ({ repoDir }) => {
      await mkdir(join(repoDir, 'servers/private-mcp'), { recursive: true });
      await writeJson(join(repoDir, 'servers/private-mcp/package.json'), {
        ...VALID_MANIFEST,
        name: '@soulike/private-mcp',
        private: true,
      });
      commitAndPushMain(repoDir, 'init');

      const stubFetch = createStubFetch({
        npmStatus: 404,
        githubReleaseStatus: 404,
      });

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

  await it('fails normal release when npm version, GitHub release, or origin tag already exists', async () => {
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
            fetchFn: createStubFetch({
              npmStatus: 200,
              githubReleaseStatus: 404,
            }),
          }),
        /already published on npm/,
      );

      await assert.rejects(
        () =>
          prepareRelease({
            repoDir,
            packageDir: 'servers/alpha-mcp',
            fetchFn: createStubFetch({
              npmStatus: 404,
              githubReleaseStatus: 200,
            }),
          }),
        /GitHub release "alpha-mcp@0\.1\.0" already exists/,
      );

      await assert.rejects(
        () =>
          prepareRelease({
            repoDir,
            packageDir: 'servers/alpha-mcp',
            fetchFn: createStubFetch({
              npmStatus: 503,
              githubReleaseStatus: 404,
            }),
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
            fetchFn: createStubFetch({
              npmStatus: 404,
              githubReleaseStatus: 404,
            }),
          }),
        /already exists on origin/,
      );
    });
  });

  await it('supports finalizeExisting when npm version is published and GitHub release is absent, while rejecting conflicts', async () => {
    await withRepoAndBareOrigin(async ({ repoDir }) => {
      await mkdir(join(repoDir, 'servers/alpha-mcp'), { recursive: true });
      await writeJson(
        join(repoDir, 'servers/alpha-mcp/package.json'),
        VALID_MANIFEST,
      );
      const firstSha = commitAndPushMain(repoDir, 'init');

      // Cannot finalize an unpublished npm version.
      await assert.rejects(
        () =>
          prepareRelease({
            repoDir,
            packageDir: 'servers/alpha-mcp',
            targetSha: firstSha,
            finalizeExisting: true,
            fetchFn: createStubFetch({
              npmStatus: 404,
              githubReleaseStatus: 404,
            }),
          }),
        /not published on npm yet/,
      );

      // npm-present + GitHub-release-absent + matching provenance + no tag -> skipNpmPublish: true.
      const resumeNoTag = await prepareRelease({
        repoDir,
        packageDir: 'servers/alpha-mcp',
        targetSha: firstSha,
        finalizeExisting: true,
        fetchFn: createStubFetch({
          npmStatus: 200,
          githubReleaseStatus: 404,
          provenanceCommit: firstSha,
        }),
      });
      assert.deepEqual(resumeNoTag, {
        name: '@soulike/alpha-mcp',
        version: '0.1.0',
        tag: 'alpha-mcp@0.1.0',
        skipNpmPublish: true,
        tagExistsOnOrigin: false,
      });

      // No-tag case where published provenance belongs to firstSha (A) and target is secondSha (B) -> rejected.
      await writeFile(join(repoDir, 'README.md'), '# advance\n');
      const secondSha = commitAndPushMain(repoDir, 'advance');
      await assert.rejects(
        () =>
          prepareRelease({
            repoDir,
            packageDir: 'servers/alpha-mcp',
            targetSha: secondSha,
            finalizeExisting: true,
            fetchFn: createStubFetch({
              npmStatus: 200,
              githubReleaseStatus: 404,
              provenanceCommit: firstSha,
            }),
          }),
        /provenance gitCommit .* does not match target SHA/,
      );

      // Missing provenance is rejected even when no tag exists.
      await assert.rejects(
        () =>
          prepareRelease({
            repoDir,
            packageDir: 'servers/alpha-mcp',
            targetSha: firstSha,
            finalizeExisting: true,
            fetchFn: createStubFetch({
              npmStatus: 200,
              githubReleaseStatus: 404,
              provenanceStatus: 404,
            }),
          }),
        /Failed to fetch npm provenance/,
      );

      // Tag already exists on firstSha while release is still absent -> succeeds.
      git(repoDir, ['tag', 'alpha-mcp@0.1.0', firstSha]);
      git(repoDir, ['push', 'origin', 'alpha-mcp@0.1.0']);

      const resumeWithMatchingTag = await prepareRelease({
        repoDir,
        packageDir: 'servers/alpha-mcp',
        targetSha: firstSha,
        finalizeExisting: true,
        fetchFn: createStubFetch({
          npmStatus: 200,
          githubReleaseStatus: 404,
          provenanceCommit: firstSha,
        }),
      });
      assert.deepEqual(resumeWithMatchingTag, {
        name: '@soulike/alpha-mcp',
        version: '0.1.0',
        tag: 'alpha-mcp@0.1.0',
        skipNpmPublish: true,
        tagExistsOnOrigin: true,
      });

      // Tag pointing to a different commit is rejected.
      await assert.rejects(
        () =>
          prepareRelease({
            repoDir,
            packageDir: 'servers/alpha-mcp',
            targetSha: secondSha,
            finalizeExisting: true,
            fetchFn: createStubFetch({
              npmStatus: 200,
              githubReleaseStatus: 404,
              provenanceCommit: secondSha,
            }),
          }),
        /points to .*, expected/,
      );

      // Existing GitHub release is rejected even in finalizeExisting mode.
      await assert.rejects(
        () =>
          prepareRelease({
            repoDir,
            packageDir: 'servers/alpha-mcp',
            targetSha: firstSha,
            finalizeExisting: true,
            fetchFn: createStubFetch({
              npmStatus: 200,
              githubReleaseStatus: 200,
            }),
          }),
        /GitHub release "alpha-mcp@0\.1\.0" already exists/,
      );
    });
  });
});
