import { readFileSync } from 'node:fs';

function readPackageVersion(): string {
  const packageJsonUrl = new URL('../package.json', import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(packageJsonUrl, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof parsed.version !== 'string' ||
    parsed.version === ''
  ) {
    throw new Error(
      `Expected non-empty "version" string in ${packageJsonUrl.href}`,
    );
  }
  return parsed.version;
}

export const SERVER_VERSION = readPackageVersion();
