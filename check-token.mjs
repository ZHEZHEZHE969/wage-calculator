// 检查 wage-calculator 部署用的 GitHub token 是否有效 / 何时过期
// 用法: node check-token.mjs
// 说明: 走 Node 自己的 TLS（不受沙箱里 schannel 拿不到凭据的影响）；
//       直连失败时自动改走本机代理 127.0.0.1:7890。
import tls from 'node:tls';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'api.github.com';
const PROXY = { host: '127.0.0.1', port: 7890 };
const here = path.dirname(fileURLToPath(import.meta.url));
const token = fs.readFileSync(path.join(here, '.token'), 'utf8').trim();
const repo = 'ZHEZHEZHE969/wage-calculator';

const reqText = (p) =>
  `GET ${p} HTTP/1.1\r\nHost: ${HOST}\r\nAuthorization: Bearer ${token}\r\n` +
  `Accept: application/vnd.github+json\r\nUser-Agent: token-check\r\n` +
  `X-GitHub-Api-Version: 2022-11-28\r\nConnection: close\r\n\r\n`;

const parse = (raw) => {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const status = head.split('\r\n')[0] || 'ERR';
  const exp = /github-authentication-token-expiration:\s*(\S+)/i.exec(head);
  return { status, exp: exp ? exp[1] : null, body: rest.join('\r\n\r\n') };
};

const collect = (sock) =>
  new Promise((resolve) => {
    let buf = '';
    sock.on('data', (d) => (buf += d.toString('utf8')));
    sock.on('end', () => resolve(parse(buf)));
    sock.on('error', (e) => resolve({ status: 'ERR ' + e.message, exp: null, body: '' }));
    setTimeout(() => resolve(parse(buf)), 15000);
  });

const direct = (p) =>
  new Promise((resolve) => {
    const t = tls.connect({ host: HOST, port: 443, servername: HOST }, () => t.write(reqText(p)));
    let done = false;
    t.on('error', (e) => {
      if (!done) {
        done = true;
        resolve({ status: 'ERR ' + e.message, exp: null, body: '' });
      }
    });
    collect(t).then((r) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    });
  });

const viaProxy = (p) =>
  new Promise((resolve) => {
    const req = http.request({
      host: PROXY.host,
      port: PROXY.port,
      method: 'CONNECT',
      path: `${HOST}:443`,
      headers: { Host: `${HOST}:443` },
      timeout: 15000,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return resolve({ status: 'ERR proxy ' + res.statusCode, exp: null, body: '' });
      const t = tls.connect({ socket, servername: HOST }, () => t.write(reqText(p)));
      t.on('error', (e) => resolve({ status: 'ERR ' + e.message, exp: null, body: '' }));
      collect(t).then(resolve);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'ERR proxy timeout', exp: null, body: '' });
    });
    req.on('error', (e) => resolve({ status: 'ERR ' + e.message, exp: null, body: '' }));
    req.end();
  });

async function get(p, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await direct(p);
    if (!last.status.startsWith('ERR')) return last;
    await new Promise((r) => setTimeout(r, 800));
  }
  const proxied = await viaProxy(p);
  return proxied.status.startsWith('ERR') ? last : proxied;
}

console.log(`token: ${token.slice(0, 16)}…${token.slice(-4)}  (${token.slice(0, 11)}, ${token.length} 字符)`);

const user = await get('/user');
if (!user.status.includes('200')) {
  console.log(`✗ 失效：${user.status}`);
  console.log('  → 去 GitHub 重新生成细粒度 token，替换本目录 .token 即可。');
  process.exit(1);
}
const me = JSON.parse(user.body);
console.log(`✓ 有效，账号 ${me.login}`);
console.log(`  过期时间：${user.exp ?? '无（未设置到期时间）'}`);
if (user.exp) console.log(`  剩余 ${Math.floor((new Date(user.exp) - Date.now()) / 86400000)} 天`);

const r = await get(`/repos/${repo}`);
if (r.status.includes('200')) {
  const j = JSON.parse(r.body);
  console.log(`✓ 仓库 ${j.full_name}：push=${j.permissions?.push}, admin=${j.permissions?.admin}`);
} else {
  console.log(`? 仓库检查没通过（${r.status}）—— 网络抖动时可能误报，token 本身已确认有效`);
}
