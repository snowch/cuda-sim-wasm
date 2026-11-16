// GPU Lab V2 · hello.cu
#include <cuda_runtime.h>
#include <cstdio>
#include <cstdlib>

void check(cudaError_t status) {
  if (status != cudaSuccess) {
    std::fprintf(stderr, "%s\n", cudaGetErrorString(status));
    std::exit(1);
  }
}
#define CUDA_CHECK(call) check(call)

__global__ void runKernel(
    const float* input, float* output, int n
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        output[i] = input[i] * 2.0f;
    }
}

int main() {
  const float x[] = {
    1.0f, 2.0f, 3.0f, 4.0f, 5.0f
  };
  const int n = sizeof(x) / sizeof(x[0]);
  float y[n];
  float *d_x, *d_y;

  CUDA_CHECK(cudaMalloc(&d_x, sizeof(x)));
  CUDA_CHECK(cudaMalloc(&d_y, sizeof(y)));

  CUDA_CHECK(cudaMemcpy(
      d_x, x, sizeof(x),
      cudaMemcpyHostToDevice));

  const int threadsPerBlock = 4;
  const int blocks =
      (n + threadsPerBlock - 1) / threadsPerBlock;
  runKernel<<<blocks, threadsPerBlock>>>(
      d_x, d_y, n);
  CUDA_CHECK(cudaGetLastError());
  CUDA_CHECK(cudaDeviceSynchronize());

  CUDA_CHECK(cudaMemcpy(
      y, d_y, sizeof(y),
      cudaMemcpyDeviceToHost));

  std::printf("Output: [");
  for (int i = 0; i < n; ++i) {
    std::printf("%s%g", i ? ", " : "", static_cast<double>(y[i]));
  }
  std::printf("]\n");
  CUDA_CHECK(cudaFree(d_x));
  CUDA_CHECK(cudaFree(d_y));
}
