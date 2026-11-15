// Build a standalone workbench. --online downloads the pinned Clang assets on first run.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const [simulatorDir, compilerDir, workDir, llvmLicences, emscriptenDir, output, mode] = process.argv.slice(2);
if (!output || (mode && mode !== '--online')) {
  throw new Error('Usage: build-preview.mjs SIM_DIR COMPILER_DIR EXPERIMENT_DIR LLVM_LICENCES EMSCRIPTEN_DIR OUTPUT [--online]');
}
const online = mode === '--online';
const read = name => readFile(new URL(name, import.meta.url), 'utf8');
const compressed = bytes => gzipSync(bytes, { level: 9 }).toString('base64');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const manifest = JSON.parse(await read('./compiler-assets.json'));
const compiler = await Promise.all(manifest.map(async ({ name, sha256: hash }) => {
  if (online) return { url: 'https://llvm-explorer.dev/compiler/' + name, sha256: hash };
  const bytes = await readFile(join(compilerDir, name));
  if (sha256(bytes) !== hash) throw new Error('Compiler asset does not match the pinned digest: ' + name);
  return { gzip: compressed(bytes), sha256: hash };
}));
const licenceNames = (await readdir(llvmLicences)).filter(name => name.endsWith('.txt')).sort();
const notices = [
  ...licenceNames.map(name => join(llvmLicences, name)),
  join(workDir, 'gpgpu', 'COPYRIGHT'),
  join(emscriptenDir, 'LICENSE'),
  join(emscriptenDir, 'cache', 'ports', 'zlib', 'zlib-1.3.1', 'LICENSE'),
];
const licenses = (await Promise.all(notices.map(name => readFile(name, 'utf8'))))
  .join('\n\n').replace(/[ \t]+$/gm, '');
const assets = {
  compiler,
  simulator: {
    glue: compressed(await readFile(join(simulatorDir, 'run-ptx.js'))),
    wasm: compressed(await readFile(join(simulatorDir, 'run-ptx.wasm'))),
  },
};
const pipeline = (await read('./pipeline.mjs')).replace(/^export /gm, '');
const worker = (await read('./worker.mjs')).replace(/^import .*\n/, '');
const lab = { assets, worker: pipeline + '\n' + worker };
const js = 'const lab = ' + JSON.stringify(lab) + ';\n' + await read('./page.js');
const starter = await read('./hello.cu');
const html = (await read('./index.html'))
  .replace('__STARTER__', () => escape(starter))
  .replace('__COURSE_LINK__', online ? '<div class="top-actions"><a href="./one-thread-one-element.html">← CUDA lesson</a></div>' : '')
  .replace('__ASSET_NOTE__', online
    ? 'The first run downloads about 127 MiB of compiler assets. Your edited source stays in this browser.'
    : 'Compiler and simulator are bundled for offline use. The first run loads the compiler.')
  .replace('__LICENSES__', () => escape(licenses))
  .replace('/* __SCRIPT__ */', () => js.replace(/<\/script/gi, '<\\/script'));
await writeFile(output, html);
