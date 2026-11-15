#!/usr/bin/env bash
set -euo pipefail
experiment=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
work="$experiment/../.experiment"
mkdir -p "$work"
work=$(cd "$work" && pwd)
jobs=${JOBS:-4}

checkout() {
    local dir="$1" url="$2" sha="$3" patch="${4:-}"
    if [[ -d "$dir/.git" ]]; then
        test "$(git -C "$dir" rev-parse HEAD)" = "$sha"
        if [[ -n "$patch" ]]; then
            git -C "$dir" apply --reverse --check "$patch"
        fi
        return
    fi
    local pending
    pending=$(mktemp -d "$work/checkout.XXXXXX")
    (
        trap 'rm -rf "$pending"' EXIT
        git -C "$pending" init -q
        git -C "$pending" fetch -q --depth 1 "$url" "$sha"
        git -C "$pending" checkout -q --detach FETCH_HEAD
        if [[ -n "$patch" ]]; then
            git -C "$pending" apply "$patch"
        fi
        mv "$pending" "$dir"
    )
}

checkout "$work/accel" https://github.com/accel-sim/accel-sim-framework.git \
    7ba54ded60c4ba0083410c37d22d719166acd6dc "$experiment/patches/accel-sim.patch"
checkout "$work/gpgpu" https://github.com/accel-sim/gpgpu-sim_distribution.git \
    4195dd4f229cbf03f4f38c49139ae94d01d23f03 "$experiment/patches/gpgpu-sim.patch"
checkout "$work/zstd" https://github.com/facebook/zstd.git \
    f8745da6ff1ad1e7bab384bd1f9d742439278e99
(
    cd "$work/zstd/build/single_file_libs"
    ./create_single_file_decoder.sh
)

if [[ -z "${CUDA_HEADERS:-}" || -z "${CUDA_CRT_HEADERS:-}" ]]; then
    CUDA_HEADERS="$work/cuda/nvidia/cuda_runtime/include"
    CUDA_CRT_HEADERS="$work/cuda/nvidia/cuda_nvcc/include"
    if [[ ! -f "$CUDA_HEADERS/cuda_runtime.h" || ! -f "$CUDA_CRT_HEADERS/crt/host_config.h" ]]; then
        python3 -m pip install --upgrade --target "$work/cuda" \
            nvidia-cuda-runtime-cu12==12.8.90 nvidia-cuda-nvcc-cu12==12.8.93
    fi
fi

mkdir -p "$work/fixture/traces"
cp -p "$work/gpgpu/configs/tested-cfgs/SM80_A100/gpgpusim.config" "$work/fixture/"
cp -p "$work/accel/gpu-simulator/configs/tested-cfgs/SM80_A100/trace.config" "$work/fixture/"
cp -p "$experiment"/traces/* "$work/fixture/traces/"
mkdir -p "$work/coalescing-fixture/traces"
cp -p "$work/fixture/"{gpgpusim.config,trace.config} "$work/coalescing-fixture/"
cp -p "$experiment"/traces/* "$work/coalescing-fixture/traces/"
python3 "$experiment/prepare-hardware.py" "$work"
mkdir -p "$work/fixture/hardware/volta"
cp -p "$work/gpgpu/configs/tested-cfgs/SM7_GV100/gpgpusim.config" "$work/fixture/hardware/volta/"
cp -p "$work/accel/gpu-simulator/configs/tested-cfgs/SM7_GV100/trace.config" "$work/fixture/hardware/volta/"

options=(-S "$experiment"
    -DACCEL_ROOT="$work/accel" -DGPGPU_ROOT="$work/gpgpu"
    -DZSTD_ROOT="$work/zstd" -DTRACE_FIXTURE="$work/fixture"
    -DCOALESCING_FIXTURE="$work/coalescing-fixture"
    -DCUDA_HEADERS="$CUDA_HEADERS" -DCUDA_CRT_HEADERS="$CUDA_CRT_HEADERS"
    -DCMAKE_CXX_FLAGS=-O1)
cmake "${options[@]}" -B "$work/native"
cmake --build "$work/native" --parallel "$jobs"
emcmake cmake "${options[@]}" -B "$work/wasm"
cmake --build "$work/wasm" --parallel "$jobs"

node "$experiment/compare.cjs" "$work/native/trace-replay" \
    "$work/fixture" "$work/wasm/trace-replay.js" "$work/results.json"
