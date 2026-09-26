import { readFile, open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runtimeCases } from '../conformance/runtime-cases.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function implementation(suite = 'runtime', adapterNode = process.execPath) {
  const packages = {};
  const dependencies = {};
  const products =
    suite === 'mpp'
      ? [
          ['mpp', 'mppx'],
          ['mpp-buyer', 'mppx'],
          ['mpp-seller', 'mppx'],
        ]
      : suite === 'x402'
        ? [
            ['x402', '@x402/core'],
            ['x402-buyer', '@x402/core'],
            ['x402-seller', '@x402/core'],
            ['x402-seller', '@x402/extensions'],
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
  const runtime = execFileSync(adapterNode, ['-p', 'process.version'], { encoding: 'utf8', timeout: 10000 }).trim();
  return { name: 'inflow-node', runtime, packages, dependencies };
}

export function verifyContract(contractRoot, expectedRevision) {
  if (!/^[0-9a-f]{40}$/.test(expectedRevision)) throw new Error('Contract revision must be a full commit SHA');
  const git = (args) => execFileSync('git', args, { cwd: contractRoot, encoding: 'utf8', timeout: 10000 }).trim();
  if (git(['rev-parse', 'HEAD']) !== expectedRevision || git(['status', '--porcelain'])) {
    throw new Error(`Use a clean contract checkout at ${expectedRevision}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'contract-root': { type: 'string' },
      output: { type: 'string' },
      suite: { type: 'string', default: 'runtime' },
      'contract-revision': { type: 'string' },
      'adapter-node': { type: 'string' },
    },
  });
  if (!values['contract-root'] || !values.output) {
    throw new Error(
      'Usage: node scripts/conformance.mjs --suite runtime|mpp|x402 --contract-root PATH --output NEW_REPORT.json',
    );
  }
  if (!['runtime', 'mpp', 'x402'].includes(values.suite)) throw new Error('Unknown conformance suite');
  const contractRoot = resolve(values['contract-root']);
  const lock = JSON.parse(await readFile(new URL('../conformance/inflow-specs.lock.json', import.meta.url), 'utf8'));
  verifyContract(contractRoot, values['contract-revision'] ?? lock.revision);
  const adapterNode = values['adapter-node'] ?? process.execPath;
  const { run } = await import(pathToFileURL(resolve(contractRoot, 'runner/run.mjs')));
  const fixtures = await import(pathToFileURL(resolve(contractRoot, `fixtures/${values.suite}.mjs`)));
  const index = values.suite === 'runtime' ? runtimeCases(fixtures.runtimeScenarios) : fixtures[`${values.suite}Cases`];
  const suites = {
    runtime: ['runtime'],
    mpp: ['mpp-core', 'mpp-buyer', 'mpp-seller'],
    x402: ['x402-core', 'x402-buyer', 'x402-seller'],
  }[values.suite];
  const metadata = await implementation(values.suite, adapterNode);
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
        adapterNode,
        resolve(
          root,
          values.suite === 'runtime'
            ? 'conformance/runtime-adapter.mjs'
            : `conformance/${values.suite}-shared-adapter.mjs`,
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
