const editor = document.querySelector('#source');
const run = document.querySelector('#run');
const stop = document.querySelector('#stop');
const reset = document.querySelector('#reset');
const status = document.querySelector('#status');
const diagnostics = document.querySelector('#diagnostics');
const values = document.querySelector('#values');
const ptxPanel = document.querySelector('#ptx-panel');
const ptx = document.querySelector('#ptx');
const mode = document.documentElement.dataset.inline || new URLSearchParams(location.search).get('embed');
const advanced = Boolean(lab.programs && Object.hasOwn(lab.programs, mode));
const profile = mode === 'hello' ? 'hello' : undefined;
const fullProgram = document.documentElement.dataset.program === 'true';
const consoleOutput = document.querySelector('#program-output');
const operations = document.querySelector('#program-operations');
if (fullProgram) {
  editor.value = advanced ? lab.programs[mode] : profile ? lab.firstProgram : mode === 'coalescing' ? lab.coalescingProgram : lab.arrayProgram;
  document.querySelector('#output-title + p').textContent = 'Output from main() in this browser.';
  values.closest('table').hidden = true;
  consoleOutput.hidden = false;
} else if (profile) {
  editor.value = lab.firstKernel;
  document.querySelector('#output-title + p').textContent = 'One block, one thread, one output value.';
  const table = values.closest('table');
  table.setAttribute('aria-label', 'Simulated output value');
  table.querySelector('thead th:nth-child(2)').remove();
}
const starter = editor.value;
const storageKey = 'gpu-lab-v2:editable-cuda-kernel' +
  (advanced || ['hello', 'scale', 'bounds', 'copies', 'coalescing'].includes(mode) ? mode : '') + (fullProgram ? ':program' : '');
let engine;
let workerUrl;
let prepared = false;
let timeout;

try { editor.value = localStorage.getItem(storageKey) ?? starter; } catch { /* Optional storage. */ }

function showValues(output) {
  values.replaceChildren(...(profile ? [null] : [1, 2, 3, 4, 5]).map((input, index) => {
    const row = document.createElement('tr');
    const value = output?.[index];
    const formatted = value === undefined ? '—' : value === null ? 'Unwritten'
      : Number.isInteger(value) ? value.toFixed(1) : String(value);
    const cells = profile ? [index, formatted] : [index, input.toFixed(1), formatted];
    for (const text of cells) {
      const cell = document.createElement(row.children.length ? 'td' : 'th');
      if (!row.children.length) cell.scope = 'row';
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  }));
}

function clearResult(message) {
  showValues();
  consoleOutput.textContent = '';
  operations.hidden = true;
  ptx.textContent = '';
  ptxPanel.hidden = true;
  diagnostics.textContent = '';
  diagnostics.hidden = true;
  status.dataset.error = 'false';
  status.textContent = message;
}

function busy(flag) {
  run.disabled = flag;
  reset.disabled = flag;
  editor.readOnly = flag;
  stop.hidden = !flag;
}

function shutDown() {
  engine?.terminate();
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = undefined;
  engine = undefined;
  prepared = false;
  clearTimeout(timeout);
}

function fail(message, details = '') {
  status.dataset.error = 'true';
  status.textContent = message;
  diagnostics.textContent = details;
  diagnostics.hidden = !details;
  busy(false);
}

const makeModule = text => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
function launchWorker() {
  workerUrl = makeModule(lab.worker);
  const created = new Worker(workerUrl);
  created.onmessage = ({ data }) => {
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    workerUrl = undefined;
    if (data.stage) {
      status.textContent = data.stage;
      if (data.ready) prepared = true;
      return;
    }
    clearTimeout(timeout);
    if (data.compileError) {
      fail('Clang could not compile this edit.', data.diagnostics);
      return;
    }
    if (data.error) {
      if (!prepared) shutDown();
      fail('The run did not complete.', data.error);
      return;
    }
    if (fullProgram) {
      consoleOutput.textContent = data.stdout || 'No console output.';
      operations.querySelector('pre').textContent = data.events.join('\n');
      operations.hidden = !data.events.length;
      status.textContent = data.exitCode ? 'main() returned ' + data.exitCode + '.' :
        data.ptx ? 'Ran main() and the kernel in GPGPU-Sim.' : 'Ran main(). No kernel was launched.';
    } else {
      showValues(data.output);
      status.textContent = 'Compiled and ran in GPGPU-Sim.';
    }
    ptx.textContent = data.ptx || '';
    ptxPanel.hidden = !data.ptx;
    diagnostics.textContent = data.diagnostics;
    diagnostics.hidden = !data.diagnostics;
    busy(false);
  };
  created.onerror = event => {
    shutDown();
    fail('The browser worker stopped.', event.message);
  };
  return created;
}

run.addEventListener('click', () => {
  clearResult(prepared ? 'Compiling your CUDA source…' : 'Loading the compiler…');
  busy(true);
  try {
    engine ??= launchWorker();
    timeout = setTimeout(() => {
      shutDown();
      fail('The run timed out.');
    }, 90_000);
    let assets;
    if (!prepared) {
      assets = { compiler: lab.assets.compiler };
      if (advanced) assets.advanced = lab.assets.advanced;
      else assets.simulator = lab.assets.simulator;
      if (advanced && assets.advanced?.files) {
        const base = document.querySelector('meta[name="gpu-base"]')?.content || '../';
        const release = document.querySelector('meta[name="gpu-release"]')?.content;
        const folder = base + (release ? 'releases/' + release + '/' : '') + 'assets/cuda-workbench/';
        assets.advanced = Object.fromEntries(Object.entries(assets.advanced.files).map(([name, asset]) => [
          name, { ...asset, parts: asset.parts.map(part => new URL(folder + part, location.href).href) },
        ]));
      }
    }
    engine.postMessage({ source: editor.value, profile, fullProgram, advanced, assets });
  } catch (error) {
    shutDown();
    fail('The compiler could not start.', String(error.message ?? error));
  }
});

// Release the compiled toolchain when this lesson's iframe goes away.
addEventListener('pagehide', shutDown);
stop.addEventListener('click', () => {
  shutDown();
  clearResult('Run stopped. Your source is ready to edit.');
  busy(false);
  run.focus();
});

function edited() {
  clearResult('Source changed. Compile and run to see the new result.');
  try { localStorage.setItem(storageKey, editor.value); } catch { /* Optional storage. */ }
}

editor.addEventListener('input', edited);
reset.addEventListener('click', () => {
  editor.value = starter;
  edited();
  editor.focus();
});
showValues();
