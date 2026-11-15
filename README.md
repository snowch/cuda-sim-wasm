# cuda-sim-wasm

The first experiment builds Accel-Sim's trace frontend and the GPGPU-Sim timing model for native Linux and WebAssembly. It replays two synthetic SASS traces with the upstream A100 configuration. Each trace launches one 32-lane warp with one 4-byte global load per lane, followed by an exit instruction.

| Access pattern | Bytes between lane addresses | Simulated cycles | Simulated thread instructions | Global read requests |
| --- | ---: | ---: | ---: | ---: |
| Coalesced | 4 | 5,497 | 64 | 4 |
| Strided | 128 | 5,523 | 64 | 32 |

Native Linux, Node.js WebAssembly, and a Chromium Web Worker produced the same counters. The read count is the model's global read requests injected into the interconnect. The cycle counts describe this fixture and model configuration. These synthetic traces establish build and replay parity for two cases. Hardware accuracy, recorded workloads, editable kernels, and device performance are outside this experiment.

## Reproduce

Use Linux x86-64 with a C++17 compiler, CMake 3.20+, Make, Git, Flex, Bison, M4, zlib and zstd development headers, Python 3 with pip, Node.js, and Emscripten 4.0.23 active. The script fetches pinned upstream sources and CUDA headers. Trace replay requires no NVIDIA GPU.

```sh
./experiment/run.sh
```

The runner builds both targets under `.experiment/` and fails if their counters differ. It uses plain-text traces and reads them through the WebAssembly filesystem. AccelWattch is linked with power simulation disabled in the test configuration.

To repeat the browser check with Playwright available to Node and its Chromium browser installed, run the following command. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use a specific Chromium executable.

```sh
node experiment/browser-check.cjs .experiment/wasm
```

The first replay is a starting point for testing a short hardware-recorded trace and measuring the worker's startup and replay time on target devices.
