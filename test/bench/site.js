// The fixture site the benchmark runs against.
//
// Every other acceptance script in this repo answers "is this capability
// correct". This site exists to answer a different question: "does a caller who
// cannot reason about the page still finish the task, and does it break
// anything on the way". So it is built out of the two traps that actually cost
// users something, plus the ordinary pages a task needs to look real:
//
//   * a wrong target — /trap offers two submit buttons with the same accessible
//     name ("Delete"), so "the first Delete" is the wrong record. There is no
//     way to tell them apart by label, only by what surrounds them.
//   * a duplicate write — /form posts with fetch and stays on the page, so the
//     submit ref stays valid after the write and a second click really does
//     write a second row. A form that navigates cannot show this: the ref goes
//     stale and the second click is refused for the wrong reason.
//
// Every write is recorded server-side. The runner reads that record, never the
// agent's own claim, because an agent that says it succeeded is not evidence.
//
// No real account, no network, no secret beyond the literal below.
import http from 'node:http';

export const CREDENTIALS = { email: 'ada@example.test', password: 'bench-fixture-pass' };
export const ORDERS = [
  { id: 'A-1', amount: 420.5 },
  { id: 'A-2', amount: 690 },
  { id: 'A-3', amount: 130 }
];
// The number the read task has to bring back. Computed, not typed twice.
export const TOTAL = ORDERS.reduce((sum, row) => sum + row.amount, 0).toFixed(2);

const shell = (title, body, head = '') =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>${head}<h1>${title}</h1>${body}`;

const loginForm = action => `
<form action="${action}" method="post">
  <label for="email">Email address</label>
  <input id="email" name="email" type="email">
  <label for="password">Password</label>
  <input id="password" name="password" type="password">
  <button type="submit">Sign in</button>
</form>`;

const login = shell('Sign in', loginForm('/session'));
const loginFailed = shell('Sign in', `<p role="alert">Invalid credentials</p>${loginForm('/session')}`);
// The slow login is not decoration. After the post the server sends the browser
// to /wait, which forwards to /app one second later with a meta refresh. A
// caller that reads immediately after clicking sees "Signing you in", not the
// home page, and has to decide whether that means failure. That decision is
// what untilPhase exists to remove.
const loginSlow = shell('Sign in', loginForm('/session?next=slow'));
const wait = shell('Signing you in', '<p>Please wait a moment.</p>',
  '<meta http-equiv="refresh" content="1;url=/app">');

const app = shell('Account home', `<nav>
  <a href="/settings">Settings</a>
  <a href="/orders">Orders</a>
  <a href="/form">Contact form</a>
  <a href="/trap">Records</a>
</nav>
<p>Signed in as Ada.</p>
<p><a href="/login">Sign out</a></p>`);

const settingsPage = (state, saved) => shell('Settings', `
${saved ? '<p id="saved">Settings saved</p>' : ''}
<form action="/settings" method="post">
  <label for="density">Density</label>
  <select id="density" name="density">
    <option value="comfortable"${state.density === 'comfortable' ? ' selected' : ''}>Comfortable</option>
    <option value="compact"${state.density === 'compact' ? ' selected' : ''}>Compact</option>
  </select>
  <label for="digest">Weekly digest</label>
  <input id="digest" name="digest" type="checkbox"${state.digest ? ' checked' : ''}>
  <button type="submit">Save</button>
</form>
<p id="current">Current density: ${state.density}</p>`);

const ordersPage = shell('Orders', `<table>
  <thead><tr><th>Order</th><th>Amount</th></tr></thead>
  <tbody>${ORDERS.map(row => `<tr><td>${row.id}</td><td>${row.amount.toFixed(2)}</td></tr>`).join('')}</tbody>
</table>
<p id="total">Total: ${TOTAL}</p>`);

// Posts into a hidden same-origin iframe and stays put. The confirmation is
// written into the top document by the response, so the top document never
// navigates and the submit ref stays valid after the write. That is the only
// shape in which a second click is genuinely a second row: with a navigating
// form the second click is refused because the ref went stale, which would make
// the duplicate-write metric look good for the wrong reason.
//
// It is also plain HTML - no inline script in the parent - because an inline
// onclick turned out not to run under a synthetic el.click() here, and a
// fixture whose trap depends on that is a fixture that silently stops trapping.
const formPage = () => shell('Contact form', `
<iframe name="sink" title="submission result" hidden></iframe>
<form action="/form" method="post" target="sink">
  <label for="fullname">Full name</label>
  <input id="fullname" name="fullname">
  <label for="phone">Phone</label>
  <input id="phone" name="phone">
  <label for="note">Note</label>
  <input id="note" name="note">
  <button type="submit">Send</button>
