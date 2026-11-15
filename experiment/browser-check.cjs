const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const cases = require('./cases.json');

const [build, resultsFile] = process.argv.slice(2).map(value => path.resolve(value));
const files = {
    '/replay.js': [path.join(__dirname, 'replay.js'), 'text/javascript'],
    '/trace-worker.js': [path.join(__dirname, 'trace-worker.js'), 'text/javascript'],
    '/trace-replay.js': [path.join(build, 'trace-replay.js'), 'text/javascript'],
    '/trace-replay.wasm': [path.join(build, 'trace-replay.wasm'), 'application/wasm'],
    '/trace-replay.data': [path.join(build, 'trace-replay.data'), 'application/octet-stream'],
};

async function serve(request, response) {
    if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><title>CUDA simulator browser check</title>');
        return;
    }
    const file = files[request.url];
    if (!file) {
        response.writeHead(404).end();
        return;
    }
    const [filename, type] = file;
    try {
        const data = await readFile(filename);
        response.setHeader('Content-Type', type);
        response.end(data);
    } catch (error) {
        console.error(error);
        response.writeHead(500).end();
    }
}

async function main() {
    const server = createServer(serve);
    let browser;
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        browser = await chromium.launch({
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const results = await page.evaluate(async cases => {
            const results = {};
            for (const test of cases) {
                const worker = new Worker('/trace-worker.js');
                try {
                    results[test.name] = await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error('Worker timed out')), 90_000);
                        worker.onerror = ({ message }) => {
                            clearTimeout(timeout);
                            reject(new Error(message));
                        };
                        worker.onmessage = ({ data }) => {
                            clearTimeout(timeout);
                            if (data.error) reject(new Error(data.error));
                            else resolve(data);
                        };
                        worker.postMessage(test);
                    });
                } finally {
                    worker.terminate();
                }
            }
            return results;
        }, cases);
        const reference = JSON.parse(await readFile(resultsFile, 'utf8'));
        for (const { name } of cases) {
            assert.deepEqual(results[name].kernels, reference[name], name);
        }
        console.log(`Chromium ${browser.version()}`);
        console.table(Object.fromEntries(Object.entries(results).map(
            ([name, { kernels, startupMs, replayMs }]) =>
                [name, { ...kernels.at(-1), startupMs, replayMs }]
        )));
    } finally {
        if (browser) await browser.close();
        server.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
