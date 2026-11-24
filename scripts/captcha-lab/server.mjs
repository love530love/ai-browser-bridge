// Local heavy-captcha range for rehearsing browser_captcha_* end to end.
// Two loopback origins on purpose: a character captcha on 127.0.0.1:8771 and a
// Google-style image grid inside a cross-origin iframe served by 127.0.0.1:8772,
// so the all-frame probe, host-iframe capture and multi-round verdict paths run
// against something that behaves like the real thing.
// Truth stays on the server: the page never knows the character code or which
// tiles are correct, exactly like a real challenge.
import http from 'node:http';

const HOST = '127.0.0.1';
const PARENT_PORT = 8771;
const FRAME_PORT = 8772;
const CHAR_TTL_MS = 120000;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SHAPES = [
  { id: 'square', zh: '正方形', en: 'squares' },
  { id: 'circle', zh: '圆形', en: 'circles' },
  { id: 'triangle', zh: '三角形', en: 'triangles' },
  { id: 'star', zh: '星形', en: 'stars' }
];
const TILE_BACKGROUNDS = ['#dfe8f3', '#e8f0df', '#f3e6df', '#e4dff3', '#f3efe0', '#dff0f0'];
const GRID_ROUNDS = 2;

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = list => list[rand(0, list.length - 1)];
const token = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const log = [];
function record(entry) {
  log.push({ at: new Date().toISOString(), ...entry });
  if (log.length > 200) log.splice(0, log.length - 200);
}

// ---- character challenge --------------------------------------------------
let character = null;
function newCharacter() {
  const code = Array.from({ length: 4 }, () => pick(CODE_ALPHABET)).join('');
  character = { token: token(), code, expiresAt: Date.now() + CHAR_TTL_MS, solved: false };
  return character;
}

function charNoise() {
  const dots = Array.from({ length: 26 }, () =>
    `<circle cx="${rand(0, 160)}" cy="${rand(0, 56)}" r="${rand(1, 2)}" fill="#9fb0c4" opacity="0.5"/>`).join('');
  const strokes = Array.from({ length: 5 }, () =>
    `<line x1="${rand(0, 160)}" y1="${rand(0, 56)}" x2="${rand(0, 160)}" y2="${rand(0, 56)}" stroke="#8fa3b8" stroke-width="1" opacity="0.45"/>`).join('');
  return dots + strokes;
}

