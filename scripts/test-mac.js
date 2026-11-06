'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') {
  console.log('Native macOS tests require macOS.');
  process.exit(0);
}
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-mac-tests-'));
try {
  const source = ['native/mac/CapriHelper.swift', 'tests/mac-pages.swift']
    .map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const file = path.join(dir, 'tests.swift');
  const binary = path.join(dir, 'tests');
  fs.writeFileSync(file, source);
  for (const [command, args] of [
    ['xcrun', ['swiftc', '-swift-version', '5', '-D', 'CAPRI_TESTS', file, '-o', binary]],
    [binary, []],
  ]) {
    const result = spawnSync(command, args, { stdio: 'inherit', timeout: 120000 });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status || 1; break; }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
