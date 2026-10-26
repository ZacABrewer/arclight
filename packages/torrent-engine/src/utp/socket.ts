import { randomInt } from 'node:crypto';
import { Duplex } from 'node:stream';
import type { PeerAddress } from '../compact.js';
import { TorrentEngineError } from '../errors.js';
import {
  HEADER_SIZE,
  seqAfter,
  seqDiff,
  ST_DATA,
  ST_FIN,
  ST_RESET,
  ST_STATE,
  ST_SYN,
  type UtpPacket,
} from './packet.js';

/** Largest datagram we send (header included). */
export const UTP_MTU = 1400;
export const MAX_PAYLOAD = UTP_MTU - HEADER_SIZE;
/** LEDBAT target queuing delay. */
export const TARGET_DELAY_US = 100_000;
/** LEDBAT gain: max window growth per RTT when the delay is far below target. */
export const MAX_CWND_INCREASE_BYTES_PER_RTT = 3000;
const MIN_WINDOW = UTP_MTU;
const MAX_WINDOW = 4 * 1024 * 1024;
const RECV_WINDOW = 1024 * 1024;
const WRITE_HIGH_WATER = 64 * 1024;
const MAX_OUT_OF_ORDER = 2048;
const SYN_ATTEMPTS = 4;
const MAX_TIMEOUTS = 8;
const KEEPALIVE_MS = 29_000;

export interface UtpSocketOptions {
  /** Floor for the retransmission timeout (BEP 29: 500 ms). */
  minRtoMs?: number;
  /** Timeout before the first RTT sample (BEP 29: 1000 ms). */
  initialRtoMs?: number;
  /** LEDBAT target delay in microseconds. */
  targetDelayUs?: number;
  now?: () => number;
}

interface OutPacket {
  seq: number;
  type: number;
  payload: Buffer;
  size: number;
  sentAt: number;
  transmissions: number;
  /** Counted as lost: waiting to be resent, not part of the in-flight window. */
  needResend: boolean;
  fastResentAt: number;
}

export interface UtpSocketInit {
  remote: PeerAddress;
  recvId: number;
  sendId: number;
  send: (packet: UtpPacket) => void;
  onClose: (sock: UtpSocket) => void;
  opts?: UtpSocketOptions;
}

function microNow(): number {
  return Math.floor(performance.now() * 1000) >>> 0;
}

/** 32-bit wrapping comparison of microsecond values. */
function u32Less(a: number, b: number): boolean {
  return ((a - b) | 0) < 0;
}

/**
 * One uTP connection (BEP 29) as a Node Duplex stream: SYN/STATE/DATA/FIN/RESET state
 * machine, 16-bit sequence numbers with selective ACKs, LEDBAT congestion control, RTT based
 * retransmission timeouts and fast retransmit. The `UtpManager` owns the UDP socket and
 * feeds packets in through `onPacket`.
 */
export class UtpSocket extends Duplex {
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly recvId: number;
  readonly sendId: number;
  /** `syn-recv`: SYN answered, waiting for the initiator's first packet before sending data. */
  state: 'syn-sent' | 'syn-recv' | 'connected' | 'closed';

