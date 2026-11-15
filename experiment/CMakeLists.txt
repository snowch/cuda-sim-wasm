cmake_minimum_required(VERSION 3.20)
project(cuda_sim_wasm_trace LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS ON)
add_compile_definitions(CUDART_VERSION=12080 DEBUG=0 TRACING_ON=1)
add_compile_options(-UNDEBUG)

find_package(BISON REQUIRED)
find_package(FLEX REQUIRED)
set(CUDAToolkit_INCLUDE_DIRS "${CUDA_HEADERS}" "${CUDA_CRT_HEADERS}")
include_directories(${CUDAToolkit_INCLUDE_DIRS})

if(EMSCRIPTEN)
    add_compile_options(-sUSE_ZLIB=1 -fexceptions)
    add_library(trace_zstd STATIC "${ZSTD_ROOT}/build/single_file_libs/zstddeclib.c")
    target_include_directories(trace_zstd PUBLIC "${ZSTD_ROOT}/lib")
    set(ZLIB_LINK -sUSE_ZLIB=1)
else()
    find_package(ZLIB REQUIRED)
    find_library(ZSTD_LIBRARY zstd REQUIRED)
    add_library(trace_zstd INTERFACE)
    target_link_libraries(trace_zstd INTERFACE "${ZSTD_LIBRARY}")
    set(ZLIB_LINK ZLIB::ZLIB)
endif()

# Use upstream source lists without the native CUDA/OpenGL discovery and
# replacement libcudart shared library. Trace replay runs synchronously.
set(GPGPUSIM_USE_POWER_MODEL TRUE)
set(GPGPUSIM_POWER_MODEL "${GPGPU_ROOT}/src/accelwattch")
add_custom_target(gen_build_string
    COMMAND ${CMAKE_COMMAND} -D INPUT_DIR=${GPGPU_ROOT}
        -D OUTPUT_DIR=${CMAKE_BINARY_DIR}
        -P ${GPGPU_ROOT}/gpgpusim_gen_build_string.cmake)

set(PROJECT_SOURCE_DIR "${GPGPU_ROOT}")
add_subdirectory("${GPGPU_ROOT}/src" gpgpu)
add_subdirectory("${GPGPU_ROOT}/libcuda" libcuda)
file(WRITE "${CMAKE_BINARY_DIR}/accelsim_version.h"
    "const char *g_accelsim_version = \"WebAssembly trace experiment\";\n")

set(SIM "${ACCEL_ROOT}/gpu-simulator")
add_executable(trace-replay
    "${SIM}/main.cc"
    "${SIM}/accel-sim.cc"
    "${SIM}/trace-driven/trace_driven.cc"
    "${SIM}/trace-parser/trace_parser.cc"
    $<TARGET_OBJECTS:gpgpusim_entrypoint>)
target_include_directories(trace-replay PRIVATE
    "${CMAKE_BINARY_DIR}"
    "${GPGPU_ROOT}/src"
    "${SIM}/ISA_Def"
    "${SIM}/trace-driven"
    "${SIM}/trace-parser"
    "${ACCEL_ROOT}/util/tracer_nvbit/tracer_tool")
target_link_libraries(trace-replay PRIVATE
    cuda ptxsim gpgpusim intersim accelwattch trace_zstd ${ZLIB_LINK})
if(EMSCRIPTEN)
    set_target_properties(trace-replay PROPERTIES SUFFIX ".js")
    file(GLOB_RECURSE fixture_files CONFIGURE_DEPENDS "${TRACE_FIXTURE}/*")
    set_property(TARGET trace-replay APPEND PROPERTY LINK_DEPENDS ${fixture_files})
    target_link_options(trace-replay PRIVATE -fexceptions
        -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=2097152
        -sENVIRONMENT=web,worker,node
        -sMODULARIZE=1 -sEXPORT_NAME=createTraceSimulator
        -sEXPORTED_RUNTIME_METHODS=callMain
        "SHELL:--preload-file ${TRACE_FIXTURE}@/fixture")
endif()
