importScripts('./trace-replay.js', './replay.js');

self.onmessage = async ({ data: test }) => {
    try {
        postMessage(await traceReplay.run(createTraceSimulator, test));
    } catch (error) {
        postMessage({ error: String(error) });
    }
};
