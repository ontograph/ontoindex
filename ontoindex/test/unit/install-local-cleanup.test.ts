import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const installer = readFileSync(
  fileURLToPath(new URL('../../../scripts/install-ontoindex-latest.sh', import.meta.url)),
  'utf8',
);
const cleanup = installer.match(/^cleanup_temp_asset\(\) \{\n[\s\S]*?^\}/m)?.[0];
const repairFunction = installer.match(/^write_linux_repair_instructions\(\) \{[\s\S]*?^\}/m)?.[0];
const removeFunction = installer.match(/^remove_existing_install\(\) \{[\s\S]*?^\}/m)?.[0];
const validateFunction = installer.match(/^validate_install\(\) \{[\s\S]*?^\}/m)?.[0];
const installerTail = installer.match(/^default_prefix=.*$(?:\n[\s\S]*)/m)?.[0];

function runInstall(
  root: string,
  options: {
    explicitPrefix?: string;
    defaultPrefix: string;
    home: string;
    failInstall?: boolean;
    pathPrefix?: string;
  },
) {
  const asset = path.join(root, 'ontoindex-1.2.3.tgz');
  writeFileSync(asset, 'fixture');
  const npmLog = path.join(root, 'npm.log');
  for (const section of [repairFunction, removeFunction, validateFunction, installerTail]) {
    expect(section).toBeDefined();
  }
  const helpers = [repairFunction, removeFunction, validateFunction].join('\n');
  const shell = `
set -euo pipefail
log() { printf '%s\\n' "$*"; }
USER_PREFIX="${'${ONTOINDEX_NPM_PREFIX:-${HOME}/.local}'}"
version="1.2.3"
npm_script_args=()
asset_url="$1"
NPM_LOG="$2"
NPM_DEFAULT_PREFIX="$3"
NPM_FAIL_INSTALL="$4"
export NPM_LOG NPM_DEFAULT_PREFIX NPM_FAIL_INSTALL
npm() {
  printf '%s\\n' "$*" >> "$NPM_LOG"
  case "$1" in
    config) printf '%s\\n' "$NPM_DEFAULT_PREFIX" ;;
    root) printf '%s/lib/node_modules\\n' "${'${'}4}" ;;
    install)
      [ "$NPM_FAIL_INSTALL" != 1 ] || return 23
      local prefix="${'${'}3}"
      mkdir -p "$prefix/lib/node_modules/ontoindex/dist/cli" "$prefix/bin"
      printf '{}\\n' > "$prefix/lib/node_modules/ontoindex/package.json"
      printf '// fixture\\n' > "$prefix/lib/node_modules/ontoindex/dist/cli/index.js"
      printf '#!/usr/bin/env bash\\nprintf "selected-cli\\\\n"\\n' > "$prefix/bin/ontoindex"
      chmod +x "$prefix/bin/ontoindex"
      ;;
    *) echo "unexpected npm command: $*" >&2; return 90 ;;
  esac
}
node() { [ "$1" = -e ]; }
${helpers}
${installerTail ?? ''}
`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: options.home,
    PATH: [options.pathPrefix, process.env.PATH].filter(Boolean).join(path.delimiter),
  };
  if (options.explicitPrefix === undefined) delete env.ONTOINDEX_NPM_PREFIX;
  else env.ONTOINDEX_NPM_PREFIX = options.explicitPrefix;
  return spawnSync(
    'bash',
    [
      '-c',
      shell,
      'installer-test',
      asset,
      npmLog,
      options.defaultPrefix,
      options.failInstall ? '1' : '0',
    ],
    { cwd: root, env, encoding: 'utf8' },
  );
}

function seedInstall(prefix: string, marker = 'old') {
  mkdirSync(path.join(prefix, 'lib/node_modules/ontoindex'), { recursive: true });
  writeFileSync(path.join(prefix, 'lib/node_modules/ontoindex/marker'), marker);
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  writeFileSync(path.join(prefix, 'bin/ontoindex'), 'old cli');
}

