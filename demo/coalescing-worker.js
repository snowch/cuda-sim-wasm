// The compiled code stays in the worker. Each replay gets a fresh instance,
// including its own memory and the simulator's C++ globals.
let compiled;
let fixture;

async function unpack(input) {
    const bytes = Uint8Array.from(atob(input), char => char.charCodeAt(0));
    return new Response(new Blob([bytes]).stream()
        .pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

self.onmessage = async ({ data: { test, assets } }) => {
    try {
        let engineMs;
        if (assets) {
            const start = performance.now();
            [compiled, fixture] = await Promise.all([
                unpack(assets.wasm).then(bytes => WebAssembly.compile(bytes)),
                unpack(assets.fixture),
            ]);
            engineMs = performance.now() - start;
        }
        const result = await traceReplay.run(createTraceSimulator, test, {
            getPreloadedPackage: () => fixture.slice(0),
            instantiateWasm(imports, receiveInstance) {
                const instance = new WebAssembly.Instance(compiled, imports);
                receiveInstance(instance, compiled);
                return instance.exports;
            },
        });
        if (!Number.isFinite(result.simulatorInitMs) || !Number.isFinite(result.simulatorReplayMs)) {
            throw new Error('The simulator did not report its phase timings.');
        }
        postMessage({ ...result, engineMs });
    } catch (error) {
        postMessage({ error: String(error) });
    }
};
