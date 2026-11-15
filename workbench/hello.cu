extern "C" __global__
void runKernel(
    const float* input,
    float* output,
    int n
) {
    int i = blockIdx.x
        * blockDim.x + threadIdx.x;
    if (i < n) {
        output[i] = input[i] * 2.0f;
    }
}
