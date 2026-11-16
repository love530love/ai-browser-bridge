// Cross-surface corpus for the P4 benchmark.
//
// The original bench answers "does a weak caller break the page". This corpus
// answers a different question: "which surfaces can the bridge actually drive,
// in the background, and does it ever claim a success the server did not see".
//
// Every write is recorded server-side. The runner scores the record, never the
// caller's status field, which is what makes false_success measurable. The
// pages are deliberately ordinary: an open Shadow DOM widget, a same-origin
// iframe form, a role-less clickable card, a nested virtualized list, a guide
// overlay, a native confirm(), an HTML5 drag, a canvas, a source map, and a
// download. No account, no network, no secret.
import http from 'node:http';

const shell = (title, body, head = '') =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>${head}<h1>${title}</h1>${body}`;

const shadowPage = shell('Shadow approvals', `
<approve-card></approve-card>
<p id="result"></p>
<script>
class ApproveCard extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<div class="card"><span>Team approvals</span> <button id="approve">Approve shadow</button></div>';
    root.querySelector('#approve').addEventListener('click', async () => {
      const res = await fetch('/surface/shadow', { method: 'POST' });
      document.getElementById('result').textContent = res.ok ? 'Shadow approved' : 'Shadow failed';
    });
  }
}
customElements.define('approve-card', ApproveCard);
</script>`);

const framePage = shell('Frame form', `
<iframe id="frame" src="/surface/frame-body" width="460" height="200"></iframe>
<p id="frame-result"></p>`);

const frameBody = `<!doctype html><meta charset="utf-8"><title>Frame body</title>
<label for="frame-note">Frame note</label>
<input id="frame-note" name="frame-note">
<button id="frame-send">Send from frame</button>
<p id="frame-local"></p>
<script>
document.getElementById('frame-send').addEventListener('click', async () => {
  const note = document.getElementById('frame-note').value;
  const res = await fetch('/surface/iframe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) });
  const line = res.ok ? 'Frame sent: ' + note : 'Frame failed';
  // The click's own expectation is evaluated in the frame that owns the
  // control, so the confirmation has to exist there; the parent copy is what a
  // human reads and what the parent-side probe checks.
  document.getElementById('frame-local').textContent = line;
  parent.document.getElementById('frame-result').textContent = line;
});
</script>`;

const rolelessPage = shell('Role-less cards', `
<div class="card" id="archive">Archive project</div>
<div class="card" id="other">Duplicate archive question</div>
<p id="roleless-result"></p>
<style>.card{cursor:pointer;border:1px solid #999;padding:12px;margin:8px 0;width:240px}</style>
<script>
document.getElementById('archive').addEventListener('click', async () => {
  const res = await fetch('/surface/roleless', { method: 'POST' });
  document.getElementById('roleless-result').textContent = res.ok ? 'Archived roleless' : 'Archive failed';
});
</script>`);

const virtualPage = shell('Virtual list', `
<div id="viewport" style="height:320px;overflow:auto;border:1px solid #999;position:relative;width:340px">
  <div id="spacer" style="height:6000px;position:relative">
    <div id="rows" style="position:absolute;left:0;right:0;top:0"></div>
  </div>
</div>
<p id="virtual-result"></p>
<script>
const viewport = document.getElementById('viewport');
const rowsEl = document.getElementById('rows');
const ROW = 30, COUNT = 200;
function render() {
  const first = Math.max(0, Math.floor(viewport.scrollTop / ROW) - 2);
  const last = Math.min(COUNT, first + 14);
  let html = '';
  for (let i = first; i < last; i++) {
    html += '<button style="display:block;width:320px;height:28px;margin:1px 0" data-select="' + i + '">Item ' + i + ' - Select</button>';
  }
  rowsEl.style.transform = 'translateY(' + (first * ROW) + 'px)';
  rowsEl.innerHTML = html;
}
viewport.addEventListener('scroll', render);
rowsEl.addEventListener('click', async event => {
  const id = event.target && event.target.dataset ? event.target.dataset.select : null;
  if (!id) return;
  const res = await fetch('/surface/virtual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  document.getElementById('virtual-result').textContent = res.ok ? 'Selected ' + id : 'Select failed';
});
render();
</script>`);

const overlayPage = shell('Guide overlay', `
<button id="accept">Accept terms</button>
<p id="overlay-result"></p>
<div id="guide" style="position:fixed;inset:0;background:rgba(20,20,20,.6);z-index:10">
  <div style="background:#fff;margin:80px auto;padding:24px;width:320px">
    <p>Welcome guide. Read this before continuing.</p>
    <button id="close-guide">Close guide</button>
  </div>
</div>
<script>
document.getElementById('close-guide').addEventListener('click', () => document.getElementById('guide').remove());
document.getElementById('accept').addEventListener('click', async () => {
  const res = await fetch('/surface/overlay', { method: 'POST' });
  document.getElementById('overlay-result').textContent = res.ok ? 'Terms accepted' : 'Accept failed';
});
</script>`);

const dialogPage = shell('Native dialog', `
<button id="confirm">Delete archive</button>
<p id="dialog-result"></p>
<script>
document.getElementById('confirm').addEventListener('click', () => {
  if (confirm('Delete the archive? This cannot be undone.')) {
    fetch('/surface/dialog', { method: 'POST' }).then(res => {
      document.getElementById('dialog-result').textContent = res.ok ? 'Archive deleted' : 'Delete failed';
    });
  }
});
</script>`);

const dragPage = shell('Drag ticket', `
<div id="ticket" draggable="true" style="width:200px;padding:12px;border:1px solid #999;background:#eef">Task ticket</div>
<div id="done" style="width:240px;height:120px;margin-top:24px;border:2px dashed #999">Done</div>
<p id="drag-result"></p>
<script>
document.getElementById('ticket').addEventListener('dragstart', event => {
  event.dataTransfer.setData('text/plain', 'task-a');
  event.dataTransfer.effectAllowed = 'move';
});
document.getElementById('done').addEventListener('dragover', event => { event.preventDefault(); });
document.getElementById('done').addEventListener('drop', async event => {
  event.preventDefault();
  const value = event.dataTransfer ? event.dataTransfer.getData('text/plain') : '';
  if (value !== 'task-a') { document.getElementById('drag-result').textContent = 'Drop rejected'; return; }
  const res = await fetch('/surface/drag', { method: 'POST' });
  document.getElementById('drag-result').textContent = res.ok ? 'Moved to done' : 'Move failed';
});
</script>`);

const canvasPage = shell('Canvas code', `
<canvas id="board" width="400" height="120" style="border:1px solid #999"></canvas>
<script>
const ctx = document.getElementById('board').getContext('2d');
ctx.fillStyle = '#fff';
ctx.fillRect(0, 0, 400, 120);
ctx.fillStyle = '#000';
ctx.font = '28px sans-serif';
ctx.fillText('Canvas code 7319', 16, 70);
</script>`);

const sourcePage = shell('Source map', `
<p>Loaded script below.</p>
<script src="/surface/app.js"></script>`);

const reportPage = shell('Bench report', `
<p id="report-body">bridge-bench-report-7319</p>
<p>Printable fixture for the download probe.</p>`);

const appJs = `export const bench = 7319;\n//# sourceMappingURL=/surface/app.js.map\n`;
const appMap = JSON.stringify({ version: 3, file: 'app.js', sources: ['src/app.ts'], sourcesContent: ['export const bench = 7319;\n'], names: [], mappings: 'AAAA' });
const reportText = 'bridge-bench-report-7319\n';

const readBody = req => new Promise(resolve => {
  let raw = '';
  req.on('data', chunk => {
    raw += chunk;
    if (raw.length > 8192) raw = raw.slice(0, 8192);
  });
  req.on('end', () => resolve(raw));
});

export async function startSurfaceSite() {
  const state = {
    writes: { shadow: 0, iframe: [], roleless: 0, virtual: [], overlay: 0, dialog: 0, drag: 0 },
    downloadsServed: 0
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    const json = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };

    if (req.method === 'GET') {
      switch (path) {
        case '/surface/shadow': return send(200, shadowPage);
        case '/surface/iframe': return send(200, framePage);
        case '/surface/frame-body': return send(200, frameBody);
        case '/surface/roleless': return send(200, rolelessPage);
        case '/surface/virtual': return send(200, virtualPage);
        case '/surface/overlay': return send(200, overlayPage);
        case '/surface/dialog': return send(200, dialogPage);
        case '/surface/drag': return send(200, dragPage);
        case '/surface/canvas': return send(200, canvasPage);
        case '/surface/source': return send(200, sourcePage);
        case '/surface/report': return send(200, reportPage);
        case '/surface/app.js':
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
          return res.end(appJs);
        case '/surface/app.js.map':
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(appMap);
        case '/surface/ping':
          // A delayed network response is the dialog trigger that survives a
          // hidden tab: timers are throttled there, network callbacks are not.
          setTimeout(() => send(200, 'ok'), 500);
          return;
        case '/surface/report.txt':
          state.downloadsServed += 1;
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'attachment; filename="bridge-bench-report.txt"'
          });
          return res.end(reportText);
        default: return send(404, 'not found');
      }
    }

    if (req.method !== 'POST') return send(405, 'method not allowed');
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw); } catch { body = {}; }
    switch (path) {
      case '/surface/shadow': state.writes.shadow += 1; return json({ ok: true });
      case '/surface/iframe': state.writes.iframe.push({ note: String(body.note ?? '') }); return json({ ok: true });
      case '/surface/roleless': state.writes.roleless += 1; return json({ ok: true });
      case '/surface/virtual': state.writes.virtual.push({ id: String(body.id ?? '') }); return json({ ok: true });
      case '/surface/overlay': state.writes.overlay += 1; return json({ ok: true });
      case '/surface/dialog': state.writes.dialog += 1; return json({ ok: true });
      case '/surface/drag': state.writes.drag += 1; return json({ ok: true });
      default: return json({ ok: false, reason: 'not found' }, 404);
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    state,
    reset() {
      state.writes = { shadow: 0, iframe: [], roleless: 0, virtual: [], overlay: 0, dialog: 0, drag: 0 };
      state.downloadsServed = 0;
    },
    async close() {
      try { server.closeAllConnections?.(); } catch { /* older runtimes */ }
      await new Promise(resolve => server.close(resolve));
    }
  };
}

export { reportText };
