cmake_minimum_required(VERSION 3.25)
project(browser_nvptx LANGUAGES C CXX)
set(LLVM_SOURCE_ROOT "" CACHE PATH "Root of the llvm-project checkout")
if(NOT EXISTS "${LLVM_SOURCE_ROOT}/llvm/CMakeLists.txt")
  message(FATAL_ERROR "Set LLVM_SOURCE_ROOT to the pinned llvm-project checkout")
endif()
add_subdirectory("${LLVM_SOURCE_ROOT}/llvm" llvm)
add_executable(browser-nvptx main.cc)
target_include_directories(browser-nvptx PRIVATE
  "${LLVM_SOURCE_ROOT}/llvm/include"
  "${CMAKE_CURRENT_BINARY_DIR}/llvm/include")
target_link_libraries(browser-nvptx PRIVATE
  LLVMIRReader LLVMNVPTXCodeGen LLVMNVPTXDesc LLVMNVPTXInfo)
target_link_options(browser-nvptx PRIVATE
  -sMODULARIZE=1
  -sEXPORT_NAME=createNvptxCompiler
  -sALLOW_MEMORY_GROWTH=1
  -sSTACK_SIZE=2097152
  -sFORCE_FILESYSTEM=1
  -sEXPORTED_RUNTIME_METHODS=callMain,FS
  -sENVIRONMENT=worker,node)
set_target_properties(browser-nvptx PROPERTIES SUFFIX .js)
