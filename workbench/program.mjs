// Compile the host and device from the same CUDA source. The worker supplies
// the small CUDA runtime surface used by the opening lessons.
const programHeaders = {
  'cuda_runtime.h': `
#pragma once
using size_t = __SIZE_TYPE__;
using cudaError_t = int;
constexpr cudaError_t cudaSuccess = 0;
enum cudaMemcpyKind { cudaMemcpyHostToDevice = 1, cudaMemcpyDeviceToHost = 2 };
struct dim3 {
  unsigned x, y, z;
  constexpr dim3(unsigned x = 1, unsigned y = 1, unsigned z = 1) : x(x), y(y), z(z) {}
};
extern "C" {
int cudaConfigureCall(dim3, dim3, size_t = 0, void* = nullptr);
int cudaSetupArgument(const void*, size_t, size_t);
int cudaLaunch(const void*);
cudaError_t cudaMalloc(void**, size_t);
cudaError_t cudaFree(void*);
cudaError_t cudaMemcpy(void*, const void*, size_t, cudaMemcpyKind);
cudaError_t cudaGetLastError();
cudaError_t cudaDeviceSynchronize();
const char* cudaGetErrorString(cudaError_t);
}
template<typename T> cudaError_t cudaMalloc(T** ptr, size_t bytes) {
    return cudaMalloc(reinterpret_cast<void**>(ptr), bytes);
}
`,
  cstdio: `
#pragma once
struct FILE;
inline FILE* const stderr = reinterpret_cast<FILE*>(2);
extern "C" int printf(const char*, ...);
extern "C" int fprintf(FILE*, const char*, ...);
namespace std { using ::printf; using ::fprintf; }
`,
  cstdlib: `
#pragma once
#define EXIT_FAILURE 1
extern "C" [[noreturn]] void exit(int);
namespace std { using ::exit; }
`,
};

const hostCommand = [
  'clang++ --target=wasm32-unknown-unknown -x cuda --cuda-host-only',
  '--cuda-gpu-arch=sm_70 -nocudainc -nocudalib -resource-dir /lib/clang/23',
  '-include /lib/clang/23/include/__clang_cuda_builtin_vars.h',
  '-I/workbench "-D__global__=__attribute__((global))"',
  '-O1 -fno-exceptions -fno-builtin -mbulk-memory -c /kernel.cu -o /host.o',
].join(' ');
const linkCommand = [
  'wasm-ld --no-entry --export=main --export-memory --export-table --max-memory=1048576',
  '--export-if-defined=__device_stub__hello --export-if-defined=_Z20__device_stub__helloPf',
  '--export-if-defined=__device_stub__runKernel --export-if-defined=_Z24__device_stub__runKernelPKfPfi',
  '--allow-undefined /host.o -o /host.wasm',
].join(' ');

export function compileProgram(compiler, source, compileDevice) {
  if (!compiler.FS.analyzePath('/workbench').exists) {
    compiler.FS.mkdir('/workbench');
    for (const [name, text] of Object.entries(programHeaders)) {
      compiler.FS.writeFile('/workbench/' + name, text);
    }
  }
  const device = compileDevice(compiler, source);
  const run = command => compiler.ccall('run_command', 'number', ['string'], [command]);
  if (device === null || run(hostCommand) !== 0 || run(linkCommand) !== 0) return null;
  return { device, host: compiler.FS.readFile('/host.wasm') };
}

const kernelSymbols = {
  hello: ['__device_stub__hello', '_Z20__device_stub__helloPf'],
  array: ['__device_stub__runKernel', '_Z24__device_stub__runKernelPKfPfi'],
};

function hexBuffer(buffer) {
  const view = new DataView(buffer);
  return Array.from({ length: buffer.byteLength / 4 }, (_, i) =>
    view.getUint32(i * 4, true).toString(16).padStart(8, '0')).join('');
}

