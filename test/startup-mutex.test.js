import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

test('concurrent start invocation does not enter setup twice', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-start-lock-'));
  const server = http.createServer((req,res) => { res.setHeader('content-type','application/json'); res.end('{"service":"ai-browser-bridge"}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(root, { recursive:true, force:true }); });
  mkdirSync(join(root, 'src')); mkdirSync(join(root, '.local'));
  copyFileSync(fileURLToPath(new URL('../start.ps1', import.meta.url)), join(root, 'start.ps1'));
  writeFileSync(join(root,'.local','config.json'), JSON.stringify({port:server.address().port,agentToken:'fixture'}));
  writeFileSync(join(root,'src','cli.js'), "const fs=require('fs');fs.appendFileSync(require('path').join(__dirname,'../entered'),'x');setTimeout(()=>{},2000);");
  const launch = () => {
    const p=spawn('pwsh.exe',['-NoProfile','-File',join(root,'start.ps1')],{stdio:'ignore'});
    t.after(()=>{ if(p.exitCode===null) p.kill(); });
    return once(p,'exit');
  };
  const first=launch();
  const deadline=Date.now()+7000;
  while(!existsSync(join(root,'entered')) && Date.now()<deadline) await new Promise(r=>setTimeout(r,30));
  assert.ok(existsSync(join(root,'entered')));
  const second=launch();
  const results=await Promise.all([first,second]);
  assert.deepEqual(results.map(r=>r[0]),[0,0]);
  assert.equal(readFileSync(join(root,'entered'),'utf8'),'x');
});