describe('installer EXIT cleanup', () => {
  it('keeps successful local installs successful and preserves an install failure', () => {
    expect(cleanup).toBeDefined();
    for (const status of [0, 7]) {
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -e; temp_asset_dir=""; ${cleanup}\ntrap cleanup_temp_asset EXIT\nexit ${status}`,
        ],
        { encoding: 'utf8' },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(status);
    }
  });

  it('removes owned download scratch and retains cleanup failures', () => {
    expect(cleanup).toBeDefined();
    const scratch = mkdtempSync(path.join(tmpdir(), 'ontoindex-cleanup-test-'));
    try {
      execFileSync('bash', [
        '-c',
        `set -e; temp_asset_dir="$1"; ${cleanup}\ntrap cleanup_temp_asset EXIT`,
        'cleanup-test',
        scratch,
      ]);
      expect(existsSync(scratch)).toBe(false);
      const failure = spawnSync('bash', [
        '-c',
        `set -e; temp_asset_dir=owned; rm() { return 9; }; ${cleanup}\ntrap cleanup_temp_asset EXIT`,
      ]);
      expect(failure.error).toBeUndefined();
      expect(failure.status).toBe(9);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('uses an explicit prefix without touching the npm default or PATH command', () => {
    expect(installerTail).toBeDefined();
    expect(removeFunction).toBeDefined();
    expect(validateFunction).toBeDefined();
    const root = mkdtempSync(path.join(tmpdir(), 'ontoindex-prefix-test-'));
    try {
      const home = path.join(root, 'home');
      const explicit = path.join(root, 'explicit prefix');
      const defaultPrefix = path.join(root, 'npm-default');
      const outsideBin = path.join(root, 'outside-bin');
      mkdirSync(home);
      mkdirSync(outsideBin);
      seedInstall(defaultPrefix);
      writeFileSync(path.join(outsideBin, 'ontoindex'), '#!/bin/sh\necho path-cli\n', {
        mode: 0o755,
      });
      const result = runInstall(root, {
        explicitPrefix: explicit,
        defaultPrefix,
        home,
        pathPrefix: outsideBin,
      });

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('selected-cli');
      expect(result.stdout).not.toContain('path-cli');
      expect(
        readFileSync(path.join(defaultPrefix, 'lib/node_modules/ontoindex/marker'), 'utf8'),
      ).toBe('old');
      expect(readFileSync(path.join(defaultPrefix, 'bin/ontoindex'), 'utf8')).toBe('old cli');
      expect(
        readFileSync(path.join(explicit, 'lib/node_modules/ontoindex/package.json'), 'utf8'),
      ).toContain('{}');
      const npmCalls = readFileSync(path.join(root, 'npm.log'), 'utf8');
      expect(npmCalls).toContain(`root -g --prefix ${explicit}`);
      expect(npmCalls).toContain(`install --prefix ${explicit}`);
      expect(existsSync(path.join(outsideBin, 'ontoindex'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the npm default when the explicit prefix is unset or empty', () => {
    expect(installerTail).toBeDefined();
    for (const explicitPrefix of [undefined, '']) {
      const root = mkdtempSync(path.join(tmpdir(), 'ontoindex-default-prefix-test-'));
      try {
        const home = path.join(root, 'home');
        const defaultPrefix = path.join(root, 'npm-default');
        mkdirSync(home);
        mkdirSync(defaultPrefix);
        const result = runInstall(root, { explicitPrefix, defaultPrefix, home });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(path.join(defaultPrefix, 'bin/ontoindex'))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('falls back to HOME/.local when the default prefix does not exist', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ontoindex-home-prefix-test-'));
    try {
      const home = path.join(root, 'home');
      const defaultPrefix = path.join(root, 'missing-default');
      mkdirSync(home);
      const result = runInstall(root, { defaultPrefix, home });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(path.join(home, '.local/bin/ontoindex'))).toBe(true);
      expect(existsSync(defaultPrefix)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails before removing the npm default when the explicit prefix cannot be created', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ontoindex-invalid-prefix-test-'));
    try {
      const home = path.join(root, 'home');
      const defaultPrefix = path.join(root, 'npm-default');
      const invalidPrefix = path.join(root, 'prefix-is-a-file');
      mkdirSync(home);
      seedInstall(defaultPrefix);
      writeFileSync(invalidPrefix, 'not a directory');
      const result = runInstall(root, { explicitPrefix: invalidPrefix, defaultPrefix, home });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(
        readFileSync(path.join(defaultPrefix, 'lib/node_modules/ontoindex/marker'), 'utf8'),
      ).toBe('old');
      expect(readFileSync(path.join(defaultPrefix, 'bin/ontoindex'), 'utf8')).toBe('old cli');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes only a dangling selected-prefix shim and retains npm default state on install failure', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ontoindex-failed-install-test-'));
    try {
      const home = path.join(root, 'home');
      const selected = path.join(root, 'selected');
      const defaultPrefix = path.join(root, 'npm-default');
      const unrelatedBin = path.join(root, 'unrelated-bin');
      mkdirSync(home);
      mkdirSync(unrelatedBin);
      seedInstall(defaultPrefix);
      mkdirSync(path.join(selected, 'bin'), { recursive: true });
      symlinkSync(path.join(root, 'absent-target'), path.join(selected, 'bin/ontoindex'));
      symlinkSync(path.join(root, 'absent-target'), path.join(unrelatedBin, 'ontoindex'));
      const result = runInstall(root, {
        explicitPrefix: selected,
        defaultPrefix,
        home,
        failInstall: true,
        pathPrefix: unrelatedBin,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`npm uninstall --prefix "${selected}" -g ontoindex`);
      expect(() => lstatSync(path.join(selected, 'bin/ontoindex'))).toThrow();
      expect(lstatSync(path.join(unrelatedBin, 'ontoindex')).isSymbolicLink()).toBe(true);
      expect(
        readFileSync(path.join(defaultPrefix, 'lib/node_modules/ontoindex/marker'), 'utf8'),
      ).toBe('old');
      expect(readFileSync(path.join(defaultPrefix, 'bin/ontoindex'), 'utf8')).toBe('old cli');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
