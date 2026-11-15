# Editable CUDA workbench

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
