// Copyright © 2026 Christopher Snow.
#include <cuda_runtime.h>
#include <cstdio>
#include <cstdlib>

__global__ void hello(float* output) {
    output[0] = 42.0f;
}

void check(cudaError_t result) {
    if (result != cudaSuccess) {
        std::fprintf(stderr, "%s\n", cudaGetErrorString(result));
        std::exit(EXIT_FAILURE);
    }
}

int main() {
    float* output = nullptr;
    check(cudaMalloc(&output, sizeof(float)));

    hello<<<1, 1>>>(output);
    check(cudaGetLastError());

    float value = 0.0f;
    check(cudaMemcpy(&value, output, sizeof(value), cudaMemcpyDeviceToHost));
    std::printf("%.1f\n", value);
    check(cudaFree(output));
}
