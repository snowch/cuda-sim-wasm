const traceReplay = (() => {
    const counterNames = new Map([
        ['gpu_tot_sim_cycle', 'cycles'],
        ['gpu_tot_sim_insn', 'instructions'],
        ['gpgpu_n_mem_read_global', 'reads'],
        ['gpgpu_n_mem_write_global', 'writes'],
    ]);

    function track() {
        const kernels = [];
        let completed = false;
        const timing = {};
        return {
            push(line) {
                if (line === 'GPGPU-Sim: *** exit detected ***') completed = true;
                const match = /^([\w]+) = (\d+)\s*$/.exec(line);
                if (match?.[1] === 'trace_sim_init_us') timing.simulatorInitMs = Number(match[2]) / 1000;
                if (match?.[1] === 'trace_sim_replay_us') timing.simulatorReplayMs = Number(match[2]) / 1000;
                const key = match && counterNames.get(match[1]);
                if (!key) return;
                if (key === 'cycles') kernels.push({});
                kernels.at(-1)[key] = Number(match[2]);
            },
            timing,
            result(expectedKernels) {
                if (!completed || kernels.length !== expectedKernels ||
                    kernels.some(kernel => Object.keys(kernel).length !== counterNames.size)) {
                    throw new Error(`Incomplete replay: found ${kernels.length}/${expectedKernels} kernel summaries`);
                }
                return kernels;
            },
        };
    }

    function args(root, test) {
        return [
            '-config', `${root}/${test.config}gpgpusim.config`,
            '-config', `${root}/${test.config}trace.config`,
            '-trace', `${root}/${test.trace}`,
        ];
    }

    async function run(createSimulator, test, options = {}) {
        const tracker = track();
        const start = performance.now();
        const simulator = await createSimulator({
            noInitialRun: true,
            print: line => tracker.push(line),
            ...options,
        });
        const ready = performance.now();
        const status = simulator.callMain(args('/fixture', test));
        if (status !== 0) throw new Error(`Simulator exited with status ${status}`);
        return {
            kernels: tracker.result(test.kernels),
            startupMs: Math.round(ready - start),
            ...tracker.timing,
            replayMs: Math.round(performance.now() - ready),
        };
    }

    return { args, run, track };
})();

if (typeof module !== 'undefined') module.exports = traceReplay;