function charSvg(code) {
  const glyphs = [...code].map((ch, i) => {
    const x = 18 + i * 34 + rand(-3, 3);
    const y = 38 + rand(-5, 5);
    const rot = rand(-16, 16);
    const size = 30 + rand(-2, 4);
    const fill = pick(['#16324f', '#4a2f1b', '#1f4d2e', '#3a1f4d']);
    return `<text x="${x}" y="${y}" transform="rotate(${rot} ${x} ${y})" font-family="Consolas, 'Courier New', monospace" font-size="${size}" font-weight="700" fill="${fill}">${ch}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="56" viewBox="0 0 160 56"><rect width="160" height="56" fill="#eef3f9"/>${charNoise()}${glyphs}</svg>`;
}

// ---- grid challenge -------------------------------------------------------
let grid = null;
function makeRound(index) {
  const target = index === 0 ? SHAPES[0] : SHAPES[1 + (index % (SHAPES.length - 1))];
  const targetCount = rand(3, 4);
  const targetIndices = new Set();
  while (targetIndices.size < targetCount) targetIndices.add(rand(0, 8));
  const others = SHAPES.filter(shape => shape.id !== target.id);
  const tiles = Array.from({ length: 9 }, (_, i) => {
    const shape = targetIndices.has(i) ? target : pick(others);
    return { index: i, shape: shape.id };
  });
  return {
    round: index,
    rounds: GRID_ROUNDS,
    instruction: `请选择所有包含${target.zh}(${target.en})的图片`,
    targets: [...targetIndices].sort((a, b) => a - b),
    tiles
  };
}

function newGrid() {
  grid = { token: token(), passed: false, attempts: 0, round: makeRound(0) };
  return { token: grid.token, ...publicRound() };
}

function refreshGrid() {
  if (!grid || grid.passed) return newGrid();
  grid.round = makeRound(grid.round.round);
  grid.token = token();
  return { token: grid.token, ...publicRound() };
}

function publicRound() {
  const { round, rounds, instruction, tiles } = grid.round;
  return {
    round, rounds, instruction,
    tiles: tiles.map(tile => ({ index: tile.index, icon: tileSvg(tile.shape, pick(TILE_BACKGROUNDS)) }))
  };
}

function tileSvg(shape, background) {
  const fill = '#1d3557';
  const inner =
    shape === 'square' ? `<rect x="26" y="26" width="48" height="48" rx="4" fill="${fill}"/>` :
    shape === 'circle' ? `<circle cx="50" cy="50" r="26" fill="${fill}"/>` :
    shape === 'triangle' ? `<polygon points="50,22 76,72 24,72" fill="${fill}"/>` :
    `<polygon points="50,20 59,42 83,42 64,56 71,79 50,64 29,79 36,56 17,42 41,42" fill="${fill}"/>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="${background}"/>${inner}</svg>`)}`;
}

function answerGrid({ token: submitted, round, selected }) {
  if (!grid || grid.passed) return { ok: false, message: '挑战已结束' };
  if (submitted !== grid.token || round !== grid.round.round) return { ok: false, stale: true, message: '挑战已刷新，请按新图片作答' };
  grid.attempts++;
  const chosen = [...new Set(Array.isArray(selected) ? selected.filter(Number.isInteger) : [])].sort((a, b) => a - b);
  const want = grid.round.targets.join(',');
  const got = chosen.join(',');
  if (want !== got) {
    record({ kind: 'grid', round, accepted: false, chosenCount: chosen.length, targetCount: grid.round.targets.length, attempts: grid.attempts });
    return { ok: false, message: '验证失败，请重试' };
  }
  record({ kind: 'grid', round, accepted: true, attempts: grid.attempts });
  if (round + 1 < GRID_ROUNDS) {
    grid.round = makeRound(round + 1);
    grid.token = token();
    return { ok: true, next: true, token: grid.token, ...publicRound() };
  }
  grid.passed = true;
  return { ok: true, passed: true, message: '验证成功' };
}

// ---- pages ----------------------------------------------------------------
const characterPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>角色型图形验证码靶场</title>
<style>
  body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f2f5fa;margin:0;padding:40px;color:#1d2940}
  main{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 8px 24px rgba(29,41,64,.08)}
  h1{font-size:20px;margin:0 0 18px}
  .captcha-box{border:1px solid #d5dde8;border-radius:10px;padding:16px;display:grid;grid-template-columns:auto 1fr;gap:10px 14px;align-items:center}
  .captcha-box img{width:160px;height:56px;border-radius:6px;border:1px solid #cfd8e4;display:block}
  .captcha-box input{width:150px;padding:9px 10px;font-size:16px;letter-spacing:3px;text-transform:uppercase;border:1px solid #c4cfdd;border-radius:8px}
  .captcha-box button{padding:9px 16px;border-radius:8px;border:1px solid #1d4ed8;background:#1d4ed8;color:#fff;font-size:14px;cursor:pointer}
  .captcha-box a.refresh-link{font-size:13px;color:#1d4ed8;cursor:pointer;text-decoration:underline}
  .captcha-msg{font-size:13px;color:#5b6b82;grid-column:1 / -1;min-height:18px}
  .captcha-msg.error{color:#b3261e}.captcha-msg.pass{color:#1a7f37;font-weight:600}
  .pass-note{color:#1a7f37;font-weight:600}
  p.hint{font-size:13px;color:#6a7890;line-height:1.6}
</style></head>
<body><main>
  <h1>角色型图形验证码（本地靶场）</h1>
  <div class="captcha-box" id="captchaBox">
    <img id="captchaImage" alt="验证码" src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='56'%3E%3Crect width='160' height='56' fill='%23eef3f9'/%3E%3C/svg%3E">
    <div>
      <input id="captchaCode" name="captchaCode" placeholder="请输入验证码" maxlength="4" autocomplete="off">
      <a class="refresh-link" id="captchaRefresh" title="换一张验证码">换一张</a>
    </div>
    <span class="captcha-msg" id="captchaMsg"></span>
    <button id="captchaSubmit" type="button">提交</button>
  </div>
  <p class="hint">真实图解：图形码 120 秒过期，提交错误会提示重新输入，刷新会作废旧码。</p>
</main>
<script>
  const img = document.getElementById('captchaImage');
  const input = document.getElementById('captchaCode');
  const msg = document.getElementById('captchaMsg');
  const box = document.getElementById('captchaBox');
  const say = (text, cls) => { msg.textContent = text; msg.className = 'captcha-msg' + (cls ? ' ' + cls : ''); };
  const load = async () => {
    const fresh = await fetch('/api/char/new').then(r => r.json());
    img.src = fresh.imageUrl;
    box.dataset.token = fresh.token;
    input.value = '';
    say('');
    input.focus();
  };
  document.getElementById('captchaRefresh').addEventListener('click', load);
  document.getElementById('captchaSubmit').addEventListener('click', async () => {
    const token = box.dataset.token || '';
    const answer = input.value.trim();
    if (!answer) { say('请输入验证码', 'error'); return; }
    const res = await fetch('/api/char/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, answer }) });
    const data = await res.json();
    if (data.ok) {
      img.style.display = 'none';
      input.style.display = 'none';
      box.querySelector('button').style.display = 'none';
      box.querySelector('.refresh-link').style.display = 'none';
      say('验证成功', 'pass');
    } else {
      say(data.message || '验证失败', 'error');
    }
  });
  load();
</script></body></html>`;

const gridPage = (frameOrigin) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>跨域图片点选靶场</title>
<style>
  body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f2f5fa;margin:0;padding:40px;color:#1d2940}
  main{max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 8px 24px rgba(29,41,64,.08)}
  h1{font-size:20px;margin:0 0 8px}
  p.hint{font-size:13px;color:#6a7890;line-height:1.6;margin:0 0 18px}
  .widget-frame{width:100%;height:520px;border:0;display:block}
</style></head>
<body><main>
  <h1>图片点选验证（跨域 iframe）</h1>
  <p class="hint">网格在另一个源上渲染（${frameOrigin}），与 Google reCAPTCHA bframe 的隔离方式相同。两轮均正确才会通过。</p>
  <iframe class="widget-frame" id="challengeFrame" src="${frameOrigin}/frame" title="安全验证 reCAPTCHA" width="100%" height="520"></iframe>
</main></body></html>`;

const framePage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>bframe</title>
<style>
  body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;background:#fff;padding:14px}
  #rc-imageselect{width:320px;margin:0 auto}
  .rc-imageselect-desc{font-size:15px;color:#1d2940;margin:0 0 10px;line-height:1.5}
  .rc-imageselect-table{border-collapse:collapse}
  .rc-imageselect-tile{width:100px;height:100px;border:2px solid #fff;background-size:cover;background-position:center;cursor:pointer;position:relative;padding:0}
  .rc-imageselect-tile.selected{outline:3px solid #1d4ed8;outline-offset:-3px}
  .rc-imageselect-tile.selected::after{content:'✓';position:absolute;top:4px;left:6px;color:#fff;background:#1d4ed8;border-radius:50%;width:22px;height:22px;line-height:22px;text-align:center;font-size:14px}
  .rc-imageselect-incorrect-response{color:#b3261e;font-size:13px;margin:8px 0}
  .grid-actions{display:flex;justify-content:space-between;margin-top:10px}
  .grid-actions button{padding:8px 16px;border-radius:8px;border:1px solid #c4cfdd;background:#fff;font-size:14px;cursor:pointer}
  #recaptcha-verify-button{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
  .pass-note{color:#1a7f37;font-weight:600;font-size:14px;margin-top:8px}
</style></head>
<body>
<div id="rc-imageselect" class="rc-imageselect"></div>
<script>
  const root = document.getElementById('rc-imageselect');
  let state = null;

  const build = () => {
    root.innerHTML = '';
    const desc = document.createElement('div');
    desc.className = 'rc-imageselect-desc';
    desc.id = 'rc-imageselect-desc';
    desc.textContent = state.instruction;
    root.appendChild(desc);

    const table = document.createElement('table');
    table.className = 'rc-imageselect-table';
    const tbody = document.createElement('tbody');
    for (let row = 0; row < 3; row++) {
      const tr = document.createElement('tr');
      for (let col = 0; col < 3; col++) {
        const index = row * 3 + col;
        const tile = state.tiles[index];
        const td = document.createElement('td');
        td.className = 'rc-imageselect-tile';
        td.dataset.index = String(index);
        td.setAttribute('role', 'button');
        td.setAttribute('aria-pressed', 'false');
        td.style.backgroundImage = 'url("' + tile.icon + '")';
        td.addEventListener('click', () => toggle(td));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    root.appendChild(table);

    const error = document.createElement('div');
    error.className = 'rc-imageselect-incorrect-response';
    error.id = 'grid-error';
    error.style.display = 'none';
    root.appendChild(error);

    const actions = document.createElement('div');
    actions.className = 'grid-actions';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.id = 'recaptcha-reload-button';
    reload.textContent = '换一张';
    reload.addEventListener('click', refresh);
    const verify = document.createElement('button');
    verify.type = 'button';
    verify.id = 'recaptcha-verify-button';
    verify.textContent = '验证';
    verify.addEventListener('click', submit);
    actions.append(reload, verify);
    root.appendChild(actions);
  };

  const toggle = td => {
    const selected = td.classList.toggle('selected');
    td.setAttribute('aria-pressed', selected ? 'true' : 'false');
    const error = document.getElementById('grid-error');
    if (error && error.style.display !== 'none' && [...root.querySelectorAll('.rc-imageselect-tile.selected')].length) {
      error.style.display = 'none';
    }
  };

  const refresh = async () => {
    const fresh = await fetch('/api/grid/refresh', { method: 'POST' }).then(r => r.json());
    state = fresh;
    build();
  };

  const submit = async () => {
    const selected = [...root.querySelectorAll('.rc-imageselect-tile.selected')].map(td => Number(td.dataset.index));
    const res = await fetch('/api/grid/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: state.token, round: state.round, selected })
    }).then(r => r.json());
    if (res.passed) { showPass(); return; }
    if (res.next) { state = res; build(); return; }
    const error = document.getElementById('grid-error');
    error.textContent = res.message || '验证失败，请重试';
    error.style.display = 'block';
  };

  const showPass = () => {
    root.innerHTML = '<div class="rc-imageselect-desc">验证成功</div><div class="pass-note">已通过安全验证，可以继续操作。</div>';
  };

  fetch('/api/grid/new').then(r => r.json()).then(fresh => { state = fresh; build(); });
</script>
</body></html>`;

// ---- servers --------------------------------------------------------------
const readBody = req => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', chunk => { data += chunk; if (data.length > 10000) req.destroy(); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (error) { reject(error); } });
  req.on('error', reject);
});

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
};

const parentServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PARENT_PORT}`);
  try {
    if (url.pathname === '/') {
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>captcha-lab</title><body style="font-family:system-ui;padding:40px"><h1>captcha-lab</h1><ul><li><a href="/character">角色型图形验证码</a></li><li><a href="/grid">跨域多轮图片点选</a></li></ul></body>`, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/character') return send(res, 200, characterPage, 'text/html; charset=utf-8');
    if (url.pathname === '/grid') return send(res, 200, gridPage(`http://${HOST}:${FRAME_PORT}`), 'text/html; charset=utf-8');
    if (url.pathname === '/api/char/new') {
      const fresh = newCharacter();
      return send(res, 200, { token: fresh.token, imageUrl: `/api/char/image?t=${fresh.token}`, length: 4, expiresInMs: CHAR_TTL_MS });
    }
    if (url.pathname === '/api/char/image') {
      const wanted = url.searchParams.get('t');
      if (!character || wanted !== character.token) return send(res, 404, { ok: false, message: '验证码已刷新' });
      return send(res, 200, charSvg(character.code), 'image/svg+xml; charset=utf-8');
    }
    if (url.pathname === '/api/char/answer' && req.method === 'POST') {
      const body = await readBody(req);
      if (!character || body.token !== character.token) {
        record({ kind: 'character', accepted: false, reason: 'stale_or_missing' });
        return send(res, 200, { ok: false, expired: true, message: '验证码已过期，请刷新后重试' });
      }
      if (Date.now() > character.expiresAt) {
        record({ kind: 'character', accepted: false, reason: 'expired' });
        return send(res, 200, { ok: false, expired: true, message: '验证码已过期，请刷新后重试' });
      }
      const answer = String(body.answer || '').trim().toUpperCase();
      const ok = answer === character.code;
      record({ kind: 'character', accepted: ok, answerLength: answer.length, reason: ok ? 'accepted' : 'wrong' });
      if (!ok) return send(res, 200, { ok: false, message: '验证码错误，请重新输入' });
      character.solved = true;
      return send(res, 200, { ok: true, message: '验证成功' });
    }
    if (url.pathname === '/api/lab-log') return send(res, 200, { entries: log });
    return send(res, 404, { ok: false, message: 'not found' });
  } catch (error) {
    return send(res, 500, { ok: false, message: String(error?.message || error) });
  }
});

const frameServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${FRAME_PORT}`);
  try {
    if (url.pathname === '/frame') return send(res, 200, framePage, 'text/html; charset=utf-8');
    if (url.pathname === '/api/grid/new') return send(res, 200, newGrid());
    if (url.pathname === '/api/grid/refresh' && req.method === 'POST') return send(res, 200, refreshGrid());
    if (url.pathname === '/api/grid/answer' && req.method === 'POST') {
      const body = await readBody(req);
      const verdict = answerGrid(body);
      return send(res, 200, verdict);
    }
    if (url.pathname === '/api/lab-log') return send(res, 200, { entries: log });
    return send(res, 404, { ok: false, message: 'not found' });
  } catch (error) {
    return send(res, 500, { ok: false, message: String(error?.message || error) });
  }
});

parentServer.listen(PARENT_PORT, HOST, () => {
  frameServer.listen(FRAME_PORT, HOST, () => {
    console.log(`captcha-lab parent  http://${HOST}:${PARENT_PORT}/character  http://${HOST}:${PARENT_PORT}/grid`);
    console.log(`captcha-lab frame   http://${HOST}:${FRAME_PORT}/frame`);
  });
});
