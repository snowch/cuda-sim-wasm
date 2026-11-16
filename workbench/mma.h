#pragma once
#include <cuda_fp16.h>

namespace nvcuda::wmma {
struct matrix_a {};
struct matrix_b {};
struct accumulator {};
struct row_major {};
enum layout_t { mem_row_major };

template<class Role, int M, int N, int K, class T, class Layout = void>
struct fragment;
template<class Role>
struct fragment<Role, 16, 16, 16, __half, row_major> { unsigned registers[8]; };
template<>
struct fragment<accumulator, 16, 16, 16, float> { float registers[8]; };

using A = fragment<matrix_a, 16, 16, 16, __half, row_major>;
using B = fragment<matrix_b, 16, 16, 16, __half, row_major>;
using C = fragment<accumulator, 16, 16, 16, float>;

__device__ inline void fill_fragment(C& dst, float value) {
    for (float& reg : dst.registers) reg = value;
}
#define GPU_LAB_WMMA_REGS(F, R) \
    F(R[0]), F(R[1]), F(R[2]), F(R[3]), F(R[4]), F(R[5]), F(R[6]), F(R[7])
#define GPU_LAB_WMMA_WRITE_U(R) "=r"(R)
#define GPU_LAB_WMMA_READ_U(R) "r"(R)
#define GPU_LAB_WMMA_WRITE_F(R) "=f"(R)
#define GPU_LAB_WMMA_READ_F(R) "f"(R)
#define GPU_LAB_WMMA_LOAD(TYPE, ROLE) \
__device__ inline void load_matrix_sync(TYPE& dst, const __half* ptr, unsigned stride) { \
    asm volatile("wmma.load." ROLE ".sync.aligned.row.m16n16k16.global.f16 " \
                 "{%0,%1,%2,%3,%4,%5,%6,%7}, [%8], %9;" \
        : GPU_LAB_WMMA_REGS(GPU_LAB_WMMA_WRITE_U, dst.registers) : "l"(ptr), "r"(stride) : "memory"); \
}
GPU_LAB_WMMA_LOAD(A, "a")
GPU_LAB_WMMA_LOAD(B, "b")
__device__ inline void mma_sync(C& dst, const A& a, const B& b, const C& c) {
    asm("wmma.mma.sync.aligned.row.row.m16n16k16.f32.f32 "
        "{%0,%1,%2,%3,%4,%5,%6,%7}, {%8,%9,%10,%11,%12,%13,%14,%15}, "
        "{%16,%17,%18,%19,%20,%21,%22,%23}, {%24,%25,%26,%27,%28,%29,%30,%31};"
        : GPU_LAB_WMMA_REGS(GPU_LAB_WMMA_WRITE_F, dst.registers)
        : GPU_LAB_WMMA_REGS(GPU_LAB_WMMA_READ_U, a.registers),
          GPU_LAB_WMMA_REGS(GPU_LAB_WMMA_READ_U, b.registers),
          GPU_LAB_WMMA_REGS(GPU_LAB_WMMA_READ_F, c.registers));
}
__device__ inline void store_matrix_sync(float* ptr, const C& value, unsigned stride, layout_t) {
    asm volatile("wmma.store.d.sync.aligned.row.m16n16k16.global.f32 "
                 "[%0], {%1,%2,%3,%4,%5,%6,%7,%8}, %9;"
        :: "l"(ptr), GPU_LAB_WMMA_REGS(GPU_LAB_WMMA_READ_F, value.registers), "r"(stride) : "memory");
}
#undef GPU_LAB_WMMA_LOAD
#undef GPU_LAB_WMMA_READ_F
#undef GPU_LAB_WMMA_WRITE_F
#undef GPU_LAB_WMMA_READ_U
#undef GPU_LAB_WMMA_WRITE_U
#undef GPU_LAB_WMMA_REGS
}
