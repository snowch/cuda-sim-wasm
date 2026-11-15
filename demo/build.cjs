// Generate the self-contained offline demo from the tested simulator build.
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const allCases = require('../experiment/cases.json');

const [work, output] = process.argv.slice(2);
const expected = JSON.parse(readFileSync(path.join(work, 'results.json'), 'utf8'));
const cases = ['coalesced', 'strided'];
const asset = extension => readFileSync(path.join(work, 'wasm', 'coalescing-replay.' + extension));
const source = name => readFileSync(path.join(__dirname, name), 'utf8');
const compressed = data => gzipSync(data).toString('base64');
const root = path.join(process.env.EMSDK, 'upstream', 'emscripten');
const licenses = [
    ...['accel/LICENSE', 'gpgpu/COPYRIGHT', 'zstd/LICENSE'].map(name => path.join(work, name)),
    path.join(root, 'LICENSE'),
    path.join(root, 'cache/ports/zlib/zlib-1.3.1/LICENSE'),
].map(name => readFileSync(name, 'utf8')).join('\n\n').replace(/[ \t]+$/gm, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;');

const demo = {
    cases: Object.fromEntries(cases.map(name => [name, allCases.find(test => test.name === name)])),
    expected: Object.fromEntries(cases.map(name => [name, expected[name]])),
    assets: { wasm: compressed(asset('wasm')), fixture: compressed(asset('data')) },
    workerScripts: [
        asset('js'),
        readFileSync(path.join(__dirname, '../experiment/replay.js')),
        Buffer.from(source('coalescing-worker.js')),
    ].map(part => part.toString('base64')),
};

const script = 'const demo = ' + JSON.stringify(demo) + ';\n' + source('coalescing.js');
const html = source('coalescing.html')
    .replace('__LICENSES__', () => licenses)
    .replace('/* __DEMO_SCRIPT__ */', () => script.replace(/<\/script/gi, '<\\/script'));
writeFileSync(output, html);
