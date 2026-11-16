#include <cstdio>
#include <string>
#include "llvm-c/Core.h"
#include "llvm-c/IRReader.h"
#include "llvm-c/Target.h"
#include "llvm-c/TargetMachine.h"

// Each line gives the source entry, followed by its arguments. A pointer is
// tagged P so the Wasm host can widen its 32-bit handle to the PTX 64-bit ABI.
bool write_kernels(LLVMModuleRef module, const char *path) {
  auto *out = std::fopen(path, "w");
  if (!out) return false;
  bool valid = true;
  for (auto fn = LLVMGetFirstFunction(module); fn; fn = LLVMGetNextFunction(fn)) {
    if (LLVMGetFunctionCallConv(fn) != LLVMPTXKernelCallConv) continue;
    std::size_t size;
    const auto *name = LLVMGetValueName2(fn, &size);
    std::fwrite(name, 1, size, out);
    for (auto arg = LLVMGetFirstParam(fn); arg; arg = LLVMGetNextParam(arg)) {
      auto type = LLVMTypeOf(arg);
      switch (LLVMGetTypeKind(type)) {
        case LLVMPointerTypeKind: std::fputs(" P", out); break;
        case LLVMIntegerTypeKind: std::fprintf(out, " %u", (LLVMGetIntTypeWidth(type) + 7) / 8); break;
        case LLVMHalfTypeKind:
        case LLVMBFloatTypeKind: std::fputs(" 2", out); break;
        case LLVMFloatTypeKind: std::fputs(" 4", out); break;
        case LLVMDoubleTypeKind: std::fputs(" 8", out); break;
        default: valid = false; break;
      }
    }
    std::fputc('\n', out);
  }
  std::fclose(out);
  return valid;
}

int main(int argc, char **argv) {
  if (argc != 4) {
    std::fputs("Usage: browser-nvptx input.ll output.ptx kernels.txt\n", stderr);
    return 2;
  }
  LLVMInitializeNVPTXTargetInfo();
  LLVMInitializeNVPTXTarget();
  LLVMInitializeNVPTXTargetMC();
  LLVMInitializeNVPTXAsmPrinter();
  LLVMContextRef context = LLVMContextCreate();
  LLVMMemoryBufferRef input;
  LLVMModuleRef module = nullptr;
  LLVMTargetMachineRef machine = nullptr;
  char *error = nullptr;
  bool failed = LLVMCreateMemoryBufferWithContentsOfFile(argv[1], &input, &error) ||
                LLVMParseIRInContext(context, input, &module, &error);
  if (!failed) {
    const char *triple = "nvptx64-nvidia-cuda";
    LLVMTargetRef target;
    failed = LLVMGetTargetFromTriple(triple, &target, &error);
    if (!failed) {
      machine = LLVMCreateTargetMachine(target, triple, "sm_70", "+ptx60",
          LLVMCodeGenLevelDefault, LLVMRelocDefault, LLVMCodeModelDefault);
      LLVMSetTarget(module, triple);
      failed = LLVMTargetMachineEmitToFile(machine, module, argv[2], LLVMAssemblyFile, &error);
      if (!failed && !write_kernels(module, argv[3])) {
        std::fputs("Could not write the kernel argument layout.\n", stderr);
        failed = true;
      }
    }
  }
  if (error) {
    std::fprintf(stderr, "%s\n", error);
    LLVMDisposeMessage(error);
  }
  if (machine) LLVMDisposeTargetMachine(machine);
  if (module) LLVMDisposeModule(module);
  LLVMContextDispose(context);
  return failed;
}