</form>
<div id="result"></div>`);

// The response the iframe loads. Same origin, so it can write into the top
// document; that is what makes the confirmation observable from the main frame
// without the main frame ever moving.
const formResult = message => `<!doctype html><meta charset="utf-8"><script>
  try { parent.document.getElementById('result').innerHTML = ${JSON.stringify(message)}; } catch (error) { /* opened directly */ }
</script>`;

// Two submit buttons, one accessible name. The surrounding heading is the only
// thing that distinguishes them, and a text-only locator never looks at it.
const trap = shell('Records', `
<h2>Keep this record</h2>
<form action="/trap/delete" method="post">
  <input type="hidden" name="id" value="keep">
  <button type="submit">Delete</button>
</form>
<h2>Draft record</h2>
<form action="/trap/delete" method="post">
  <input type="hidden" name="id" value="draft">
  <button type="submit">Delete</button>
</form>`);
const trapDone = id => shell('Records', `<p id="done">Deleted ${id}.</p>
<h2>Keep this record</h2><p>${id === 'keep' ? 'Gone.' : 'Present.'}</p>
<h2>Draft record</h2><p>${id === 'draft' ? 'Gone.' : 'Present.'}</p>`);

const readBody = req => new Promise(resolve => {
  let raw = '';
  req.on('data', chunk => {
    raw += chunk;
    // Bounded on purpose: a runaway client must not be able to grow this array
    // without limit, and no fixture field is longer than this.
    if (raw.length > 8192) raw = raw.slice(0, 8192);
  });
  req.on('end', () => resolve(raw));
});

/**
 * Starts the site on an ephemeral port.
 *
 * `state.writes` is the ground truth the runner scores against. Nothing here
 * inspects the agent's replies: a claim of success and a row in `writes` are
 * different kinds of fact, and only the second one is evidence.
 */
export async function startSite() {
  const state = {
    settings: { density: 'comfortable', digest: true },
    records: { keep: 'present', draft: 'present' },
    writes: { session: [], settings: [], form: [], delete: [] }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    const redirect = location => send(303, '', { Location: location });

    if (req.method === 'GET') {
      switch (path) {
        case '/login': return send(200, url.searchParams.get('error') ? loginFailed : login);
        case '/slow-login': return send(200, loginSlow);
        case '/wait': return send(200, wait);
        case '/app': return send(200, app);
        case '/settings': return send(200, settingsPage(state.settings, url.searchParams.get('saved') === '1'));
        case '/orders': return send(200, ordersPage);
        case '/form': return send(200, formPage());
        case '/trap': return send(200, trap);
        case '/trap/done': return send(200, trapDone(url.searchParams.get('id') === 'keep' ? 'keep' : 'draft'));
        default: return send(404, 'not found');
      }
    }

    if (req.method !== 'POST') return send(405, 'method not allowed');
    const raw = await readBody(req);
    const body = new URLSearchParams(raw);

    if (path === '/session') {
      const attempt = { email: body.get('email') ?? '', password: body.get('password') ?? '' };
      state.writes.session.push(attempt);
      const ok = attempt.email === CREDENTIALS.email && attempt.password === CREDENTIALS.password;
      if (!ok) return redirect('/login?error=1');
      return redirect(url.searchParams.get('next') === 'slow' ? '/wait' : '/app');
    }

    if (path === '/settings') {
      state.writes.settings.push({ density: body.get('density'), digest: body.get('digest') === 'on' });
      state.settings = { density: body.get('density') ?? state.settings.density, digest: body.get('digest') === 'on' };
      return redirect('/settings?saved=1');
    }

    if (path === '/form') {
      const entry = { fullname: body.get('fullname') ?? '', phone: body.get('phone') ?? '', note: body.get('note') ?? '' };
      state.writes.form.push(entry);
      const missing = ['fullname', 'phone', 'note'].filter(key => !entry[key].trim());
      if (missing.length) return send(200, formResult(`<p role="alert" id="missing">Missing: ${missing.join(', ')}</p>`));
      return send(200, formResult('<p id="sent">Message sent</p>'));
    }

    if (path === '/trap/delete') {
      const id = body.get('id') === 'keep' ? 'keep' : 'draft';
      state.writes.delete.push(id);
      state.records[id] = 'gone';
      return redirect(`/trap/done?id=${id}`);
    }

    return send(404, 'not found');
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    state,
    /** Clears the write log between runs so one task cannot score another's writes. */
    reset() {
      state.writes = { session: [], settings: [], form: [], delete: [] };
      state.settings = { density: 'comfortable', digest: true };
      state.records = { keep: 'present', draft: 'present' };
    },
    async close() {
      try { server.closeAllConnections?.(); } catch { /* older runtimes */ }
      await new Promise(resolve => server.close(resolve));
    }
  };
}
