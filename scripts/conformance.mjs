import { readFile, open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runtimeCases } from '../conformance/runtime-cases.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function implementation(suite = 'runtime') {
  const packages = {};
  const dependencies = {};
  const products =
    suite === 'mpp'
      ? [
          ['mpp', 'mppx'],
          ['mpp-buyer', 'mppx'],
          ['mpp-seller', 'mppx'],
        ]
      : [
          ['mpp', 'mppx'],
          ['x402', '@x402/core'],
        ];
  for (const [product, dependency] of products) {
    const packageRoot = resolve(root, 'packages', product);
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
    const installed = JSON.parse(
      await readFile(resolve(packageRoot, 'node_modules', dependency, 'package.json'), 'utf8'),
    );
    packages[manifest.name] = manifest.version;
    if (dependencies[installed.name] !== undefined && dependencies[installed.name] !== installed.version) {
      throw new Error(`Conflicting installed versions for ${installed.name}`);
    }
    dependencies[installed.name] = installed.version;
  }
  return { name: 'inflow-node', runtime: process.version, packages, dependencies };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'contract-root': { type: 'string' },
      output: { type: 'string' },
      suite: { type: 'string', default: 'runtime' },
    },
  });
  if (!values['contract-root'] || !values.output) {
    throw new Error(
      'Usage: node scripts/conformance.mjs --suite runtime|mpp --contract-root PATH --output NEW_REPORT.json',
    );
  }
  if (!['runtime', 'mpp'].includes(values.suite)) throw new Error('Unknown conformance suite');
  const contractRoot = resolve(values['contract-root']);
  const lock = JSON.parse(await readFile(new URL('../conformance/inflow-specs.lock.json', import.meta.url), 'utf8'));
  const git = (args) => execFileSync('git', args, { cwd: contractRoot, encoding: 'utf8', timeout: 10000 }).trim();
  if (git(['rev-parse', 'HEAD']) !== lock.revision || git(['status', '--porcelain'])) {
    throw new Error(`Use a clean ${lock.repository} checkout at ${lock.revision}`);
  }
  const { run } = await import(pathToFileURL(resolve(contractRoot, 'runner/run.mjs')));
  const fixtures = await import(pathToFileURL(resolve(contractRoot, `fixtures/${values.suite}.mjs`)));
  const index = values.suite === 'mpp' ? fixtures.mppCases : runtimeCases(fixtures.runtimeScenarios);
  const suites = values.suite === 'mpp' ? ['mpp-core', 'mpp-buyer', 'mpp-seller'] : ['runtime'];
  const metadata = await implementation(values.suite);
  const output = await open(resolve(values.output), 'wx', 0o600);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const report = await run({
      index,
      capabilities: { suites, supported_features: [], unsupported_features: [] },
      implementation: metadata,
      command: [
        process.execPath,
        resolve(
          root,
          values.suite === 'mpp' ? 'conformance/mpp-shared-adapter.mjs' : 'conformance/runtime-adapter.mjs',
        ),
      ],
      contractRoot,
      sdkRoot: root,
      signal: controller.signal,
    });
    await output.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    console.log(
      `${values.suite} conformance: ${report.results.filter((item) => item.status === 'passed').length}/${report.results.length} passed.`,
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
