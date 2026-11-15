const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const [native, fixture, wasm] = process.argv.slice(2).map(value => path.resolve(value));
const metrics = ['gpu_sim_cycle', 'gpu_sim_insn', 'gpgpu_n_mem_read_global'];

function argumentsFor(root, traceList) {
    return [
        '-config', `${root}/gpgpusim.config`,
        '-config', `${root}/trace.config`,
        '-trace', `${root}/traces/${traceList}`,
    ];
}

function counters(output) {
    assert.match(output, /GPGPU-Sim: \*\*\* exit detected \*\*\*/);
    return Object.fromEntries(metrics.map(name => {
        const match = output.match(new RegExp(`^${name} = (\\d+)\\s*$`, 'm'));
        assert.ok(match, `Missing counter ${name}`);
        assert.ok(Number(match[1]) > 0, `Expected a positive value for ${name}`);
        return [name, Number(match[1])];
    }));
}

async function main() {
    const createSimulator = require(wasm);
    const results = {};
    for (const [label, traceList] of [['coalesced', 'kernelslist.g'], ['strided', 'strided.g']]) {
        const nativeOutput = execFileSync(native, argumentsFor(fixture, traceList), {
            cwd: fixture,
            encoding: 'utf8',
            timeout: 30_000,
        });

        const wasmOutput = [];
        await createSimulator({
            arguments: argumentsFor('/fixture', traceList),
            locateFile: filename => path.join(path.dirname(wasm), filename),
            print: line => wasmOutput.push(line),
            printErr: line => console.error(line),
        });

        results[label] = counters(nativeOutput);
        assert.deepEqual(counters(wasmOutput.join('\n')), results[label], label);
    }

    assert.ok(results.strided.gpgpu_n_mem_read_global > results.coalesced.gpgpu_n_mem_read_global);
    console.table(results);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
