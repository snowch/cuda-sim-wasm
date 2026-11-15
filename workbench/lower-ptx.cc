#include "lower-ptx.h"

#include <cstdint>
#include <cstring>
#include <iomanip>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <unordered_map>

namespace {

std::string float_literal(const std::string &operand) {
  float result;
  if (operand.rfind("0x", 0) == 0) {
    const std::uint64_t bits = std::stoull(operand, nullptr, 16);
    double value;
    std::memcpy(&value, &bits, sizeof(value));
    result = static_cast<float>(value);
  } else {
    std::size_t consumed = 0;
    result = std::stof(operand, &consumed);
    if (consumed != operand.size())
      throw std::runtime_error("Unsupported floating-point constant: " + operand);
  }
  std::uint32_t bits;
  std::memcpy(&bits, &result, sizeof(bits));
  std::ostringstream out;
  out << "0f" << std::hex << std::setw(8) << std::setfill('0') << bits;
  return out.str();
}

class Ptx {
 public:
  void parameter(const std::string &name, char kind, int index) {
    const auto operation = kind == 'd' ? "ld.param.u64" : "ld.param.u32";
    emit(operation, output(name, kind), "[arg" + std::to_string(index) + "]");
  }

  void instruction(const std::string &line) {
    static const std::regex label_pattern(R"(^([\w.$-]+):$)");
    static const std::regex special(R"(^(?:tail )?call (?:noundef )?i32 @llvm\.nvvm\.read\.ptx\.sreg\.(ctaid|ntid|tid)\.x\(\)$)");
    static const std::regex integer(R"(^(add|sub|mul|shl)(?:(?: nuw| nsw)*) i32 ([^, ]+), ([^, ]+)$)");
    static const std::regex compare(R"(^icmp (eq|ne|slt|sle|sgt|sge|ult|ule|ugt|uge) i32 ([^, ]+), ([^, ]+)$)");
    static const std::regex extend(R"(^(sext|zext)(?: nneg)? i32 ([^ ]+) to i64$)");
    static const std::regex address(R"(^getelementptr(?: inbounds| nusw| nuw)* (float|\[4 x i8\]), ptr (%[^, ]+), i64 ([^, ]+)$)");
    static const std::regex read(R"(^load float, ptr (%[^, ]+), align 4$)");
    static const std::regex write(R"(^store float ([^, ]+), ptr (%[^, ]+), align 4$)");
    static const std::regex fp(R"(^(fadd|fsub|fmul) float ([^, ]+), ([^, ]+)$)");
    static const std::regex neg(R"(^fneg float ([^, ]+)$)");
    static const std::regex select(R"(^select i1 (%[^, ]+), float ([^, ]+), float ([^, ]+)$)");
    static const std::regex conditional(R"(^br i1 (%[^, ]+), label %([^, ]+), label %([^, ]+)$)");
    static const std::regex jump(R"(^br label %([^, ]+)$)");

    std::smatch match;
    if (std::regex_match(line, match, label_pattern)) {
      code_ << label(match[1]) << ":\n";
      return;
    }
    const auto equals = line.find(" = ");
    const auto name = equals == std::string::npos ? "" : line.substr(0, equals);
    const auto expr = equals == std::string::npos ? line : line.substr(equals + 3);

    if (std::regex_match(expr, match, special)) {
      emit("mov.u32", output(name, 'r'), "%" + match[1].str() + ".x");
    } else if (std::regex_match(expr, match, integer)) {
      const auto op = match[1].str();
      emit(op == "mul" ? "mul.lo.u32" : op == "shl" ? "shl.b32" : op + ".u32",
           output(name, 'r'), use(match[2], 'r'), use(match[3], 'r'));
    } else if (std::regex_match(expr, match, compare)) {
      const auto op = match[1].str();
      const auto suffix = op[0] == 's' ? ".s32" : ".u32";
      emit("setp." + (op.size() == 3 ? op.substr(1) : op) + suffix,
           output(name, 'p'), use(match[2], 'r'), use(match[3], 'r'));
    } else if (std::regex_match(expr, match, extend)) {
      emit(match[1] == "sext" ? "cvt.s64.s32" : "cvt.u64.u32",
           output(name, 'd'), use(match[2], 'r'));
    } else if (std::regex_match(expr, match, address)) {
      const auto offset = temporary('d');
      emit("mul.lo.s64", offset, use(match[3], 'd'), "4");
      emit("add.u64", output(name, 'd'), use(match[2], 'd'), offset);
    } else if (std::regex_match(expr, match, read)) {
      emit("ld.global.f32", output(name, 'f'), "[" + use(match[1], 'd') + "]");
    } else if (std::regex_match(expr, match, write)) {
      emit("st.global.f32", "[" + use(match[2], 'd') + "]", use(match[1], 'f'));
    } else if (std::regex_match(expr, match, fp)) {
      emit(match[1].str().substr(1) + ".rn.f32", output(name, 'f'),
           use(match[2], 'f'), use(match[3], 'f'));
    } else if (std::regex_match(expr, match, neg)) {
      emit("neg.f32", output(name, 'f'), use(match[1], 'f'));
    } else if (std::regex_match(expr, match, select)) {
      emit("selp.f32", output(name, 'f'), use(match[2], 'f'),
           use(match[3], 'f'), use(match[1], 'p'));
    } else if (std::regex_match(expr, match, conditional)) {
      emit("@" + use(match[1], 'p') + " bra", label(match[2]));
      emit("bra", label(match[3]));
    } else if (std::regex_match(expr, match, jump)) {
      emit("bra", label(match[1]));
    } else if (line == "ret void") {
      code_ << "  ret;\n";
    } else {
      throw std::runtime_error("This workbench cannot lower: " + line);
    }
  }

