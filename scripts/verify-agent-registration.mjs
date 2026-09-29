import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOLS } from '../src/tools.js';
const results=[];
for (const app of ['cursor','workbuddy']) {
  const path=join(homedir(),`.${app}`,'mcp.json');
  const config=JSON.parse(readFileSync(path,'utf8')).mcpServers['ai-browser-bridge'];
  const client=new Client({name:`verify-${app}-registration`,version:'1.0'});
  try {
    await client.connect(new StdioClientTransport({command:config.command,args:config.args}));
    const count=(await client.listTools()).tools.length;
    if(count!==TOOLS.length) throw new Error(`Unexpected count ${count}; expected ${TOOLS.length}`);
    results.push({app,path,tools:count,stdioHandshake:true,desktopSessionAcceptance:'pending reload'});
    console.log(`PASS ${app} registered command starts and discovers ${count} tools`);
  } finally {await client.close();}
}
mkdirSync('output/agent-registration',{recursive:true});
writeFileSync('output/agent-registration/config-probe.json',JSON.stringify({time:new Date().toISOString(),results},null,2));
