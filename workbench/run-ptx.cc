// Execute a single PTX teaching kernel in GPGPU-Sim's functional model.
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>

#include "abstract_hardware_model.h"
#include "cuda-sim/cuda-sim.h"
#include "cuda-sim/ptx_ir.h"
#include "gpgpu-sim/gpu-sim.h"
#include "gpgpu_context.h"
#include "lower-ptx.h"

int main(int argc, const char **argv) {
  if (argc != 2) {
    std::fprintf(stderr, "Usage: run-ptx '<LLVM IR>'\n");
    return 2;
  }

  std::string ptx;
  try {
    ptx = lower_ptx(argv[1]);
  } catch (const std::exception &error) {
    std::fprintf(stderr, "LOWERING_ERROR %s\n", error.what());
    return 2;
  }
  std::puts("PTX_BEGIN");
  std::fputs(ptx.c_str(), stdout);
  std::puts("PTX_END");

  setenv("PTX_SIM_MODE_FUNC", "1", 1);
  auto *context = GPGPU_Context();
  auto *gpu = context->gpgpu_ptx_sim_init_perf();
  auto *symbols = context->gpgpu_ptx_sim_load_ptx_from_string(ptx.c_str(), 1);
  auto *entry = symbols->lookup_function("runKernel");
  if (!entry) {
    std::fprintf(stderr, "The compiled PTX must define runKernel.\n");
    return 2;
  }

  // This fixed-ABI launch needs no ptxas resource report for functional execution.
  entry->set_kernel_info(gpgpu_ptx_sim_info{});
  const std::array<float, 5> input{1, 2, 3, 4, 5};
  std::array<float, 5> output;
  constexpr std::uint32_t unwritten = 0x7FC12345;
  for (auto &value : output) std::memcpy(&value, &unwritten, sizeof(value));
  const auto bytes = sizeof(input);
  const auto input_address = reinterpret_cast<std::uintptr_t>(gpu->gpu_malloc(bytes));
  const auto output_address = reinterpret_cast<std::uintptr_t>(gpu->gpu_malloc(bytes));
  gpu->memcpy_to_gpu(input_address, input.data(), bytes);
  gpu->memcpy_to_gpu(output_address, output.data(), bytes);

  // The nvptx64 ABI uses 64-bit device pointers on every simulator host.
  const std::uint64_t p_input = input_address;
  const std::uint64_t p_output = output_address;
  const std::int32_t count = input.size();
  const gpgpu_ptx_sim_arg_list_t arguments{
      {&count, sizeof(count), 16},
      {&p_output, sizeof(p_output), 8},
      {&p_input, sizeof(p_input), 0},
  };
  auto *simulator = context->func_sim;
  std::unique_ptr<kernel_info_t> launch(simulator->gpgpu_opencl_ptx_sim_init_grid(
      entry, arguments, dim3(2), dim3(4), gpu));
  simulator->gpgpu_cuda_ptx_sim_main_func(*launch, true);
  gpu->memcpy_from_gpu(output.data(), output_address, bytes);

  std::printf("OUTPUT_JSON [");
  const char *separator = "";
  for (const float value : output) {
    std::fputs(separator, stdout);
    std::uint32_t bits;
    std::memcpy(&bits, &value, sizeof(bits));
    if (bits == unwritten) std::fputs("null", stdout);
    else if (std::isfinite(value)) std::printf("%.9g", static_cast<double>(value));
    else if (std::isnan(value)) std::fputs("\"NaN\"", stdout);
    else std::fputs(std::signbit(value) ? "\"-Infinity\"" : "\"Infinity\"", stdout);
    separator = ",";
  }
  std::puts("]");
}
