import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { compileKernel, runKernel } from './pipeline.mjs';

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
