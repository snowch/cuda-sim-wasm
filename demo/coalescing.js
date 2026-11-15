const laneCount = 32;
const baseAddress = 0x10000000;
const sectorSize = 32;
const colors = ['#8aefd8', '#a4c6ff', '#f4ce91', '#d6b7fc'];
const layouts = new Map([
    [4, { test: demo.cases.coalesced, runs: [] }],
    [128, { test: demo.cases.strided, runs: [] }],
]);

const strideControl = document.querySelector('#stride');
const laneList = document.querySelector('#lanes');
const sectorList = document.querySelector('#sectors');
const selection = document.querySelector('#selection');
const touched = document.querySelector('#touched');
const run = document.querySelector('#run');
const status = document.querySelector('#status');
const reads = document.querySelector('#reads');
const cycles = document.querySelector('#cycles');
const timing = document.querySelector('#timing');
const timings = document.querySelector('#timings');
const engineTime = document.querySelector('#engine-time');
const comparison = document.querySelector('#comparison');
const numbers = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });

let stride = 4;
let activeLane = 0;
let worker;
let firstRun = true;

const address = lane => baseAddress + lane * stride;
const sector = lane => Math.floor((address(lane) - baseAddress) / sectorSize);
const hex = number => '0x' + number.toString(16).toUpperCase();
const ms = value => numbers.format(value) + ' ms';

function selectLane(lane, focus = false) {
    activeLane = lane;
    const sectorNumber = sector(lane);
    const start = baseAddress + sectorNumber * sectorSize;
    const shared = Array.from(laneList.children).filter(
        button => Number(button.dataset.sector) === sectorNumber
    ).length;
    selection.textContent = `Lane ${lane} loads ${hex(address(lane))}–${hex(address(lane) + 3)}. Sector ${sectorNumber} spans ${hex(start)}–${hex(start + sectorSize - 1)} and serves ${shared} ${shared === 1 ? 'lane' : 'lanes'}.`;
    for (const button of laneList.children) {
        const matches = Number(button.dataset.lane) === lane;
        button.dataset.related = Number(button.dataset.sector) === sectorNumber;
        button.tabIndex = matches ? 0 : -1;
        button.setAttribute('aria-pressed', matches);
        if (focus && matches) button.focus();
    }
    for (const button of sectorList.children) {
        const matches = Number(button.dataset.sector) === sectorNumber;
        button.setAttribute('aria-pressed', matches);
    }
}

function drawDiagram() {
    const sectors = new Map();
    const lanes = document.createDocumentFragment();
    for (let lane = 0; lane < laneCount; lane++) {
        const sectorNumber = sector(lane);
        if (!sectors.has(sectorNumber)) sectors.set(sectorNumber, lane);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'lane';
        button.dataset.lane = lane;
        button.dataset.sector = sectorNumber;
        button.setAttribute('aria-label', `Lane ${lane}, address ${hex(address(lane))}, sector ${sectorNumber}`);
        if (stride === 4) button.style.setProperty('--group', colors[sectorNumber]);
        const label = document.createElement('small');
        label.textContent = `Lane ${lane}`;
        const value = document.createElement('span');
        value.textContent = hex(address(lane)).slice(2);
        button.append(label, value);
        lanes.append(button);
    }
    laneList.replaceChildren(lanes);

    const badges = document.createDocumentFragment();
    for (const [sectorNumber, firstLane] of sectors) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sector';
        button.dataset.sector = sectorNumber;
        button.dataset.lane = firstLane;
        button.textContent = `S${sectorNumber}`;
        button.setAttribute('aria-label', `Sector ${sectorNumber}`);
        if (stride === 4) button.style.setProperty('--group', colors[sectorNumber]);
        badges.append(button);
    }
    sectorList.replaceChildren(badges);
    touched.textContent = `${sectors.size} touched`;
    selectLane(activeLane);
}

function showResults() {
    const history = layouts.get(stride).runs;
    const last = history.at(-1);
    reads.textContent = last ? numbers.format(last.counters.reads) : '—';
    cycles.textContent = last ? numbers.format(last.counters.cycles) : '—';
    timing.hidden = !last;
    status.textContent = last ? 'Matched the native reference.' : 'Run the selected stride to see its counters.';
    status.dataset.error = 'false';
    const contiguous = layouts.get(4).runs.at(-1)?.counters;
    const strided = layouts.get(128).runs.at(-1)?.counters;
    comparison.hidden = !(contiguous && strided);
    if (contiguous && strided) {
        comparison.textContent = `Global reads by stride · 4 B: ${contiguous.reads} · 128 B: ${strided.reads}`;
    }
    timings.replaceChildren(...history.slice(-4).map(result => {
        const row = document.createElement('tr');
        for (const value of [result.number, ms(result.startupMs), ms(result.simulatorInitMs), ms(result.simulatorReplayMs)]) {
            const cell = document.createElement('td');
            cell.textContent = value;
            row.append(cell);
        }
        return row;
    }));
}

function createWorker() {
    const script = new Blob(demo.workerScripts.map(part => atob(part)), { type: 'text/javascript' });
    const url = URL.createObjectURL(script);
    try {
        return new Worker(url);
    } finally {
        URL.revokeObjectURL(url);
    }
}

function simulate(test) {
    worker ??= createWorker();
    const assets = firstRun ? demo.assets : undefined;
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('The simulation timed out.')), 60_000);
        worker.onmessage = ({ data }) => {
            clearTimeout(timeout);
            if (data.error) reject(new Error(data.error));
            else resolve(data);
        };
        worker.onerror = event => {
            clearTimeout(timeout);
            reject(new Error(event.message || 'The simulator could not start.'));
        };
        worker.postMessage({ test, assets });
    });
}

strideControl.addEventListener('change', event => {
    stride = Number(event.target.value);
    drawDiagram();
    showResults();
});

for (const group of [laneList, sectorList]) {
    group.addEventListener('click', event => {
        const button = event.target.closest('button[data-lane]');
        if (button) selectLane(Number(button.dataset.lane));
    });
}

laneList.addEventListener('keydown', event => {
    const columns = getComputedStyle(laneList).gridTemplateColumns.split(' ').length;
    const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
    if (!move) return;
    event.preventDefault();
    selectLane(Math.max(0, Math.min(laneCount - 1, activeLane + move)), true);
});

run.addEventListener('click', async () => {
    run.disabled = true;
    strideControl.disabled = true;
    status.dataset.error = 'false';
    status.textContent = firstRun ? 'Loading the simulator and running the trace…' : 'Running the trace…';
    const { test, runs } = layouts.get(stride);
    try {
        const result = await simulate(test);
        firstRun = false;
        const expected = demo.expected[test.name][0];
        const counters = result.kernels[0];
        if (!Object.keys(expected).every(key => counters[key] === expected[key])) {
            throw new Error('The simulator counters differ from the native reference.');
        }
        runs.push({ ...result, counters, number: runs.length + 1 });
        if (result.engineMs !== undefined) {
            engineTime.textContent = `One-time asset unpacking and compilation: ${ms(result.engineMs)}.`;
        }
        showResults();
    } catch (error) {
        worker?.terminate();
        worker = undefined;
        firstRun = true;
        status.dataset.error = 'true';
        status.textContent = error.message;
    } finally {
        run.disabled = false;
        strideControl.disabled = false;
    }
});

drawDiagram();
