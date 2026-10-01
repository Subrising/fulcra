// H6 item 3 (J8-REPORT.md s3, "What to instrument"). The 07:23Z stall could not be diagnosed from the controller side:
// controller.log had no timestamps and no request timings, so whether the controller's single thread was blocked in
// SQLite (DatabaseSync, synchronous=FULL) or waiting on native inspect and git was inference. This module records:
//
//   - one JSON line per RPC: method, time waiting on the socket (accept -> full request line), handler duration,
//     time spent inside SQLite calls made on that request's behalf, and whether it succeeded;
//   - one JSON line every 30 s: event-loop delay (p50/p99/max/mean, from perf_hooks) and the RPC count in the window.
//
// What it never records: request input, capabilities, the operator secret, or error text. A line carries a method
// name that passed a strict pattern, an error CLASS, and numbers. SQLite time is attributed with AsyncLocalStorage;
// node:sqlite is synchronous, so the time of each call belongs exactly to the request whose code made it, even while
// requests interleave at their awaits.
//
// Bounded: when the controller's stdout is verified to BE the log file (same device and inode as the configured
// path), lines are appended through the controller's own handle and the file rotates at maxBytes, keeping `keep`
// old files -- at most (keep + 1) * maxBytes on disk. Otherwise (tests, a terminal, a portable installation whose
// stdout is not that file) lines go to the given stream unrotated, exactly as the controller's other lines do.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export const DEFAULT_LOG = path.join(os.homedir(), 'Library', 'Logs', 'Orca', 'controller.log');
export const MAX_LOG_BYTES = 4 * 1024 * 1024, KEEP_LOGS = 2, LOOP_SAMPLE_MS = 30000;
const request = new AsyncLocalStorage();
const round = n => Math.round(n * 10) / 10;

// ---- SQLite time, per request
// Wraps a store's DatabaseSync in place. Every prepared statement's run/get/all/iterate and every exec is timed and
// added to the current request's account, if there is one. Everything else passes through unchanged.
export function instrumentDb(store) {
  const db = store.db;
  if (db?.[INSTRUMENTED]) return store;
  const account = (started) => { const r = request.getStore(); if (r) { r.sqliteMs += performance.now() - started; r.sqliteCalls++; } };
  const timed = (fn, self) => (...args) => { const t = performance.now(); try { return fn.apply(self, args); } finally { account(t); } };
  const statement = s => new Proxy(s, { get(target, prop) {
    const v = target[prop];
    if (typeof v !== 'function') return v;
    return ['run', 'get', 'all', 'iterate'].includes(prop) ? timed(v, target) : v.bind(target);
  } });
  store.db = new Proxy(db, { get(target, prop) {
    if (prop === INSTRUMENTED) return true;
    const v = target[prop];
    if (prop === 'prepare') return (...args) => { const t = performance.now(); try { return statement(v.apply(target, args)); } finally { account(t); } };
    if (prop === 'exec') return timed(v, target);
    return typeof v === 'function' ? v.bind(target) : v;
  } });
  return store;
}
const INSTRUMENTED = Symbol('orca.instrumented');

// ---- the log
export class MetricsLog {
  // stream: where lines go when the file cannot be verified as this process's stdout (default process.stdout).
  constructor({ file = process.env.ORCA_CONTROLLER_LOG ?? DEFAULT_LOG, maxBytes = MAX_LOG_BYTES, keep = KEEP_LOGS, stream = process.stdout, stdoutFd = 1 } = {}) {
    this.file = file; this.maxBytes = maxBytes; this.keep = keep; this.stream = stream; this.fd = null; this.size = 0; this.lastError = null;
    try {
      const out = fs.fstatSync(stdoutFd), at = fs.statSync(file);
      if (out.isFile() && at.isFile() && out.dev === at.dev && out.ino === at.ino) this.open();
    } catch { /* not verifiable: fall back to the stream */ }
  }
  get rotating() { return this.fd !== null; }
  open() { this.fd = fs.openSync(this.file, 'a', 0o600); this.size = fs.fstatSync(this.fd).size; }
  rotate() {
    fs.closeSync(this.fd); this.fd = null;
    for (let n = this.keep; n >= 1; n--) { const from = n === 1 ? this.file : `${this.file}.${n - 1}`; if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${n}`); }
    this.open();
  }
  line(record) {
    const text = JSON.stringify({ t: new Date().toISOString(), ...record }) + '\n';
    try {
      if (this.fd === null) { this.stream.write(text); return; }
      if (this.size + Buffer.byteLength(text) > this.maxBytes) this.rotate();
      fs.writeSync(this.fd, text); this.size += Buffer.byteLength(text);
    } catch (e) { this.lastError = { message: e.message, at: new Date().toISOString() }; }   // logging never fails an RPC
  }
  close() { if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; } }
}

// ---- per-RPC lines
// REVIEW-H6 F2: a method is logged only if it is one the dispatcher answers (a closed set, rpc.mjs RPC_METHODS). A
// pattern was not enough: a caller could put a token-shaped value in `method` and see it logged, even when refused.
export const methodName = (r, known) => (r && typeof r === 'object' && typeof r.method === 'string' && known instanceof Set && known.has(r.method)) ? r.method : 'unknown';
// Wraps the rpc dispatcher. `times` = { acceptedAt, receivedAt } from performance.now(), measured by the socket server.
export function timedDispatch(dispatch, log, counter = { rpcs: 0 }, known = null) {
  return async (req, times = {}) => {
    const account = { sqliteMs: 0, sqliteCalls: 0 }, started = performance.now();
    let ok = true, errorClass = null;
    try { return await request.run(account, () => dispatch(req)); }
    catch (e) { ok = false; errorClass = e?.constructor?.name ?? 'Error'; throw e; }
    finally {
      counter.rpcs++;
      log.line({ rpc: methodName(req, known), ok, ...(errorClass ? { error: errorClass } : {}),
        queueMs: times.acceptedAt !== undefined && times.receivedAt !== undefined ? round(times.receivedAt - times.acceptedAt) : null,
        handlerMs: round(performance.now() - started), sqliteMs: round(account.sqliteMs), sqliteCalls: account.sqliteCalls });
    }
  };
}

// ---- event-loop delay, every 30 s
export function startLoopSampler(log, counter = { rpcs: 0 }, intervalMs = LOOP_SAMPLE_MS) {
  const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
  const ms = ns => round(ns / 1e6);
  const timer = setInterval(() => {
    log.line({ loop: { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max), mean: ms(h.mean) }, rpcs: counter.rpcs, windowMs: intervalMs });
    counter.rpcs = 0; h.reset();
  }, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); h.disable(); };
}