  private seqNr: number;
  /** Last in-order sequence number received. */
  private ackNr = 0;
  private readonly inflight: OutPacket[] = [];
  private curWindow = 0;
  /** Congestion window (LEDBAT). */
  maxWindow = 2 * UTP_MTU;
  private peerWnd = RECV_WINDOW;
  private sendBuf: Buffer[] = [];
  private sendBufBytes = 0;
  private writeCb: (() => void) | null = null;
  private finalCb: ((err?: Error | null) => void) | null = null;
  private finPending = false;
  private finSent = false;
  private finSeq = -1;
  private readEnded = false;
  private eofSeq = -1;
  private readonly ooo = new Map<number, { type: number; payload: Buffer }>();
  private oooBytes = 0;
  private rtt = 0;
  private rttVar = 0;
  private hasRtt = false;
  private rto = 1000;
  private timeouts = 0;
  private replyMicro = 0;
  private baseHist: number[] = [];
  private baseHistAt = 0;
  private lastAck = -1;
  private dupAcks = 0;
  private lastLossCut = 0;
  private lastTimeoutAt = 0;
  private lossCuts = 0;
  private lastSendAt = 0;
  private lastWndSent = RECV_WINDOW;
  private ackScheduled = false;
  /** Data packets received since we last sent anything (every packet carries ack_nr). */
  private unackedRecv = 0;
  /** Last measured queuing delay (LEDBAT input), microseconds. */
  lastDelayUs = 0;
  private flushScheduled = false;
  private readonly now: () => number;
  private readonly minRto: number;
  private readonly targetDelay: number;
  private readonly sendPacket: (p: UtpPacket) => void;
  private readonly onCloseCb: (s: UtpSocket) => void;
  /** Counters for tests and stats. */
  readonly counters = { sent: 0, resent: 0, received: 0, timeouts: 0 };

  private constructor(init: UtpSocketInit, state: 'syn-sent' | 'syn-recv', seq: number) {
    super({ allowHalfOpen: false, readableHighWaterMark: RECV_WINDOW });
    this.remoteAddress = init.remote.host;
    this.remotePort = init.remote.port;
    this.recvId = init.recvId;
    this.sendId = init.sendId;
    this.sendPacket = init.send;
    this.onCloseCb = init.onClose;
    this.now = init.opts?.now ?? (() => performance.now());
    this.minRto = init.opts?.minRtoMs ?? 500;
    this.rto = Math.max(this.minRto, init.opts?.initialRtoMs ?? 1000);
    this.targetDelay = init.opts?.targetDelayUs ?? TARGET_DELAY_US;
    this.state = state;
    this.seqNr = seq;
  }

  /** Initiator side: sends SYN. Resolve via the `connect` event. */
  static connect(init: Omit<UtpSocketInit, 'recvId' | 'sendId'> & { recvId: number }): UtpSocket {
    const s = new UtpSocket({ ...init, sendId: (init.recvId + 1) & 0xffff }, 'syn-sent', randomInt(0, 0x10000));
    const syn: OutPacket = { seq: s.seqNr, type: ST_SYN, payload: Buffer.alloc(0), size: HEADER_SIZE, sentAt: 0, transmissions: 0, needResend: false, fastResentAt: 0 };
    s.seqNr = (s.seqNr + 1) & 0xffff;
    s.inflight.push(syn);
    s.transmit(syn);
    return s;
  }

  /** Receiver side, created from an incoming SYN. Answers with STATE. */
  static accept(init: Omit<UtpSocketInit, 'recvId' | 'sendId'>, syn: UtpPacket): UtpSocket {
    const s = new UtpSocket(
      { ...init, recvId: (syn.connectionId + 1) & 0xffff, sendId: syn.connectionId },
      'syn-recv',
      randomInt(0, 0x10000),
    );
    s.ackNr = syn.seq;
    s.peerWnd = syn.wndSize;
    s.replyMicro = (microNow() - syn.timestamp) >>> 0;
    s.sendState();
    return s;
  }

  get remoteFamily(): 'IPv4' | 'IPv6' {
    return this.remoteAddress.includes(':') ? 'IPv6' : 'IPv4';
  }

  get rttMs(): number {
    return this.rtt;
  }

  get inFlightBytes(): number {
    return this.curWindow;
  }

  /** Internal state snapshot for diagnostics. */
  debugState(): Record<string, unknown> {
    return {
      state: this.state,
      seqNr: this.seqNr,
      ackNr: this.ackNr,
      inflight: this.inflight.map((p) => `${p.seq}${p.needResend ? '*' : ''}x${p.transmissions}`).slice(0, 10),
      inflightCount: this.inflight.length,
      curWindow: this.curWindow,
      maxWindow: this.maxWindow,
      peerWnd: this.peerWnd,
      sendBufBytes: this.sendBufBytes,
      ooo: [...this.ooo.keys()].slice(0, 10),
      rto: this.rto,
      rtt: this.rtt,
      delayUs: this.lastDelayUs,
      lossCuts: this.lossCuts,
      rttVar: this.rttVar,
      timeouts: this.timeouts,
      readableLength: this.readableLength,
      counters: this.counters,
    };
  }

