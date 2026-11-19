// Minimal Electrum-protocol client (JSON-RPC over TLS, one line per message), as spoken by Electrum wallets, Bitcart,
// ElectrumX, Fulcrum and electrs servers. Keeps one connection per server, reconnects when needed, and can ask a
// different server for a second opinion.
import tls from 'node:tls';

const TIMEOUT = 20000;

class Conn {
  constructor(hostport, log) {
    const [host, port] = hostport.split(':');
    Object.assign(this, { hostport, host, port: Number(port), log, sock: null, ready: null, id: 0, pending: new Map(), buf: '', failedAt: 0 });
  }
  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      // Electrum servers commonly use self-signed certificates (wallets trust on first use); answers are cross-checked
      // between two servers before a payment counts, so a lying server can't make a payment count on its own.
      const s = tls.connect({ host: this.host, port: this.port, servername: this.host, rejectUnauthorized: false, timeout: TIMEOUT });
      const fail = (e) => { this.close(e); reject(e); };
      s.once('secureConnect', () => {
        this.sock = s;
        s.setTimeout(0);
        this.call('server.version', ['Pawment', '1.4']).then(() => resolve(this), fail);
      });
      s.on('data', (d) => this.onData(d));
      s.on('error', fail);
      s.on('timeout', () => fail(new Error('timeout')));
      s.on('close', () => this.close(new Error('closed')));
    });
    return this.ready;
  }
  onData(d) {
    this.buf += d;
    if (this.buf.length > 20e6) return this.close(new Error('answer too large'));
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;   // notifications are ignored
      this.pending.delete(msg.id); clearTimeout(p.t);
      if (msg.error) p.reject(new Error(this.host + ': ' + (msg.error.message || JSON.stringify(msg.error)).slice(0, 200)));
      else p.resolve(msg.result);
    }
  }
  call(method, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.sock) return reject(new Error('not connected'));
      const id = ++this.id;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(this.host + ': no answer')); }, TIMEOUT);
      this.pending.set(id, { resolve, reject, t });
      this.sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  close(err) {
    if (this.sock) { try { this.sock.destroy(); } catch { /* ignore */ } }
    this.sock = null; this.ready = null; this.buf = '';
    for (const [, p] of this.pending) { clearTimeout(p.t); p.reject(err || new Error('closed')); }
    this.pending.clear();
    if (err) this.failedAt = Date.now();
  }
}

export function createElectrumPool(servers, { log = console.log } = {}) {
  const conns = servers.map((s) => new Conn(s, log));
  // healthy servers first, the rest after a cool-down
  const order = () => [...conns].sort((a, b) => (a.failedAt > Date.now() - 300000) - (b.failedAt > Date.now() - 300000));
  async function on(method, params, { skip = null } = {}) {
    let last;
    for (const c of order()) {
      if (skip && c.hostport === skip) continue;
      try { await c.connect(); return { result: await c.call(method, params), server: c.hostport }; } catch (e) { last = e; c.close(e); }
    }
    throw last || new Error('no Electrum server answered');
  }
  return {
    servers,
    /** ask one server; returns {result, server} */
    on,
    request: async (method, params) => (await on(method, params)).result,
    /** ask a server other than `notThis` (for a second opinion); null if no other server answers */
    async other(method, params, notThis) { try { return await on(method, params, { skip: notThis }); } catch { return null; } },
    close() { conns.forEach((c) => c.close()); },
  };
}

/** Outputs of a raw transaction (hex): [{index, value (BigInt), script (Buffer)}]. Handles SegWit. */
export function txOutputs(hex) {
  const b = Buffer.from(hex, 'hex');
  let o = 4;
  const varint = () => {
    const f = b[o++];
    if (f < 0xfd) return f;
    if (f === 0xfd) { const v = b.readUInt16LE(o); o += 2; return v; }
    if (f === 0xfe) { const v = b.readUInt32LE(o); o += 4; return v; }
    const v = Number(b.readBigUInt64LE(o)); o += 8; return v;
  };
  if (b[o] === 0 && b[o + 1] === 1) o += 2;   // SegWit marker + flag
  const nin = varint();
  for (let i = 0; i < nin; i++) { o += 36; const l = varint(); o += l + 4; }
  const nout = varint();
  const outs = [];
  for (let i = 0; i < nout; i++) {
    const value = b.readBigUInt64LE(o); o += 8;
    const l = varint(); const script = b.subarray(o, o + l); o += l;
    outs.push({ index: i, value, script });
  }
  if (o > b.length) throw new Error('bad transaction');
  return outs;
}
