// Compile the host and device from the same CUDA source. The worker supplies
// the CUDA runtime operations used by the architecture lessons.
const programHeaders = {
  'cuda_runtime.h': `
#pragma once
#define __device__ __attribute__((device))
#define __host__ __attribute__((host))
#define __shared__ __attribute__((shared))
using size_t = __SIZE_TYPE__;
using cudaError_t = int;
using cudaStream_t = void*;
using cudaEvent_t = void*;
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
cudaError_t cudaMallocHost(void**, size_t);
cudaError_t cudaFreeHost(void*);
cudaError_t cudaStreamCreate(cudaStream_t*);
cudaError_t cudaStreamDestroy(cudaStream_t);
cudaError_t cudaStreamSynchronize(cudaStream_t);
cudaError_t cudaEventCreate(cudaEvent_t*);
cudaError_t cudaEventDestroy(cudaEvent_t);
cudaError_t cudaEventRecord(cudaEvent_t, cudaStream_t);
cudaError_t cudaStreamWaitEvent(cudaStream_t, cudaEvent_t, unsigned);
cudaError_t cudaMemcpyAsync(void*, const void*, size_t, cudaMemcpyKind, cudaStream_t);
const char* cudaGetErrorString(cudaError_t);
}
__device__ inline int atomicAdd(int* address, int value) {
    int previous;
    asm volatile("atom.add.u32 %0, [%1], %2;" : "=r"(previous) : "l"(address), "r"(value) : "memory");
    return previous;
}
template<typename T> cudaError_t cudaMalloc(T** ptr, size_t bytes) {
    return cudaMalloc(reinterpret_cast<void**>(ptr), bytes);
}
template<typename T> cudaError_t cudaMallocHost(T** ptr, size_t bytes) {
    return cudaMallocHost(reinterpret_cast<void**>(ptr), bytes);
}
`,
  cmath: `
#pragma once
__attribute__((device)) inline float expf(float x) {
    float result;
    asm("ex2.approx.f32 %0, %1;" : "=f"(result) : "f"(x * 1.4426950408889634f));
    return result;
}
`,
  'cuda_fp16.h': `
#pragma once
using __half = _Float16;
inline __attribute__((host)) __attribute__((device)) __half __float2half_rn(float x) {
    return static_cast<__half>(x);
}
inline __attribute__((host)) __attribute__((device)) float __half2float(__half x) {
    return static_cast<float>(x);
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
function linkCommand(names) {
  return [
    'wasm-ld --no-entry --export=main --export-memory --export-table --max-memory=1048576',
    ...names.map(name => '--export-if-defined=' + name),
    '--allow-undefined /host.o -o /host.wasm',
  ].join(' ');
}

import { kernelStub } from './device.mjs';

export function installHeaders(compiler, matrixHeader) {
  if (!compiler.FS.analyzePath('/workbench').exists) {
    compiler.FS.mkdir('/workbench');
    if (matrixHeader) compiler.FS.writeFile('/workbench/mma.h', matrixHeader);
    for (const [name, text] of Object.entries(programHeaders)) {
      compiler.FS.writeFile('/workbench/' + name, text);
    }
  }
}

export function compileHost(compiler, source, kernels) {
  installHeaders(compiler);
  compiler.FS.writeFile('/kernel.cu', source);
  const run = command => compiler.ccall('run_command', 'number', ['string'], [command]);
  if (run(hostCommand) !== 0 || run(linkCommand([...kernels.keys()].map(kernelStub))) !== 0) return null;
  return compiler.FS.readFile('/host.wasm');
}

export async function runProgram(program, device) {
  const module = await WebAssembly.compile(program.host);
  const events = [];
  let instance, config, errorString;
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

  const streams = new Map([[0, null]]);
  const eventPoints = new Map();
  const hostBuffers = new Set();
  let nextHandle = 1;
  let operationsCount = 0;

  function getStream(id) {
    if (!streams.has(id)) throw new Error('Invalid CUDA stream.');
    return streams.get(id);
  }
  function getEvent(id) {
    if (!eventPoints.has(id)) throw new Error('Invalid CUDA event.');
    return eventPoints.get(id);
  }
  function queue(id, run, waitFor = null) {
    if (++operationsCount > 256) throw new Error('The stream operation limit was reached.');
    const op = { run, waitFor, previous: getStream(id), complete: false };
    streams.set(id, op);
    if (!id) flush(op);
  }
  function flush(op) {
    if (!op || op.complete) return;
    flush(op.previous);
    flush(op.waitFor);
    op.run();
    op.complete = true;
  }
  function createHandle(output, handles) {
    const id = nextHandle++;
    handles.set(id, null);
    view().setUint32(output, id, true);
    return 0;
  }
  function copy(destination, source, size, direction) {
    if (direction === 1) device.toDevice(destination >>> 0, bytes(source, size));
    else if (direction === 2) device.toHost(source >>> 0, bytes(destination, size));
    else throw new Error('Use a host-to-device or device-to-host copy.');
    events.push(`cudaMemcpy · ${size} bytes · ${direction === 1 ? 'host to device' : 'device to host'}`);
  }
  const runtime = {
    cudaMalloc(pointer, size) {
      if (size <= 0 || size > 1048576) throw new Error('Device allocation out of range.');
      view().setUint32(pointer, device.allocate(size), true);
      events.push(`cudaMalloc · ${size} bytes`);
      return 0;
    },
    cudaMemcpy(destination, source, size, direction) {
      for (const tail of streams.values()) flush(tail);
      copy(destination, source, size, direction);
      return 0;
    },
    cudaMemcpyAsync(destination, source, size, direction, stream) {
      queue(stream, () => copy(destination, source, size, direction));
      return 0;
    },
    cudaMallocHost(pointer, size) {
      if (size < 1 || size > 65536) throw new Error('Host allocation out of range.');
      const base = instance.exports.memory.grow(1) * 65536;
      view().setUint32(pointer, base, true);
      hostBuffers.add(base);
      return 0;
    },
    cudaFreeHost(pointer) {
      if (!hostBuffers.delete(pointer >>> 0)) throw new Error('Invalid pinned host buffer.');
      return 0;
    },
    cudaStreamCreate: ptr => createHandle(ptr, streams),
    cudaStreamDestroy(id) {
      flush(getStream(id));
      streams.delete(id);
      return 0;
    },
    cudaStreamSynchronize(id) {
      flush(getStream(id));
      return 0;
    },
    cudaEventCreate: ptr => createHandle(ptr, eventPoints),
    cudaEventDestroy(id) {
      getEvent(id);
      eventPoints.delete(id);
      return 0;
    },
    cudaEventRecord(id, stream) {
      getEvent(id);
      eventPoints.set(id, getStream(stream));
      return 0;
    },
    cudaStreamWaitEvent(stream, id, flags) {
      if (flags) throw new Error('Use zero flags with cudaStreamWaitEvent.');
      queue(stream, () => {}, getEvent(id));
      return 0;
    },
    cudaConfigureCall(gridPtr, blockPtr, shared, stream) {
      const dimension = ptr => [0, 4, 8].map(offset => view().getUint32(ptr + offset, true));
      const grid = dimension(gridPtr);
      const block = dimension(blockPtr);
      if (shared) throw new Error('Use static shared memory for this launch.');
      getStream(stream);
      const dim = [...grid, ...block];
      if (dim.some(size => size < 1 || size > 1024) ||
          dim.reduce((a, b) => a * b, 1) > 4096) throw new Error('Launch up to 4096 threads.');
      config = {grid, block, stream};
      argumentSlots = new Map();
      return 0;
    },
    cudaSetupArgument(pointer, size, offset) {
      if (![1, 2, 4, 8].includes(size)) throw new Error('Unexpected CUDA kernel argument.');
      argumentSlots.set(offset, bytes(pointer, size).slice());
      return 0;
    },
    cudaLaunch(pointer) {
      if (!config) throw new Error('Missing CUDA launch configuration.');
      const stub = instance.exports.__indirect_function_table.get(pointer);
      const name = [...program.kernels.keys()].find(name => instance.exports[kernelStub(name)] === stub);
      if (!name || !stub) throw new Error('The requested kernel entry could not be found.');
      const values = [...argumentSlots].sort(([a], [b]) => a - b).map(([, bytes]) => bytes);
      const {grid, block, stream} = config;
      queue(stream, () => {
        device.launch(name, program.kernels.get(name), values, grid, block);
        events.push(`${name} · grid ${grid.join(' × ')} · block ${block.join(' × ')}`);
      });
      config = undefined;
      return 0;
    },
    cudaFree(pointer) {
      device.free(pointer >>> 0);
      events.push('cudaFree');
      return 0;
    },
    memcpy(destination, source, count) { bytes(destination, count).set(bytes(source, count)); return destination; },
    memmove(destination, source, count) { bytes(destination, count).set(bytes(source, count)); return destination; },
    memset(destination, value, count) { bytes(destination, count).fill(value); return destination; },
    cudaGetLastError: () => 0,
    cudaDeviceSynchronize() { for (const tail of streams.values()) flush(tail); return 0; },
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
    for (const tail of streams.values()) flush(tail);
  } catch (error) {
    if (exitCode === undefined) throw error;
  }
  return { stdout, events, ptx: program.ptx, exitCode };
}