  // ---- outgoing ----------------------------------------------------------------------------

  private recvWindowFree(): number {
    return Math.max(0, RECV_WINDOW - this.readableLength - this.oooBytes);
  }

  private raw(type: number, seq: number, payload: Buffer, sack?: Buffer): void {
    const wnd = this.recvWindowFree();
    this.lastWndSent = wnd;
    this.unackedRecv = 0;
    this.lastSendAt = this.now();
    const p: UtpPacket = {
      type,
      connectionId: type === ST_SYN ? this.recvId : this.sendId,
      timestamp: microNow(),
      timestampDiff: this.replyMicro,
      wndSize: wnd,
      seq,
      ack: this.ackNr,
      payload,
    };
    if (sack) p.sack = sack;
    this.counters.sent++;
    this.sendPacket(p);
  }

  private transmit(pk: OutPacket): void {
    if (pk.transmissions > 0) this.counters.resent++;
    pk.sentAt = this.now();
    pk.transmissions++;
    if (pk.needResend || pk.transmissions === 1) this.curWindow += pk.size;
    pk.needResend = false;
    this.raw(pk.type, pk.seq, pk.payload);
  }

  private windowAllows(size: number): boolean {
    return this.curWindow === 0 || this.curWindow + size <= Math.min(this.maxWindow, Math.max(this.peerWnd, 0));
  }

  private sackMask(): Buffer | undefined {
    if (this.ooo.size === 0) return undefined;
    let maxOff = 0;
    for (const seq of this.ooo.keys()) maxOff = Math.max(maxOff, seqDiff(seq, (this.ackNr + 2) & 0xffff));
    const bytes = Math.min(128, Math.ceil((maxOff + 1) / 32) * 4);
    const mask = Buffer.alloc(bytes);
    for (const seq of this.ooo.keys()) {
      const off = seqDiff(seq, (this.ackNr + 2) & 0xffff);
      if (off < bytes * 8) mask[off >> 3] = (mask[off >> 3] as number) | (1 << (off & 7));
    }
    return mask;
  }

  private sendState(): void {
    this.ackScheduled = false;
    if (this.state === 'closed' || this.state === 'syn-sent') return;
    this.raw(ST_STATE, this.seqNr, Buffer.alloc(0), this.sackMask());
  }

