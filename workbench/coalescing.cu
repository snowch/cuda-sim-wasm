// Copyright © 2026 Christopher Snow.
#include <cuda_runtime.h>
#include <cstdio>

__global__ void runKernel(const float* input, float* output, int n) {
    constexpr int stride = 1;
    static_assert(stride >= 1 && stride <= 32, "Choose a stride from 1 to 32");
    int lane = blockIdx.x * blockDim.x + threadIdx.x;
    if (lane < n) output[lane] = input[lane * stride];
}

int main() {
    constexpr int lanes = 32;
    constexpr int capacity = 993;
    float input[capacity];
    for (int i = 0; i < capacity; ++i) input[i] = static_cast<float>(i);
    float* deviceInput;
    float* deviceOutput;
    if (cudaMalloc(&deviceInput, sizeof(input))) return 1;
    float values[lanes];
    if (cudaMalloc(&deviceOutput, sizeof(values))) return 1;
    if (cudaMemcpy(deviceInput, input, sizeof(input), cudaMemcpyHostToDevice)) return 1;
    runKernel<<<1, lanes>>>(deviceInput, deviceOutput, lanes);
    if (cudaGetLastError()) return 1;
    if (cudaMemcpy(values, deviceOutput, sizeof(values), cudaMemcpyDeviceToHost)) return 1;

    // The input stores each element's own index, so the returned values
    // identify the words each lane read. Group those indices into sectors.
    bool seen[(capacity + 7) / 8] = {};
    int sectors = 0;
    for (int lane = 0; lane < lanes; ++lane) {
        int index = static_cast<int>(values[lane]);
        if (index < 0 || index >= capacity) return 1;
        auto sector = index / 8;
        if (!seen[sector]) {
            seen[sector] = true;
            ++sectors;
        }
    }
    std::printf("Sectors touched: %d\n", sectors);
    cudaFree(deviceOutput);
    cudaFree(deviceInput);
}