  std::string finish() const {
    return ".version 6.0\n.target sm_70\n.address_size 64\n"
           ".visible .entry runKernel(.param .u64 arg0, .param .u64 arg1, "
           ".param .u32 arg2) {\n" +
           declaration('p', ".pred") + declaration('r', ".b32") +
           declaration('d', ".b64") + declaration('f', ".f32") +
           code_.str() + "}\n";
  }

 private:
  std::ostringstream code_;
  std::unordered_map<std::string, std::pair<char, std::string>> registers_;
  std::unordered_map<std::string, std::string> labels_;
  std::unordered_map<char, unsigned> counts_;

  template <typename... Operands>
  void emit(const std::string &operation, const std::string &first,
            const Operands &... others) {
    code_ << "  " << operation << ' ' << first;
    ((code_ << ", " << others), ...);
    code_ << ";\n";
  }

  std::string temporary(char kind) {
    return "%" + std::string(1, kind) + std::to_string(counts_[kind]++);
  }

  std::string output(const std::string &name, char kind) {
    if (name.empty() || name.front() != '%' || registers_.count(name))
      throw std::runtime_error("Invalid result register: " + name);
    return registers_.emplace(name, std::make_pair(kind, temporary(kind)))
        .first->second.second;
  }

  std::string use(const std::string &operand, char kind) const {
    if (!operand.empty() && operand.front() == '%') {
      const auto found = registers_.find(operand);
      if (found == registers_.end() || found->second.first != kind)
        throw std::runtime_error("Unsupported operand: " + operand);
      return found->second.second;
    }
    if (kind == 'f') return float_literal(operand);
    static const std::regex decimal(R"(^-?[0-9]+$)");
    if ((kind == 'r' || kind == 'd') && std::regex_match(operand, decimal))
      return operand;
    throw std::runtime_error("Unsupported operand: " + operand);
  }

  std::string label(const std::string &name) {
    const auto result = labels_.try_emplace(name, "L" + std::to_string(labels_.size()));
    return result.first->second;
  }

  std::string declaration(char kind, const char *type) const {
    const auto count = counts_.find(kind);
    if (count == counts_.end()) return "";
    return "  .reg " + std::string(type) + " %" + kind + "<" +
           std::to_string(count->second) + ">;\n";
  }
};

} // namespace

std::string lower_ptx(const std::string &ir) {
  if (ir.size() > 128 * 1024)
    throw std::runtime_error("The compiled kernel exceeds the workbench size limit.");
  if (ir.find("target triple = \"nvptx64-nvidia-cuda\"") == std::string::npos)
    throw std::runtime_error("Expected 64-bit CUDA IR from Clang.");

  static const std::regex signature(
      R"(^define .*ptx_kernel void @runKernel\(ptr [^,]* (%[\w.$-]+), ptr [^,]* (%[\w.$-]+), i32 [^,]* (%[\w.$-]+)\).*\{$)");
  Ptx ptx;
  std::istringstream lines(ir);
  bool found = false;
  for (std::string line; std::getline(lines, line);) {
    const auto comment = line.find(';');
    if (comment != std::string::npos) line.erase(comment);
    const auto metadata = line.find(", !");
    if (metadata != std::string::npos) line.erase(metadata);
    const auto first = line.find_first_not_of(" \t\r");
    if (first == std::string::npos) continue;
    const auto last = line.find_last_not_of(" \t\r");
    line = line.substr(first, last - first + 1);
    if (!found) {
      std::smatch match;
      if (!std::regex_match(line, match, signature)) continue;
      ptx.parameter(match[1], 'd', 0);
      ptx.parameter(match[2], 'd', 1);
      ptx.parameter(match[3], 'r', 2);
      found = true;
      continue;
    }
    if (line == "}") return ptx.finish();
    ptx.instruction(line);
  }
  throw std::runtime_error("Expected extern \"C\" __global__ void runKernel(const float*, float*, int).");
}