export async function runProgram(program, launchDevice) {
  const module = await WebAssembly.compile(program.host);
  const buffers = new Map();
  const events = [];
  let nextAddress = 0x40000000;
  let instance, config, errorString, ptx;
  let argumentSlots = new Map();
  let stdout = '';
  let exitCode;

  function view() {
    return new DataView(instance.exports.memory.buffer);
  }

  function bytes(address, length) {
    return new Uint8Array(view().buffer, address >>> 0, length >>> 0);
  }

  function string(address) {
    const data = new Uint8Array(view().buffer);
    const end = data.indexOf(0, address >>> 0);
    if (end < 0 || end - (address >>> 0) > 4096) throw new Error('Invalid or oversized console string.');
    return new TextDecoder().decode(data.subarray(address >>> 0, end));
  }

  function print(formatAddress, offset) {
    const format = string(formatAddress);
    const text = format.replace(/%(?:\.\d+)?[a-zA-Z%]/g, specifier => {
      if (specifier === '%%') return '%';
      if (specifier === '%s' || specifier === '%d' || specifier === '%u') {
        const value = view().getUint32(offset, true);
        offset += 4;
        return specifier === '%s' ? string(value) : String(specifier === '%d' ? value | 0 : value);
      }
      if (!/^(%g|%f|%\.[0-9]f)$/.test(specifier)) {
        throw new Error('Console format ' + specifier + ' is unavailable.');
      }
      offset = (offset + 7) & ~7;
      const value = view().getFloat64(offset, true);
      offset += 8;
      return specifier === '%g' ? String(Number(value.toPrecision(6))) :
        value.toFixed(specifier === '%f' ? 6 : Number(specifier[2]));
    });
    if (stdout.length + text.length > 16_384) throw new Error('The console output limit was reached.');
    stdout += text;
    return text.length;
  }

  function bufferAt(address) {
    const buffer = buffers.get(address);
    if (!buffer) throw new Error('Use the device pointer returned by cudaMalloc.');
    return buffer;
  }

  const runtime = {
    cudaMalloc(pointer, size) {
      if (!size || size % 4 || size > 4096 || buffers.size >= 8) throw new Error('Allocate 1–1024 FP32 values per buffer.');
      const buffer = new ArrayBuffer(size);
      const cells = new DataView(buffer);
      for (let offset = 0; offset < size; offset += 4) cells.setUint32(offset, 0x7FC12345, true);
      view().setUint32(pointer, nextAddress, true);
      buffers.set(nextAddress, buffer);
      nextAddress += 4096;
      events.push(`cudaMalloc · ${size} bytes`);
      return 0;
    },
    cudaMemcpy(destination, source, size, direction) {
      if (direction !== 1 && direction !== 2) throw new Error('Use a host-to-device or device-to-host copy.');
      const buffer = bufferAt(direction === 1 ? destination : source);
      if (size < 0 || size > buffer.byteLength) throw new Error('Copy size exceeds the device allocation.');
      const host = bytes(direction === 1 ? source : destination, size);
      const device = new Uint8Array(buffer, 0, size);
      if (direction === 1) device.set(host);
      else host.set(device);
      events.push(`cudaMemcpy · ${size} bytes · ${direction === 1 ? 'host to device' : 'device to host'}`);
      return 0;
    },
    cudaConfigureCall(grid, block, shared, stream) {
      const dimension = ptr => [0, 4, 8].map(offset => view().getUint32(ptr + offset, true));
      const [blocks, gy, gz] = dimension(grid);
      const [threads, by, bz] = dimension(block);
      if ([gy, gz, by, bz].some(value => value !== 1) || shared || stream) throw new Error('Use a 1D launch and the default stream.');
      if (!blocks || blocks > 128 || !threads || threads > 256 || blocks * threads > 4096) {
        throw new Error('Use up to 128 blocks, 256 threads per block and 4096 threads total.');
      }
      config = { blocks, threads };
      argumentSlots = new Map();
      return 0;
    },
    cudaSetupArgument(pointer, size, offset) {
      if (size !== 4 || ![0, 4, 8].includes(offset)) throw new Error('Unexpected CUDA kernel argument.');
      argumentSlots.set(offset, view().getUint32(pointer, true));
      return 0;
    },
    cudaLaunch(pointer) {
      if (!config || ptx) throw new Error('Use one kernel launch per run.');
      const stub = instance.exports.__indirect_function_table.get(pointer);
      const profile = Object.keys(kernelSymbols).find(name =>
        kernelSymbols[name].some(symbol => instance.exports[symbol] === stub));
      if (!profile || !stub || argumentSlots.size !== (profile === 'hello' ? 1 : 3)) {
        throw new Error('Use the starter kernel signature. ' + JSON.stringify({pointer, exports:Object.keys(instance.exports), slots:[...argumentSlots], stub:stub?.name}));
      }
      const input = profile === 'hello' ? new ArrayBuffer(0) : bufferAt(argumentSlots.get(0));
      const output = bufferAt(argumentSlots.get(profile === 'hello' ? 0 : 4));
      const count = profile === 'hello' ? 0 : argumentSlots.get(8);
      const result = launchDevice([program.device, 'program', profile, config.blocks,
        config.threads, count, hexBuffer(input), hexBuffer(output)].map(String));
      if (result.hex.length !== output.byteLength * 2) throw new Error('The simulator returned an invalid output buffer.');
      const device = new DataView(output);
      for (let i = 0; i < result.hex.length; i += 8) {
        device.setUint32(i / 2, Number.parseInt(result.hex.slice(i, i + 8), 16), true);
      }
      const blocks = config.blocks === 1 ? '1 block' : `${config.blocks} blocks`;
      const threads = config.threads === 1 ? '1 thread' : `${config.threads} threads`;
      events.push(`${profile === 'hello' ? 'hello' : 'runKernel'} · ${blocks} × ${threads}`);
      ptx = result.ptx;
      return 0;
    },
    cudaFree(pointer) {
      if (!buffers.delete(pointer) && pointer) throw new Error('Invalid device pointer passed to cudaFree.');
      events.push('cudaFree');
      return 0;
    },
    cudaGetLastError: () => 0,
    cudaDeviceSynchronize: () => 0,
    cudaGetErrorString() { return errorString; },
    printf: print,
    fprintf(_stream, format, offset) { return print(format, offset); },
    exit(code) { exitCode = code; throw new WebAssembly.RuntimeError('Program exited.'); },
  };
  for (const { name, kind, module: namespace } of WebAssembly.Module.imports(module)) {
    if (namespace !== 'env' || kind !== 'function' || !Object.hasOwn(runtime, name)) {
      throw new Error('This program calls ' + name + ', which the browser runtime does not provide.');
    }
  }
  instance = await WebAssembly.instantiate(module, { env: runtime });
  errorString = (view().byteLength - 32) >>> 0;
  bytes(errorString, 13).set(new TextEncoder().encode('CUDA success\0'));
  try {
    exitCode = instance.exports.main(0, 0);
  } catch (error) {
    if (exitCode === undefined) throw error;
  }
  return { stdout, events, ptx, exitCode };
}
