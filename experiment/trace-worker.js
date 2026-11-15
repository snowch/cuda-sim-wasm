importScripts('./trace-replay.js');

self.onmessage = async ({ data: trace }) => {
    try {
        const lines = [];
        const start = performance.now();
        await createTraceSimulator({
            arguments: ['-config', '/fixture/gpgpusim.config',
                '-config', '/fixture/trace.config', '-trace', '/fixture/traces/' + trace],
            print: line => lines.push(line),
        });
        const timeMs = Math.round(performance.now() - start);
        const output = lines.join('\n');
        if (!output.includes('GPGPU-Sim: *** exit detected ***')) {
            throw new Error(output);
        }
        const counter = name => Number(output.match(new RegExp('^' + name + ' = (\\d+)', 'm'))[1]);
        postMessage({ cycles: counter('gpu_sim_cycle'), instructions: counter('gpu_sim_insn'),
            reads: counter('gpgpu_n_mem_read_global'), timeMs });
    } catch (error) {
        postMessage({ error: String(error) });
    }
};
