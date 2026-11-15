import { compileKernel, runKernel } from './pipeline.mjs';

let compiler;
let compilerMessages = [];
let createSimulator;
let simulatorModule;

async function unpack(base64) {
  const blocks = [];
  for (let start = 0; start < base64.length; start += 32_768) {
    const chunk = atob(base64.slice(start, start + 32_768));
    const bytes = new Uint8Array(chunk.length);
    for (let index = 0; index < chunk.length; index++) bytes[index] = chunk.charCodeAt(index);
    blocks.push(bytes);
  }
  return new Response(new Blob(blocks).stream().pipeThrough(new DecompressionStream('gzip')))
    .arrayBuffer();
}

async function getCompilerAsset(asset) {
  const bytes = asset.gzip ? await unpack(asset.gzip) : await (async () => {
    const response = await fetch(asset.url);
    if (!response.ok) throw new Error(`Compiler download failed (HTTP ${response.status}).`);
    return response.arrayBuffer();
  })();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== asset.sha256) throw new Error('A compiler file failed its integrity check.');
  return bytes;
}

async function importProgram(bytes, cjsName) {
  const footer = cjsName ? '\nexport default ' + cjsName + ';\n' : '';
  const url = URL.createObjectURL(new Blob([bytes, footer], { type: 'text/javascript' }));
  try { return (await import(url)).default; } finally { URL.revokeObjectURL(url); }
}

async function initialise(assets) {
  postMessage({ stage: 'Loading Clang and GPGPU-Sim…' });
  const [glue, wasm, data, simGlue, simWasm] = await Promise.all([
    ...assets.compiler.map(getCompilerAsset),
    unpack(assets.simulator.glue),
    unpack(assets.simulator.wasm),
  ]);
  const createCompiler = await importProgram(glue);
  compiler = await createCompiler({
    wasmBinary: new Uint8Array(wasm),
    // Emscripten resolves a name even when the corresponding bytes are supplied.
    locateFile: name => new URL(name, 'https://cuda-workbench.invalid/').href,
    getPreloadedPackage: () => data,
    print: line => compilerMessages.push(line),
    printErr: line => compilerMessages.push(line),
  });
  createSimulator = await importProgram(simGlue, 'createPtxSimulator');
  simulatorModule = await WebAssembly.compile(simWasm);
}

self.onmessage = async ({ data: { source, assets, profile } }) => {
  try {
    if (assets) await initialise(assets);
    if (!compiler || !simulatorModule) throw new Error('The compiler and simulator could not start.');
    postMessage({ stage: 'Compiling your CUDA source…', ready: true });
    compilerMessages = [];
    const ir = compileKernel(compiler, source);
    if (ir === null) {
      postMessage({ diagnostics: compilerMessages.join('\n'), compileError: true });
      return;
    }
    postMessage({ stage: 'Running the compiled PTX in GPGPU-Sim…' });
    const result = await runKernel(createSimulator, ir, {
      instantiateWasm(imports, receiveInstance) {
        const instance = new WebAssembly.Instance(simulatorModule, imports);
        receiveInstance(instance, simulatorModule);
        return instance.exports;
      },
    }, profile);
    postMessage({ ...result, diagnostics: compilerMessages.join('\n') });
  } catch (error) {
    postMessage({ error: String(error.message ?? error) });
  }
};
