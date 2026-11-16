// Experimental browser device API for loading Clang-generated PTX modules.
#include <cstdint>
#include <memory>
#include <vector>
#include <emscripten.h>

#include "abstract_hardware_model.h"
#include "cuda-sim/cuda-sim.h"
#include "cuda-sim/ptx_ir.h"
#include "gpgpu-sim/gpu-sim.h"
#include "gpgpu_context.h"

namespace {
gpgpu_context *context;
gpgpu_sim *device;
symbol_table *symbols;
}

extern "C" {
EMSCRIPTEN_KEEPALIVE int load_module(const char *ptx) {
  if (symbols || !ptx || !*ptx) return 1;
  setenv("PTX_SIM_MODE_FUNC", "1", 1);
  context = GPGPU_Context();
  device = context->gpgpu_ptx_sim_init_perf();
  symbols = context->gpgpu_ptx_sim_load_ptx_from_string(ptx, 1);
  return symbols ? 0 : 1;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t allocate_buffer(unsigned bytes) {
  if (!device || bytes == 0 || bytes > 1048576) return 0;
  return reinterpret_cast<std::uintptr_t>(device->gpu_malloc(bytes));
}

EMSCRIPTEN_KEEPALIVE void upload_buffer(std::uint32_t target, const void *host, unsigned size) {
  device->memcpy_to_gpu(target, host, size);
}

EMSCRIPTEN_KEEPALIVE void download_buffer(void *host, std::uint32_t source, unsigned size) {
  device->memcpy_from_gpu(host, source, size);
}

EMSCRIPTEN_KEEPALIVE int launch_kernel(const char *name, const std::uint64_t *values,
                         const unsigned *sizes, const unsigned *offsets, unsigned count,
                         unsigned gx, unsigned gy, unsigned gz,
                         unsigned bx, unsigned by, unsigned bz) {
  if (!symbols || !name || count > 32 || !gx || !gy || !gz || !bx || !by || !bz ||
      std::uint64_t(gx) * gy * gz * bx * by * bz > 4096) return 1;
  auto *entry = symbols->lookup_function(name);
  if (!entry || !entry->is_entry_point()) return 1;
  entry->set_kernel_info(gpgpu_ptx_sim_info{});
  gpgpu_ptx_sim_arg_list_t arguments;
  for (unsigned i = 0; i < count; ++i) {
    if (sizes[i] == 0 || sizes[i] > sizeof(values[i])) return 1;
    arguments.emplace_front(&values[i], sizes[i], offsets[i]);
  }
  auto *simulator = context->func_sim;
  std::unique_ptr<kernel_info_t> launch(simulator->gpgpu_opencl_ptx_sim_init_grid(
      entry, arguments, dim3(gx, gy, gz), dim3(bx, by, bz), device));
  device->functional_launch(launch.get());
  simulator->gpgpu_cuda_ptx_sim_main_func(*launch, true);
  device->finish_functional_sim(launch.get());
  return 0;
}
}
