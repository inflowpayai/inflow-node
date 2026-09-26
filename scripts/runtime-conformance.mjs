import { readFile, open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runtimeCases } from '../conformance/runtime-cases.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function implementation() {
  const packages = {};
  const dependencies = {};
  for (const [product, dependency] of [
    ['mpp', 'mppx'],
    ['x402', '@x402/core'],
  ]) {
    const packageRoot = resolve(root, 'packages', product);
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
    const installed = JSON.parse(
      await readFile(resolve(packageRoot, 'node_modules', dependency, 'package.json'), 'utf8'),
    );
    packages[manifest.name] = manifest.version;
    dependencies[installed.name] = installed.version;
  }
  return { name: 'inflow-node', runtime: process.version, packages, dependencies };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'contract-root': { type: 'string' },
      output: { type: 'string' },
    },
  });
  if (!values['contract-root'] || !values.output) {
    throw new Error('Usage: pnpm runtime:conformance --contract-root PATH --output NEW_REPORT.json');
  }
  const contractRoot = resolve(values['contract-root']);
  const lock = JSON.parse(await readFile(new URL('../conformance/inflow-specs.lock.json', import.meta.url), 'utf8'));
  const git = (args) => execFileSync('git', args, { cwd: contractRoot, encoding: 'utf8', timeout: 10000 }).trim();
  if (git(['rev-parse', 'HEAD']) !== lock.revision || git(['status', '--porcelain'])) {
    throw new Error(`Use a clean ${lock.repository} checkout at ${lock.revision}`);
  }
  const { run } = await import(pathToFileURL(resolve(contractRoot, 'runner/run.mjs')));
  const { runtimeScenarios } = await import(pathToFileURL(resolve(contractRoot, 'fixtures/runtime.mjs')));
  const metadata = await implementation();
  const output = await open(resolve(values.output), 'wx', 0o600);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const report = await run({
      index: runtimeCases(runtimeScenarios),
      capabilities: { suites: ['runtime'], supported_features: [], unsupported_features: [] },
      implementation: metadata,
      command: [process.execPath, resolve(root, 'conformance/runtime-adapter.mjs')],
      contractRoot,
      sdkRoot: root,
      signal: controller.signal,
    });
    await output.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    console.log(
      `Runtime conformance: ${report.results.filter((item) => item.status === 'passed').length}/${report.results.length} passed.`,
    );
    if (!report.passed) {
      console.error(report.runner_error ?? report.results.filter((item) => item.status !== 'passed'));
      process.exitCode = 1;
    }
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    await output.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
