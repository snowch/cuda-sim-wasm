import { compileProgram, runProgram } from './program.mjs';
import { compileKernel, prepareKernelRunner, runKernel } from './pipeline.mjs';

let compiler;
let compilerMessages = [];
let createSimulator;
let simulatorModule;
let nvptxCompiler;
let moduleSimulator;

async function unpack(base64) {
  const blocks = [];
  for (let start = 0; start < base64.length; start += 32_768) {
    const chunk = atob(base64.slice(start, start + 32_768));
    const bytes = new Uint8Array(chunk.length);
    for (let index = 0; index < chunk.length; index++) bytes[index] = chunk.charCodeAt(index);
    blocks.push(bytes);
  }
  return decompress(blocks);
}

async function decompress(parts) {
  return new Response(new Blob(parts).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

async function downloadAsset(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Compiler download failed (HTTP ${response.status}).`);
  return response.arrayBuffer();
}

async function getCompilerAsset(asset) {
  const bytes = asset.gzip ? await unpack(asset.gzip)
    : asset.parts ? await decompress(await Promise.all(asset.parts.map(downloadAsset)))
      : await downloadAsset(asset.url);
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

function instantiate(module) {
  return {
    instantiateWasm(imports, receiveInstance) {
      const instance = new WebAssembly.Instance(module, imports);
      receiveInstance(instance, module);
      return instance.exports;
    },
  };
}

async function initialise(assets, advanced) {
  postMessage({ stage: 'Loading Clang and GPGPU-Sim…' });
  const [glue, wasm, data, simGlue, simWasm] = await Promise.all([
    ...assets.compiler.map(getCompilerAsset),
    advanced ? getCompilerAsset(assets.advanced.simGlue) : unpack(assets.simulator.glue),
    advanced ? getCompilerAsset(assets.advanced.simWasm) : unpack(assets.simulator.wasm),
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
  simulatorModule = await WebAssembly.compile(simWasm);
  if (advanced) {
    const [glue, wasm] = await Promise.all([
      getCompilerAsset(assets.advanced.nvptxGlue),
      getCompilerAsset(assets.advanced.nvptxWasm),
    ]);
    const createNvptx = await importProgram(glue, 'createNvptxCompiler');
    nvptxCompiler = await createNvptx({
      ...instantiate(await WebAssembly.compile(wasm)),
      noInitialRun: true,
      printErr: line => compilerMessages.push(line),
    });
    moduleSimulator = await importProgram(simGlue, 'createModuleSimulator');
    moduleRuntime.installHeaders(compiler, matrixHeader);
  } else {
    createSimulator = await importProgram(simGlue, 'createPtxSimulator');
  }
}

function compileModule(source) {
  const ir = compileKernel(compiler, source);
  if (!ir) return null;
  nvptxCompiler.FS.writeFile('/input.ll', ir);
  if (nvptxCompiler.callMain(['/input.ll', '/output.ptx', '/entries'])) return null;
  const ptx = nvptxCompiler.FS.readFile('/output.ptx', { encoding: 'utf8' });
  const kernels = new Map(nvptxCompiler.FS.readFile('/entries', { encoding: 'utf8' }).trim().split('\n')
    .filter(Boolean).map(line => {
      const [name, ...args] = line.split(' ');
      return [name, args];
    }));
  const host = moduleRuntime.compileHost(compiler, source, kernels);
  return host ? { host, ptx, kernels } : null;
}

self.onmessage = async ({ data: { source, assets, profile, fullProgram, advanced } }) => {
  try {
    if (assets) await initialise(assets, advanced);
    if (!compiler || !simulatorModule) throw new Error('The compiler and simulator could not start.');
    postMessage({ stage: 'Compiling your CUDA source…', ready: true });
    compilerMessages = [];
    const compiled = advanced ? compileModule(source) : fullProgram ? compileProgram(compiler, source, compileKernel) : compileKernel(compiler, source);
    if (compiled === null) {
      postMessage({ diagnostics: compilerMessages.join('\n'), compileError: true });
      return;
    }
    postMessage({ stage: fullProgram ? 'Running main()…' : 'Running the compiled PTX in GPGPU-Sim…' });
    const options = instantiate(simulatorModule);
    const result = advanced
      ? await moduleRuntime.runProgram(compiled, moduleRuntime.ptxDevice(
        await moduleSimulator({ ...options, print() {}, printErr() {} }), compiled.ptx))
      : fullProgram
        ? await runProgram(compiled, await prepareKernelRunner(createSimulator, options))
        : await runKernel(createSimulator, compiled, options, profile);
    postMessage({ ...result, diagnostics: compilerMessages.join('\n') });
  } catch (error) {
    postMessage({ error: String(error.message ?? error) });
  }
};
