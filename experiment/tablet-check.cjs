// Package the single-kernel browser check as an offline HTML file.
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const test = require('./cases.json').find(test => test.name === 'lud-first');

const [work, output] = process.argv.slice(2);
const expected = JSON.parse(readFileSync(path.join(work, 'results.json'), 'utf8'))[test.name];
const read = (filename, encoding) => readFileSync(filename, encoding);
const asset = name => read(path.join(work, 'wasm', 'trace-replay.' + name));
const compressed = data => gzipSync(data).toString('base64');
const escapeHtml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const worker = [
    asset('js'),
    read(path.join(__dirname, 'replay.js')),
    `\nself.onmessage = async ({ data: { test, wasm, fixture } }) => {
        try {
            const start = performance.now();
            const unpack = async input => {
                const bytes = Uint8Array.from(atob(input), char => char.charCodeAt(0));
                return new Response(new Blob([bytes]).stream()
                    .pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
            };
            const [wasmBinary, packageData] = await Promise.all([unpack(wasm), unpack(fixture)]);
            const unpackMs = Math.round(performance.now() - start);
            const result = await traceReplay.run(createTraceSimulator, test, {
                wasmBinary,
                getPreloadedPackage: () => packageData,
            });
            postMessage({ ...result, unpackMs });
        } catch (error) {
            postMessage({ error: String(error) });
        }
    };\n`,
];
const licenses = ['accel/LICENSE', 'gpgpu/COPYRIGHT', 'zstd/LICENSE']
    .map(name => read(path.join(work, name), 'utf8'));
const emscripten = process.env.EMSDK;
if (emscripten) {
    const root = path.join(emscripten, 'upstream', 'emscripten');
    licenses.push(read(path.join(root, 'LICENSE'), 'utf8'));
    licenses.push(read(path.join(root, 'cache/ports/zlib/zlib-1.3.1/LICENSE'), 'utf8'));
}
const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CUDA simulator tablet test</title>
<style>
body{font:1rem/1.5 system-ui,sans-serif;background:#edf2f5;color:#142631;margin:0;padding:1.5rem}
main{max-width:38rem;margin:2rem auto;background:white;border:1px solid #cad4dc;border-radius:1rem;padding:clamp(1.1rem,4vw,2.2rem)}
h1{font-size:clamp(1.65rem,6vw,2.25rem);line-height:1.2;margin:0}
button{font:600 1rem system-ui;background:#144e67;color:white;border:0;border-radius:.5rem;padding:.75rem 1rem;cursor:pointer}
button:disabled{opacity:.65;cursor:wait}
#status{font-weight:650;margin-bottom:.25rem}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf2f5;padding:.8rem;border-radius:.45rem}
details{margin-top:1.4rem}
</style>
<main>
<h1>CUDA simulator tablet test</h1>
<p>Replay one kernel recorded on a Tesla V100 and compare the result with the verified native run. This check runs offline.</p>
<button id="run" type="button">Run test</button>
<p id="status" role="status"></p>
<pre id="output" hidden></pre>
<details><summary>Trace source and software licenses</summary>
<p><a href="https://engineering.purdue.edu/tgrogers/accel-sim/traces/tesla-v100/latest/">Accel-Sim pre-collected Rodinia traces</a>, LU decomposition on the 64 × 64 input.</p>
<pre>${escapeHtml(licenses.join('\n\n'))}</pre></details>
</main>
<script>
const payload = {
    test: ${JSON.stringify(test)},
    wasm: "${compressed(asset('wasm'))}",
    fixture: "${compressed(asset('data'))}"
};
const expected = ${JSON.stringify(expected)};
const workerScripts = ${JSON.stringify(worker.map(part => Buffer.from(part).toString('base64')))};
const button = document.querySelector('#run');
const status = document.querySelector('#status');
const output = document.querySelector('#output');
button.addEventListener('click', async () => {
    button.disabled = true;
    output.hidden = true;
    status.textContent = 'Running…';
    let worker;
    let url;
    let timeout;
    try {
        url = URL.createObjectURL(new Blob(workerScripts.map(part => atob(part)), { type: 'text/javascript' }));
        worker = new Worker(url);
        const result = await new Promise((resolve, reject) => {
            worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
            worker.onerror = event => reject(new Error(event.message || 'Worker failed'));
            timeout = setTimeout(() => reject(new Error('The run timed out')), 90000);
            worker.postMessage(payload);
        });
        const pass = JSON.stringify(expected) === JSON.stringify(result.kernels);
        const { cycles, instructions, reads, writes } = result.kernels[0];
        status.textContent = pass ? 'Pass · counters match' : 'Fail · counters differ';
        output.textContent = [
            'Simulated cycles: ' + cycles,
            'Simulated instructions: ' + instructions,
            'Global-memory requests: ' + reads + ' reads, ' + writes + ' writes',
            '',
            'Asset unpacking: ' + result.unpackMs + ' ms',
            'WebAssembly startup: ' + result.startupMs + ' ms',
            'Simulator init and replay: ' + result.replayMs + ' ms'
        ].join('\\n');
        output.hidden = false;
    } catch (error) {
        status.textContent = 'Test failed';
        output.textContent = error.message;
        output.hidden = false;
    } finally {
        if (worker) worker.terminate();
        if (url) URL.revokeObjectURL(url);
        clearTimeout(timeout);
        button.disabled = false;
    }
});
</script>
</html>
`;
writeFileSync(output, html);
