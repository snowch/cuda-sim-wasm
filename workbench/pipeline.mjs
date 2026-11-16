// Clang compiles the exact editor text. Only the lesson's device kernel is built.
const clangCommand = [
  'clang++ --target=x86_64-unknown-linux-gnu -x cuda --cuda-device-only',
  '--cuda-gpu-arch=sm_70 -nocudainc -nocudalib -resource-dir /lib/clang/23',
  '-include /lib/clang/23/include/__clang_cuda_builtin_vars.h',
  '"-D__global__=__attribute__((global))"',
  '-I/workbench -O1 -ffp-contract=off -S -emit-llvm /kernel.cu -o /kernel.ll',
].join(' ');

export function compileKernel(compiler, source) {
  if (source.length > 16_384 || source.includes('\0')) {
    throw new Error('Use a CUDA kernel under 16,384 characters without NUL bytes.');
  }
  if (compiler.FS.analyzePath('/kernel.ll').exists) compiler.FS.unlink('/kernel.ll');
  compiler.FS.writeFile('/kernel.cu', source);
  const status = compiler.ccall('run_command', 'number', ['string'], [clangCommand]);
  if (status !== 0) return null;
  return compiler.FS.readFile('/kernel.ll', { encoding: 'utf8' });
}

export async function prepareKernelRunner(createSimulator, options) {
  const ptx = [];
  const diagnostics = [];
  let insidePtx = false;
  let output, hex;
  const simulator = await createSimulator({
    ...options,
    noInitialRun: true,
    print(line) {
      if (line === 'PTX_BEGIN') insidePtx = true;
      else if (line === 'PTX_END') insidePtx = false;
      else if (insidePtx) ptx.push(line);
      else if (line.startsWith('OUTPUT_JSON ')) output = JSON.parse(line.slice(12));
      else if (line.startsWith('OUTPUT_HEX ')) hex = line.slice(11);
    },
    printErr(line) { diagnostics.push(line.replace(/^LOWERING_ERROR /, '')); },
  });
  return args => {
    const status = simulator.callMain(args);
    if (status !== 0 || (!output && !hex)) {
      throw new Error(diagnostics.join('\n') || 'The functional simulator did not return output.');
    }
    return { ptx: ptx.join('\n'), output, hex };
  };
}

export async function runKernel(createSimulator, ir, options, profile) {
  const launch = await prepareKernelRunner(createSimulator, options);
  return launch(profile === 'hello' ? [ir, profile] : [ir]);
}
