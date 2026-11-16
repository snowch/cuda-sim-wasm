import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { compileKernel, prepareKernelRunner, runKernel } from './pipeline.mjs';
import { compileProgram, runProgram } from './program.mjs';

const [compilerDirectory, simulatorDirectory] = process.argv.slice(2).map(value => resolve(value));
const glue = await readFile(resolve(compilerDirectory, 'Compiler.js'));
const temporary = await mkdtemp(join(tmpdir(), 'cuda-workbench-'));
const moduleFile = join(temporary, 'Compiler.mjs');
await writeFile(moduleFile, glue);
const { default: createCompiler } = await import(pathToFileURL(moduleFile).href);
const preload = Uint8Array.from(await readFile(resolve(compilerDirectory, 'Compiler.data'))).buffer;
const diagnostics = [];
const compiler = await createCompiler({
  wasmBinary: await readFile(resolve(compilerDirectory, 'Compiler.wasm')),
  getPreloadedPackage: () => preload,
  print: line => diagnostics.push(line),
  printErr: line => diagnostics.push(line),
});
await rm(temporary, { recursive: true, force: true });
const { default: createSimulator } = await import(
  pathToFileURL(resolve(simulatorDirectory, 'run-ptx.js')).href);
const starter = await readFile(new URL('./hello.cu', import.meta.url), 'utf8');
const firstKernel = await readFile(new URL('./first-kernel.cu', import.meta.url), 'utf8');
for (const [edit, expected, profile] of [
  [firstKernel, [42], 'hello'],
  [firstKernel.replace('42.0f', '7.0f'), [7], 'hello'],
  [firstKernel.replace('42.0f', '-3.5f'), [-3.5], 'hello'],
  [firstKernel.replace('output[0] = 42.0f;', ''), [null], 'hello'],
  [starter, [2, 4, 6, 8, 10]],
  [starter.replace('2.0f', '3.0f'), [3, 6, 9, 12, 15]],
  [starter.replace('input[i] * 2.0f', 'input[i] * 3.0f + 1.0f'), [4, 7, 10, 13, 16]],
  [starter.replace('input[i] * 2.0f', '-input[i]'), [-1, -2, -3, -4, -5]],
  [starter.replace('i < n', 'i < n - 1'), [2, 4, 6, 8, null]],
]) {
  const ir = compileKernel(compiler, edit);
  assert.ok(ir, diagnostics.join('\n'));
  const result = await runKernel(createSimulator, ir, {
    locateFile: name => resolve(simulatorDirectory, name),
  }, profile);
  assert.deepEqual(result.output, expected);
  assert.match(result.ptx, profile ? /\.entry hello/ : /\.entry runKernel/);
  console.log(JSON.stringify(result.output));
}
assert.equal(compileKernel(compiler, starter.replace('2.0f', 'missingName')), null);
assert.match(diagnostics.join('\n'), /undeclared identifier 'missingName'/);
console.log('Clang diagnostics passed');

const source = await readFile(new URL('./program.cu', import.meta.url), 'utf8');
for (const [edit, stdout, launch, bytes] of [
  [source, 'Output: [2, 4, 6, 8, 10]\n', '2 blocks × 4 threads', 20],
  [source.replace('threadsPerBlock = 4', 'threadsPerBlock = 2'),
    'Output: [2, 4, 6, 8, 10]\n', '3 blocks × 2 threads', 20],
  [source.replace('4.0f, 5.0f', '4.0f, 5.0f, 6.0f, 7.0f, 8.0f, 9.0f'),
    'Output: [2, 4, 6, 8, 10, 12, 14, 16, 18]\n', '3 blocks × 4 threads', 36],
  [source.replace('input[i] * 2.0f', 'input[i] * 3.0f'),
    'Output: [3, 6, 9, 12, 15]\n', '2 blocks × 4 threads', 20],
]) {
  const program = compileProgram(compiler, edit, compileKernel);
  assert.ok(program, diagnostics.join('\n'));
  const execute = await prepareKernelRunner(createSimulator, {
    locateFile: name => resolve(simulatorDirectory, name),
  });
  const outcome = await runProgram(program, execute);
  assert.equal(outcome.stdout, stdout);
  assert.equal(outcome.exitCode, 0);
  assert.ok(outcome.events.includes('runKernel · ' + launch));
  assert.ok(outcome.events.includes(`cudaMemcpy · ${bytes} bytes · device to host`));
  assert.match(outcome.ptx, /\.entry runKernel/);
  console.log(outcome.stdout.trim(), launch);
}

const helloSource = await readFile(new URL('./first-program.cu', import.meta.url), 'utf8');
for (const [edit, stdout] of [
  [helloSource, '42.0\n'],
  [helloSource.replace('42.0f', '7.0f'), '7.0\n'],
  [helloSource.replace('printf("%.1f\\n", value)', 'printf("%.1f\\n", value + 1.0f)'), '43.0\n'],
]) {
  const program = compileProgram(compiler, edit, compileKernel);
  assert.ok(program, diagnostics.join('\n'));
  const execute = await prepareKernelRunner(createSimulator, {
    locateFile: name => resolve(simulatorDirectory, name),
  });
  const outcome = await runProgram(program, execute);
  assert.equal(outcome.stdout, stdout);
  assert.equal(outcome.exitCode, 0);
  assert.ok(outcome.events.includes('hello · 1 block × 1 thread'));
  console.log(outcome.stdout.trim(), 'from main()');
}

const coalescing = await readFile(new URL('./coalescing.cu', import.meta.url), 'utf8');
for (const [stride, sectors] of [[1, 4], [2, 8], [32, 32]]) {
  const program = compileProgram(compiler, coalescing.replace('stride = 1', 'stride = ' + stride), compileKernel);
  assert.ok(program, diagnostics.join('\n'));
  const execute = await prepareKernelRunner(createSimulator, {
    locateFile: name => resolve(simulatorDirectory, name),
  });
  const result = await runProgram(program, execute);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, `Sectors touched: ${sectors}\n`);
  console.log('Stride ' + stride, result.stdout.trim());
}
