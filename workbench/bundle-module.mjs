// Build the split, integrity-checked browser assets for the CUDA module workbench.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const [compilerDir, simulatorDir, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: bundle-module.mjs NVPTX_BUILD SIMULATOR_BUILD OUTPUT');
await mkdir(output, { recursive: true });
const manifest = {};
for (const [name, path] of Object.entries({
  nvptxGlue: join(compilerDir, 'browser-nvptx.js'),
  nvptxWasm: join(compilerDir, 'browser-nvptx.wasm'),
  simGlue: join(simulatorDir, 'run-module.js'),
  simWasm: join(simulatorDir, 'run-module.wasm'),
})) {
  const source = await readFile(path);
  const compressed = gzipSync(source, { level: 9 });
  const parts = [];
  for (let offset = 0; offset < compressed.length; offset += 900_000) {
    const part = name + '-' + parts.length + '.bin';
    parts.push(part);
    await writeFile(join(output, part), compressed.subarray(offset, offset + 900_000));
  }
  manifest[name] = { parts, sha256: createHash('sha256').update(source).digest('hex') };
}
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
