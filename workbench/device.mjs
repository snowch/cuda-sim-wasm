// Bridge host calls to an isolated worker-owned GPGPU-Sim module.
export function ptxDevice(module, ptx) {
  const allocations = new Map();
  const encoder = new TextEncoder();

  function temporary(bytes, callback) {
    const ptr = module._malloc(bytes.byteLength);
    if (!ptr) throw new Error('Simulator memory allocation failed.');
    try {
      if (ArrayBuffer.isView(bytes)) module.HEAPU8.set(bytes, ptr);
      return callback(ptr);
    } finally {
      module._free(ptr);
    }
  }

  function check(pointer, size) {
    if (!size) return;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid transfer size.');
    for (const [base, capacity] of allocations) {
      if (pointer >= base && pointer - base + size <= capacity) return;
    }
    throw new Error('The pointer range exceeds its device allocation.');
  }

  temporary(encoder.encode(ptx + '\0'), ptr => {
    if (module._load_module(ptr)) throw new Error('GPGPU-Sim rejected the PTX module.');
  });

  return {
    allocate(size) {
      const ptr = module._allocate_buffer(size) >>> 0;
      if (!ptr) throw new Error('Device allocation failed.');
      allocations.set(ptr, size);
      return ptr;
    },
    free(pointer) {
      if (pointer && !allocations.delete(pointer)) throw new Error('Invalid device allocation.');
    },
    toDevice(pointer, view) {
      check(pointer, view.byteLength);
      if (view.byteLength) temporary(view, ptr => module._upload_buffer(pointer, ptr, view.byteLength));
    },
    toHost(pointer, view) {
      check(pointer, view.byteLength);
      if (view.byteLength) temporary(view, ptr => {
        module._download_buffer(ptr, pointer, view.byteLength);
        view.set(module.HEAPU8.subarray(ptr, ptr + view.byteLength));
      });
    },
    launch(name, params, locations, grid, block) {
      if (params.length !== locations.length) throw new Error('Kernel argument count mismatch.');
      const values = new BigUint64Array(params.length);
      const sizes = new Uint32Array(params.length);
      const offsets = new Uint32Array(params.length);
      let offset = 0;
      for (let i = 0; i < params.length; ++i) {
        const data = locations[i];
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const kind = params[i];
        const isPointer = kind === 'P';
        const size = isPointer ? 8 : Number(kind);
        if ((isPointer ? 4 : size) !== data.byteLength) throw new Error('Kernel argument width mismatch.');
        if (isPointer) check(view.getUint32(0, true), 1);
        values[i] = isPointer ? BigInt(view.getUint32(0, true)) : size === 8 ? view.getBigUint64(0, true) :
          size === 4 ? BigInt(view.getUint32(0, true)) : size === 2 ? BigInt(view.getUint16(0, true)) : BigInt(view.getUint8(0));
        sizes[i] = size;
        offset = Math.ceil(offset / size) * size;
        offsets[i] = offset;
        offset += size;
      }
      const packet = new Uint8Array(Math.max(16, 16 * params.length));
      packet.set(new Uint8Array(values.buffer), 0);
      packet.set(new Uint8Array(sizes.buffer), values.byteLength);
      packet.set(new Uint8Array(offsets.buffer), values.byteLength + sizes.byteLength);
      temporary(encoder.encode(name + '\0'), label => temporary(packet, ptr => {
        const result = module._launch_kernel(label, ptr, ptr + values.byteLength,
          ptr + values.byteLength + sizes.byteLength, params.length, ...grid, ...block);
        if (result) throw new Error('GPGPU-Sim could not launch ' + name + '.');
      }));
    },
  };
}

export function kernelStub(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('Invalid kernel name.');
  const mangled = name.match(/^_Z(\d+)(.*)$/);
  if (!mangled) return '__device_stub__' + name;
  return '_Z' + (Number(mangled[1]) + '__device_stub__'.length) + '__device_stub__' + mangled[2];
}
