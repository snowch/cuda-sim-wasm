# Editable CUDA workbench

The course can enable full-program mode by setting `data-program="true"` on the
workbench document. Clang compiles the same source for the Wasm host and the
CUDA device. The worker binds the host CUDA calls to FP32 device buffers and
a bounded one-dimensional GPGPU-Sim launch. It reports the output from
`main()` and the actual allocation, copy and launch calls.

`first-program.cu` and `program.cu` are the full-program starters. Run
`check.mjs` to verify that editing the host input and launch changes the
simulated execution, and that edits to the kernel and host output take effect.

Use `?embed=hello` to open the one-thread introduction. The editor compiles
`__global__ void hello(float* output)`, and the runner launches one block with
one thread and copies back one float. `first-kernel.cu` supplies the editable
starter. The original `runKernel` activity still uses the five-element launch.


The first GPU Lab V2 exercise lets a learner edit a CUDA device kernel and run
the result entirely in the browser. Try a different multiplier, add an offset,
or reduce the bounds check by one to leave the last output unwritten.

The workbench uses the Clang frontend in LLVM Explorer's WebAssembly runtime.
Clang emits 64-bit CUDA LLVM IR for the exact editor text. This workbench lowers
the supported IR instructions to PTX and executes them in GPGPU-Sim's functional
model. It provides a fixed harness with the input values 1–5 and two blocks of
four threads. The workbench reports simulated output values and displays the PTX.
It has no measured GPU timings.

The teaching backend supports a fixed kernel signature, FP32 loads, stores,
addition, subtraction and multiplication, integer indexing, and basic control
flow. Other IR instructions produce a diagnostic. Clang errors are shown against
the edited source. The worker retains Clang between runs and creates a fresh
simulator instance for each launch. Stop terminates the worker.

## Build and check

Build the native and WebAssembly targets with the experiment's prerequisites and
Emscripten active.

```sh
./experiment/run.sh
```

Obtain `Compiler.js`, `Compiler.wasm` and `Compiler.data` from the
[LLVM Explorer compiler directory](https://llvm-explorer.dev/compiler/manifest.json).
The SHA-256 digests in `compiler-assets.json` pin the supported runtime.
Use the licence notices from [the LLVM Explorer runtime](https://github.com/afshin/llvm-explorer/tree/main/runtime/licenses).

```sh
mkdir -p .experiment/clang
for file in Compiler.js Compiler.wasm Compiler.data; do
  curl -fL "https://llvm-explorer.dev/compiler/$file" -o ".experiment/clang/$file"
done
node workbench/check.mjs .experiment/clang .experiment/wasm
node workbench/build-preview.mjs .experiment/wasm .experiment/clang \
  .experiment /path/to/llvm-explorer/runtime/licenses "$EMSDK/upstream/emscripten" \
  .experiment/GPU-Lab-CUDA-workbench.html
```

Open the generated HTML in Chromium. Its bundled compiler runs offline. Add
`--online` to produce the smaller GPU Lab page, which downloads the same pinned
compiler assets on the first run. Compiler diagnostics and the learner's source
stay in the browser.

## Lenovo tablet check

The offline starter kernel compiled and ran on a physical Lenovo tablet. For
inputs 1 through 5, the page displayed `[2, 4, 6, 8, 10]`. Separate Chromium
browser tests verified edited kernels and compiler diagnostics.

## CUDA module workbench

The architecture lessons compile the whole editable program. Build the
`run-module` target alongside `run-ptx` with the Emscripten configuration
created by `experiment/run.sh`. It adds a device API that preserves device
memory across CUDA launches in one run. Each run starts a fresh simulator.
The host runtime provides CUDA calls for allocation, copies, launch, streams
and events. Stream dependencies determine execution order. Use the course's
architecture models for timing investigations.

Build the NVPTX backend from
[LLVM 23.1.0](https://github.com/llvm/llvm-project/tree/ea7d852a70e8bdfaf601d6626a760f9771b2c4b4)
with Emscripten and the WasmBolt frontend version in `compiler-assets.json`.
With the checkout in `llvm-project`, run:

```sh
emcmake cmake -S workbench/nvptx -B .experiment/nvptx \
  -DLLVM_SOURCE_ROOT="$PWD/llvm-project" -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DLLVM_TARGETS_TO_BUILD=NVPTX -DLLVM_HOST_TRIPLE=wasm32-unknown-emscripten \
  -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_UTILS=OFF -DLLVM_INCLUDE_TOOLS=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF \
  -DLLVM_ENABLE_THREADS=OFF -DLLVM_ENABLE_BINDINGS=OFF -DLLVM_ENABLE_ASSERTIONS=OFF
cmake --build .experiment/nvptx --target browser-nvptx --parallel
cmake --build .experiment/wasm --target run-module --parallel
node workbench/bundle-module.mjs .experiment/nvptx .experiment/wasm /path/to/gpu-lab/assets/cuda-workbench
```

Set `WORKBENCH_MODULE_DIR` to the directory passed to `bundle-module.mjs`
when running `build-preview.mjs`. The hosted build loads the module assets on
the first architecture run. The standalone offline workbench embeds them.
GPU Lab's build fills in its editable architecture starters.
