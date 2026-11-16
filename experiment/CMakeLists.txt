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
add_library(trace_frontend OBJECT
    "${SIM}/main.cc"
    "${SIM}/accel-sim.cc"
    "${SIM}/trace-driven/trace_driven.cc"
    "${SIM}/trace-parser/trace_parser.cc")
target_include_directories(trace_frontend PRIVATE
    "${CMAKE_BINARY_DIR}"
    "${GPGPU_ROOT}/src"
    "${SIM}/ISA_Def"
    "${SIM}/trace-driven"
    "${SIM}/trace-parser"
    "${ACCEL_ROOT}/util/tracer_nvbit/tracer_tool")
target_link_libraries(trace_frontend PRIVATE cuda trace_zstd)

function(add_trace_replay target fixture)
    add_executable(${target}
        $<TARGET_OBJECTS:trace_frontend>
        $<TARGET_OBJECTS:gpgpusim_entrypoint>)
    target_link_libraries(${target} PRIVATE
        cuda ptxsim gpgpusim intersim accelwattch trace_zstd ${ZLIB_LINK})
    if(EMSCRIPTEN)
        set_target_properties(${target} PROPERTIES SUFFIX ".js")
        file(GLOB_RECURSE fixture_files CONFIGURE_DEPENDS "${fixture}/*")
        set_property(TARGET ${target} APPEND PROPERTY LINK_DEPENDS ${fixture_files})
        target_link_options(${target} PRIVATE -fexceptions
            -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=2097152
            -sENVIRONMENT=web,worker,node
            -sMODULARIZE=1 -sEXPORT_NAME=createTraceSimulator
            -sEXPORTED_RUNTIME_METHODS=callMain
            "SHELL:--preload-file ${fixture}@/fixture")
    endif()
endfunction()

add_trace_replay(trace-replay "${TRACE_FIXTURE}")
if(EMSCRIPTEN AND COALESCING_FIXTURE)
    add_trace_replay(coalescing-replay "${COALESCING_FIXTURE}")
endif()

if(COALESCING_FIXTURE)
    add_executable(run-ptx
        ../workbench/run-ptx.cc
        ../workbench/lower-ptx.cc
        $<TARGET_OBJECTS:gpgpusim_entrypoint>)
    target_include_directories(run-ptx PRIVATE "${GPGPU_ROOT}/src")
    target_link_libraries(run-ptx PRIVATE
        cuda ptxsim gpgpusim intersim accelwattch ${ZLIB_LINK})
    if(EMSCRIPTEN)
        set_target_properties(run-ptx PROPERTIES SUFFIX ".js")
        set(ptx_config "${COALESCING_FIXTURE}/gpgpusim.config")
        set_property(TARGET run-ptx APPEND PROPERTY LINK_DEPENDS "${ptx_config}")
        target_link_options(run-ptx PRIVATE -fexceptions
            -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=2097152
            -sENVIRONMENT=worker,node -sMODULARIZE=1 -sEXPORT_NAME=createPtxSimulator
            -sEXPORTED_RUNTIME_METHODS=callMain
            "SHELL:--embed-file ${ptx_config}@/gpgpusim.config")
    endif()
endif()

if(EMSCRIPTEN AND COALESCING_FIXTURE)
    add_executable(run-module ../workbench/run-module.cc
        $<TARGET_OBJECTS:gpgpusim_entrypoint>)
    target_include_directories(run-module PRIVATE "${GPGPU_ROOT}/src")
    target_link_libraries(run-module PRIVATE
        cuda ptxsim gpgpusim intersim accelwattch ${ZLIB_LINK})
    set_target_properties(run-module PROPERTIES SUFFIX ".js")
    set_property(TARGET run-module APPEND PROPERTY LINK_DEPENDS "${ptx_config}")
    target_link_options(run-module PRIVATE --no-entry -fexceptions
        -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=2097152
        -sENVIRONMENT=worker,node -sMODULARIZE=1 -sEXPORT_NAME=createModuleSimulator
        -sEXPORTED_FUNCTIONS=_malloc,_free -sEXPORTED_RUNTIME_METHODS=HEAPU8
        "SHELL:--embed-file ${ptx_config}@/gpgpusim.config")
endif()
