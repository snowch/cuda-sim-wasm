#pragma once

#include <string>

// Lower the supported LLVM IR instructions for the CUDA lesson.
std::string lower_ptx(const std::string &ir, bool hello = false);
