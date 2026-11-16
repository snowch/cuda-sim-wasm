const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const cases = require('./cases.json');
const replay = require('./replay.js');

const [native, fixture, wasm, resultsFile] = process.argv.slice(2).map(value => path.resolve(value));

async function main() {
    const createSimulator = require(wasm);
    const results = {};
    for (const test of cases) {
        const nativeOutput = execFileSync(native, replay.args(fixture, test), {
            cwd: path.join(fixture, test.config),
            encoding: 'utf8',
            timeout: 90_000,
            maxBuffer: 16 * 1024 * 1024,
        });
        const tracker = replay.track();
        nativeOutput.split('\n').forEach(line => tracker.push(line));
        const reference = tracker.result(test.kernels);

        const result = await replay.run(createSimulator, test, {
            locateFile: filename => path.join(path.dirname(wasm), filename),
        });

        assert.deepEqual(result.kernels, reference, test.name);
        results[test.name] = reference;
        console.log(test.name, reference.at(-1), result.startupMs, result.replayMs);
    }
    assert.ok(results.strided[0].reads > results.coalesced[0].reads);
    assert.ok(results['lud-complete'].at(-1).writes > 0);
    assert.ok(results['nw-complete'].at(-1).writes > 0);
    writeFileSync(resultsFile, JSON.stringify(results, null, 2) + '\n');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
