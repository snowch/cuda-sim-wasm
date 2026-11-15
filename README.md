# cuda-sim-wasm

This experiment builds Accel-Sim's trace frontend and the GPGPU-Sim timing model for native Linux and WebAssembly. It compares cycles, thread instructions, global-memory read requests, and global-memory write requests after every kernel.

| Replay | GPU model | Kernels | Simulated cycles | Thread instructions | Global reads | Global writes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Synthetic coalesced load, 4-byte stride | A100 | 1 | 5,497 | 64 | 4 | 0 |
| Synthetic strided load, 128-byte stride | A100 | 1 | 5,523 | 64 | 32 | 0 |
| Rodinia LU decomposition, first kernel and input copy | V100 | 1 | 20,908 | 19,673 | 32 | 240 |
| Rodinia LU decomposition, full trace | V100 | 10 | 127,309 | 418,884 | 2,048 | 1,780 |
| Rodinia Needleman–Wunsch, full trace | V100 | 15 | 132,656 | 595,236 | 4,160 | 2,944 |

The read and write counts are global-memory requests injected into the modeled interconnect. These results verify cross-runtime replay parity. They do not measure hardware timing accuracy.

The hardware traces are from the [Accel-Sim pre-collected Rodinia suite](https://engineering.purdue.edu/tgrogers/accel-sim/traces/tesla-v100/latest/). The LU decomposition case uses the 64 × 64 input. Needleman–Wunsch uses dimension 128 and penalty 10. Both retain the original host-to-device copy records and kernel sequence.

Those input copies exposed a portability bug. On wasm32, `size_t` was too narrow for the recorded GPU addresses. The port now preserves 64-bit GPU addresses through trace parsing, address mapping, and the simulated L2 cache fill. Before that fix, WebAssembly reported 128,022 and 137,655 cycles for the two full traces.

## Reproduce

Use Linux x86-64 with a C++17 compiler, CMake 3.20+, Make, Git, Flex, Bison, M4, zlib and zstd development headers, Python 3.9+ with pip, Node.js, and Emscripten 4.0.23 active. The script fetches pinned upstream sources, CUDA headers, and the checksummed 20 MB trace archive. Trace replay requires no NVIDIA GPU.

```sh
./experiment/run.sh
```

The runner builds both targets under `.experiment/`, compares the two backends, and writes the native reference counters to `.experiment/results.json`. AccelWattch is linked with power simulation disabled in the tested configurations.

To repeat the Web Worker checks, make Playwright and Chromium available to Node and run the following command. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use a specific Chromium executable.

```sh
node experiment/browser-check.cjs .experiment/wasm .experiment/results.json
```

With Emscripten still active, generate an offline browser timing check for the first LU kernel. Open the resulting HTML in a browser with WebAssembly, Web Workers, and `DecompressionStream` support.

```sh
node experiment/tablet-check.cjs .experiment .experiment/tablet-check.html
```

The timing check reports asset unpacking, WebAssembly startup, and simulator initialization plus replay separately. Device performance depends on the browser and hardware.

## Physical Lenovo tablet result

The offline check passed on the physical Lenovo tablet. The first LU kernel matched the native reference on all four counters: 20,908 simulated cycles, 19,673 simulated instructions, 32 global reads, and 240 global writes.

| Measured phase | One run |
| --- | ---: |
| Asset unpacking | 101 ms |
| WebAssembly startup | 28 ms |
| Simulator initialization and replay | 1,235 ms |
| Sum of measured phases | 1,364 ms |

## Memory coalescing demo

The demo shows one aligned 4-byte load per lane, with a choice of 4- or 128-byte stride. The address diagram updates immediately. The Run simulation button replays the corresponding synthetic trace in the A100 timing model and checks its counters against the native reference.

Build the experiment first. With Emscripten still active, generate the self-contained page and open it in a browser.

```sh
node demo/build.cjs .experiment .experiment/memory-coalescing.html
```

The page runs offline with the two synthetic fixtures. Its worker compiles WebAssembly once and starts a fresh simulator instance per run. The timing table separates instance setup, simulator initialization and trace replay. Simulated GPU cycles and browser wall time describe different quantities.
