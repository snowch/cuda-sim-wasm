const editor = document.querySelector('#source');
const run = document.querySelector('#run');
const stop = document.querySelector('#stop');
const reset = document.querySelector('#reset');
const status = document.querySelector('#status');
const diagnostics = document.querySelector('#diagnostics');
const values = document.querySelector('#values');
const ptxPanel = document.querySelector('#ptx-panel');
const ptx = document.querySelector('#ptx');
const starter = editor.value;
const storageKey = 'gpu-lab-v2:editable-cuda-kernel';
let engine;
let workerUrl;
let prepared = false;
let timeout;

try { editor.value = localStorage.getItem(storageKey) ?? starter; } catch { /* Optional storage. */ }

function showValues(output) {
  values.replaceChildren(...[1, 2, 3, 4, 5].map((input, index) => {
    const row = document.createElement('tr');
    const value = output?.[index];
    const formatted = value === undefined ? '—' : value === null ? 'Unwritten'
      : Number.isInteger(value) ? value.toFixed(1) : String(value);
    for (const text of [index, input.toFixed(1), formatted]) {
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
    showValues(data.output);
    ptx.textContent = data.ptx;
    ptxPanel.hidden = false;
    status.textContent = 'Compiled and ran in GPGPU-Sim.';
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
    engine.postMessage({ source: editor.value, assets: prepared ? undefined : lab.assets });
  } catch (error) {
    shutDown();
    fail('The compiler could not start.', String(error.message ?? error));
  }
});

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
