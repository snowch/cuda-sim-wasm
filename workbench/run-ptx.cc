// Execute a single PTX teaching kernel in GPGPU-Sim's functional model.
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <stdexcept>
#include <vector>

#include "abstract_hardware_model.h"
#include "cuda-sim/cuda-sim.h"
#include "cuda-sim/ptx_ir.h"
#include "gpgpu-sim/gpu-sim.h"
#include "gpgpu_context.h"
#include "lower-ptx.h"

namespace {

constexpr std::uint32_t unwritten = 0x7FC12345;

unsigned parse_dimension(const char *text, unsigned limit) {
  std::size_t consumed = 0;
  const auto value = std::stoul(text, &consumed);
  if (text[consumed] || !value || value > limit)
    throw std::runtime_error("Launch dimension out of range.");
  return value;
}

std::vector<float> float_buffer(const std::string &hex) {
  if (hex.size() % 8 || hex.size() > 8192)
    throw std::runtime_error("Expected up to 1024 FP32 values.");
  std::vector<float> values(hex.size() / 8);
  for (std::size_t i = 0; i < values.size(); ++i) {
    const auto word = hex.substr(i * 8, 8);
    std::size_t end = 0;
    const std::uint32_t bits = std::stoul(word, &end, 16);
    if (end != 8) throw std::runtime_error("Invalid device buffer.");
    std::memcpy(&values[i], &bits, sizeof(bits));
  }
  return values;
}

} // namespace

int main(int argc, const char **argv) {
  const bool program = argc == 9 && std::strcmp(argv[2], "program") == 0;
  const bool hello = (argc == 3 && std::strcmp(argv[2], "hello") == 0) ||
                     (program && std::strcmp(argv[3], "hello") == 0);
  if (argc != 2 && !hello && !program) {
    std::fprintf(stderr, "Usage: run-ptx '<LLVM IR>' [hello or program arguments]\n");
    return 2;
  }

  auto blocks = hello ? 1u : 2u;
  auto threads = hello ? 1u : 4u;
  std::vector<float> input{1, 2, 3, 4, 5};
  std::vector<float> output(hello ? 1 : input.size());
  for (auto &value : output) std::memcpy(&value, &unwritten, sizeof(value));
  std::int32_t count = input.size();

  std::string ptx;
  try {
    if (program) {
      if (!hello && std::strcmp(argv[3], "array") != 0)
        throw std::runtime_error("Unknown kernel profile.");
      blocks = parse_dimension(argv[4], 128);
      threads = parse_dimension(argv[5], 256);
      if (blocks * threads > 4096) throw std::runtime_error("Use at most 4096 threads.");
      input = float_buffer(argv[7]);
      output = float_buffer(argv[8]);
      count = hello ? 0 : parse_dimension(argv[6], 1024);
      if (output.empty() || (!hello && (count > input.size() || count > output.size())))
        throw std::runtime_error("The kernel arguments exceed the allocated arrays.");
    }
    ptx = lower_ptx(argv[1], hello);
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
  auto *entry = symbols->lookup_function(hello ? "hello" : "runKernel");
  if (!entry) {
    std::fprintf(stderr, "The compiled PTX has no teaching kernel entry.\n");
    return 2;
  }

  // This fixed-ABI launch needs no ptxas resource report for functional execution.
  entry->set_kernel_info(gpgpu_ptx_sim_info{});
  const auto output_bytes = output.size() * sizeof(float);
  const auto output_address = reinterpret_cast<std::uintptr_t>(gpu->gpu_malloc(output_bytes));
  gpu->memcpy_to_gpu(output_address, output.data(), output_bytes);

  // The nvptx64 ABI uses 64-bit device pointers on every simulator host.
  std::uint64_t p_input = 0;
  const std::uint64_t p_output = output_address;
  gpgpu_ptx_sim_arg_list_t arguments;
  if (hello) {
    arguments.emplace_back(&p_output, sizeof(p_output), 0);
  } else {
    const auto input_bytes = input.size() * sizeof(float);
    p_input = reinterpret_cast<std::uintptr_t>(gpu->gpu_malloc(input_bytes));
    gpu->memcpy_to_gpu(p_input, input.data(), input_bytes);
    arguments.emplace_back(&count, sizeof(count), 16);
    arguments.emplace_back(&p_output, sizeof(p_output), 8);
    arguments.emplace_back(&p_input, sizeof(p_input), 0);
  }
  auto *simulator = context->func_sim;
  std::unique_ptr<kernel_info_t> launch(simulator->gpgpu_opencl_ptx_sim_init_grid(
      entry, arguments, dim3(blocks), dim3(threads), gpu));
  simulator->gpgpu_cuda_ptx_sim_main_func(*launch, true);
  gpu->memcpy_from_gpu(output.data(), output_address, output_bytes);

  if (program) {
    std::fputs("OUTPUT_HEX ", stdout);
    for (const auto value : output) {
      std::uint32_t bits;
      std::memcpy(&bits, &value, sizeof(bits));
      std::printf("%08x", static_cast<unsigned>(bits));
    }
    std::puts("");
    return 0;
  }
  std::printf("OUTPUT_JSON [");
  const char *separator = "";
  for (std::size_t i = 0; i < output.size(); ++i) {
    const float value = output[i];
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