  private scheduleAck(): void {
    if (this.ackScheduled) return;
    this.ackScheduled = true;
    setImmediate(() => {
      if (this.ackScheduled) this.sendState();
    });
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.trySend();
    });
  }

  private takeSendBytes(n: number): Buffer {
    const parts: Buffer[] = [];
    let need = n;
    while (need > 0 && this.sendBuf.length > 0) {
      const head = this.sendBuf[0] as Buffer;
      if (head.length <= need) {
        parts.push(head);
        this.sendBuf.shift();
        need -= head.length;
      } else {
        parts.push(head.subarray(0, need));
        this.sendBuf[0] = head.subarray(need);
        need = 0;
      }
    }
    this.sendBufBytes -= n - need;
    return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
  }

  private trySend(): void {
    if (this.state !== 'connected') return;
    for (const pk of this.inflight) {
      if (!pk.needResend) continue;
      if (!this.windowAllows(pk.size)) return;
      this.transmit(pk);
    }
    while (this.sendBufBytes > 0 && this.inflight.length < 0x4000) {
      const size = Math.min(MAX_PAYLOAD, this.sendBufBytes);
      if (!this.windowAllows(size + HEADER_SIZE)) break;
      const payload = this.takeSendBytes(size);
      const pk: OutPacket = { seq: this.seqNr, type: ST_DATA, payload, size: payload.length + HEADER_SIZE, sentAt: 0, transmissions: 0, needResend: false, fastResentAt: 0 };
      this.seqNr = (this.seqNr + 1) & 0xffff;
      this.inflight.push(pk);
      this.transmit(pk);
    }
    if (this.writeCb && this.sendBufBytes < WRITE_HIGH_WATER) {
      const cb = this.writeCb;
      this.writeCb = null;
      cb();
    }
    if (this.finPending && !this.finSent && this.sendBufBytes === 0) {
      this.finSent = true;
      this.finSeq = this.seqNr;
      const pk: OutPacket = { seq: this.seqNr, type: ST_FIN, payload: Buffer.alloc(0), size: HEADER_SIZE, sentAt: 0, transmissions: 0, needResend: false, fastResentAt: 0 };
      this.seqNr = (this.seqNr + 1) & 0xffff;
      this.inflight.push(pk);
      this.transmit(pk);
    }
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.state === 'closed') {
      cb(new TorrentEngineError('peer', 'utp socket closed'));
      return;
    }
    this.sendBuf.push(chunk);
    this.sendBufBytes += chunk.length;
    this.scheduleFlush();
    if (this.sendBufBytes < WRITE_HIGH_WATER) cb();
    else this.writeCb = cb;
  }

  override _final(cb: (err?: Error | null) => void): void {
    if (this.state === 'closed') {
      cb();
      return;
    }
    this.finPending = true;
    this.finalCb = cb;
    this.scheduleFlush();
  }

  override _read(): void {
    if (this.state === 'connected' && this.lastWndSent < RECV_WINDOW / 2 && this.recvWindowFree() > this.lastWndSent) this.scheduleAck();
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    if (this.state === 'connected' && !this.finSent) this.raw(ST_FIN, this.seqNr, Buffer.alloc(0));
    this.state = 'closed';
    this.inflight.length = 0;
    this.sendBuf = [];
    this.ooo.clear();
    const fcb = this.finalCb;
    this.finalCb = null;
    fcb?.();
    this.onCloseCb(this);
    cb(err);
  }

  // ---- incoming ----------------------------------------------------------------------------

  /** Feeds a packet addressed to this connection. */
  onPacket(p: UtpPacket): void {
    if (this.state === 'closed') return;
    this.counters.received++;
    if (p.type === ST_RESET) {
      this.destroy(Object.assign(new TorrentEngineError('peer', 'utp connection reset by peer'), { errno: 'ECONNRESET' }));
      return;
    }
    this.replyMicro = (microNow() - p.timestamp) >>> 0;
    if (p.type === ST_SYN) {
      // our STATE was lost: answer the retransmitted SYN again
      if (p.seq === this.ackNr) this.sendState();
      return;
    }
    this.peerWnd = p.wndSize;
    if (this.state === 'syn-sent') {
      if (p.type !== ST_STATE) return; // the receiver sends nothing else before our first packet
      this.ackNr = (p.seq - 1) & 0xffff;
      this.state = 'connected';
      this.timeouts = 0;
      // tell the receiver we are connected even if we have nothing to send yet
      this.scheduleAck();
      this.emit('connect');
    } else if (this.state === 'syn-recv') {
      this.state = 'connected';
    }
    this.onAck(p);
    if (p.type === ST_DATA || p.type === ST_FIN) this.onData(p);
    if ((this.state as string) === 'closed') return;
    this.trySend();
    this.maybeClose();
  }

  private onData(p: UtpPacket): void {
    const expected = (this.ackNr + 1) & 0xffff;
    const d = seqDiff(p.seq, expected);
    if (d >= 0x8000) {
      this.scheduleAck(); // duplicate of something already delivered
      return;
    }
    if (this.readEnded) return;
    if (d === 0) {
      this.deliver(p.seq, p.type, p.payload);
      for (;;) {
        const next = (this.ackNr + 1) & 0xffff;
        const q = this.ooo.get(next);
        if (!q || this.readEnded) break;
        this.ooo.delete(next);
        this.oooBytes -= q.payload.length;
        this.deliver(next, q.type, q.payload);
      }
    } else if (d < MAX_OUT_OF_ORDER && !this.ooo.has(p.seq)) {
      this.ooo.set(p.seq, { type: p.type, payload: Buffer.from(p.payload) });
      this.oooBytes += p.payload.length;
    }
    // ack every second packet at once, out-of-order arrivals immediately (for fast retransmit)
    if (++this.unackedRecv >= 2 || this.ooo.size > 0) this.sendState();
    else this.scheduleAck();
  }

  private deliver(seq: number, type: number, payload: Buffer): void {
    this.ackNr = seq;
    if (type === ST_FIN) {
      this.eofSeq = seq;
      this.readEnded = true;
      this.ooo.clear();
      this.oooBytes = 0;
      this.push(null);
      return;
    }
    if (payload.length > 0) this.push(Buffer.from(payload));
  }

  private onAck(p: UtpPacket): void {
    const ack = p.ack;
    const now = this.now();
    // Early retransmit (as in RFC 5827): with few packets in flight there can never be three
    // later packets to signal a loss, so lower the threshold accordingly.
    const lossThreshold = Math.max(1, Math.min(3, this.inflight.length - 1));
    let acked = 0;
    let sample = -1;
    const take = (pk: OutPacket): void => {
      acked += pk.size;
      if (!pk.needResend) this.curWindow -= pk.size;
      // Karn: never sample retransmitted packets; and use the freshest packet acked, since
      // older ones may have waited behind a hole
      // (or behind a timeout) and would inflate the estimate
      const fresh = pk.transmissions === 1 && !pk.needResend && pk.sentAt > this.lastTimeoutAt;
      if (fresh && (sample < 0 || now - pk.sentAt < sample)) sample = now - pk.sentAt;
    };
    while (this.inflight.length > 0) {
      const pk = this.inflight[0] as OutPacket;
      if (seqAfter(pk.seq, ack)) break;
      this.inflight.shift();
      take(pk);
    }
    if (p.sack && this.inflight.length > 0) {
      // offsets (relative to ack) of every selectively acknowledged packet, ascending
      const offsets: number[] = [];
      for (let j = 0; j < p.sack.length; j++) {
        const byte = p.sack[j] as number;
        for (let k = 0; k < 8; k++) if (byte & (1 << k)) offsets.push(2 + j * 8 + k);
      }
      const sacked = new Set(offsets.map((o) => (ack + o) & 0xffff));
      for (let i = this.inflight.length - 1; i >= 0; i--) {
        const pk = this.inflight[i] as OutPacket;
        if (sacked.has(pk.seq)) {
          this.inflight.splice(i, 1);
          take(pk);
          continue;
        }
        // lost when enough packets sent after it were received (whether or not we had
        // already removed them on an earlier ACK)
        const off = seqDiff(pk.seq, ack);
        let later = 0;
        for (let x = offsets.length - 1; x >= 0 && (offsets[x] as number) > off; x--) later++;
        if (later >= lossThreshold && !pk.needResend && now - pk.fastResentAt > Math.max(this.rtt * 2, 20)) {
          pk.fastResentAt = now;
          this.lossEvent(now);
          this.resendNow(pk);
        }
      }
    }
    if (this.curWindow < 0) this.curWindow = 0;
    if (acked > 0) {
      this.dupAcks = 0;
      this.timeouts = 0;
      if (sample >= 0) this.updateRtt(sample);
      // new data got through: drop any timeout back-off
      else if (this.hasRtt) this.rto = Math.max(this.minRto, this.rtt + 4 * this.rttVar);
      this.ledbat(acked, p.timestampDiff);
    } else if (p.type === ST_STATE && ack === this.lastAck && this.inflight.length > 0) {
      this.dupAcks++;
      const first = this.inflight[0] as OutPacket;
      if (this.dupAcks === lossThreshold && first.seq === ((ack + 1) & 0xffff) && !first.needResend) {
        first.fastResentAt = now;
        this.lossEvent(now);
        this.resendNow(first);
      }
    }
    this.lastAck = ack;
    if (this.finSent && this.finalCb && !this.inflight.some((pk) => pk.seq === this.finSeq)) {
      const cb = this.finalCb;
      this.finalCb = null;
      cb();
    }
  }

  private resendNow(pk: OutPacket): void {
    this.counters.resent++;
    pk.sentAt = this.now();
    pk.transmissions++;
    this.raw(pk.type, pk.seq, pk.payload);
  }

  private lossEvent(now: number): void {
    if (now - this.lastLossCut < Math.max(this.rtt, 20)) return;
    this.lastLossCut = now;
    this.lossCuts++;
    this.maxWindow = Math.max(MIN_WINDOW, this.maxWindow / 2);
  }

  private updateRtt(sample: number): void {
    if (!this.hasRtt) {
      this.hasRtt = true;
      this.rtt = sample;
      this.rttVar = sample / 2;
    } else {
      this.rttVar += (Math.abs(this.rtt - sample) - this.rttVar) / 4;
      this.rtt += (sample - this.rtt) / 8;
    }
    this.rto = Math.max(this.minRto, this.rtt + 4 * this.rttVar);
  }

  /** LEDBAT: grow or shrink the window by how far the measured queuing delay is from target. */
  private ledbat(bytesAcked: number, theirDelay: number): void {
    if (theirDelay === 0) return;
    const now = this.now();
    if (this.baseHist.length === 0 || now - this.baseHistAt >= 60_000) {
      this.baseHist.push(theirDelay);
      if (this.baseHist.length > 3) this.baseHist.shift();
      this.baseHistAt = now;
    } else if (u32Less(theirDelay, this.baseHist[this.baseHist.length - 1] as number)) {
      this.baseHist[this.baseHist.length - 1] = theirDelay;
    }
    let base = this.baseHist[0] as number;
    for (const b of this.baseHist) if (u32Less(b, base)) base = b;
    const ourDelay = Math.max(0, (theirDelay - base) | 0);
    this.lastDelayUs = ourDelay;
    const offTarget = this.targetDelay - ourDelay;
    const delayFactor = offTarget / this.targetDelay;
    const windowFactor = bytesAcked / Math.max(this.maxWindow, bytesAcked);
    const gain = MAX_CWND_INCREASE_BYTES_PER_RTT * delayFactor * windowFactor;
    this.maxWindow = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, this.maxWindow + gain));
  }

  private maybeClose(): void {
    if (this.readEnded && this.finSent && !this.inflight.some((pk) => pk.seq === this.finSeq)) this.destroy();
  }

  /** Retransmission timer and keep-alive; called by the manager every few tens of ms. */
  tick(): void {
    if (this.state === 'closed') return;
    const now = this.now();
    const first = this.inflight.find((pk) => !pk.needResend);
    if (first && now - first.sentAt > this.rto) {
      this.timeouts++;
      this.counters.timeouts++;
      this.lastTimeoutAt = now;
      if ((this.state === 'syn-sent' && first.transmissions >= SYN_ATTEMPTS) || this.timeouts > MAX_TIMEOUTS) {
        this.destroy(Object.assign(new TorrentEngineError('timeout', 'utp connection timed out'), { errno: 'ETIMEDOUT' }));
        return;
      }
      this.rto = Math.min(this.rto * 2, 60_000);
      this.maxWindow = MIN_WINDOW;
      // Resend only the oldest packet: usually an ACK was lost and its answer acknowledges
      // everything; real holes are then found by duplicate/selective ACKs.
      first.needResend = true;
      this.curWindow = Math.max(0, this.curWindow - first.size);
      this.transmit(first);
      return;
    }
    if (this.state === 'connected' && now - this.lastSendAt > KEEPALIVE_MS) this.sendState();
  }
}
