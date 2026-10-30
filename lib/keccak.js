/**
 * Wheelcast - keccak-256, used to derive event topics from published ABI
 * signatures.
 *
 * Deliberately duplicated rather than shared with verify.mjs: that script is
 * meant to stand alone, so a bug here cannot hide itself there. The two
 * implementations are cross-checked in tests/keccak.test.mjs.
 */

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const MASK = (1n << 64n) - 1n;

function rotl(x, n) {
  if (n === 0) return x & MASK;
  const s = BigInt(n);
  return ((x << s) | (x >> (64n - s))) & MASK;
}

function keccakF(state) {
  for (let round = 0; round < 24; round++) {
    const c = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) {
      c[x] = state[x][0] ^ state[x][1] ^ state[x][2] ^ state[x][3] ^ state[x][4];
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) state[x][y] ^= d;
    }
    const b = [[0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n]];
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y][(2 * x + 3 * y) % 5] = rotl(state[x][y], ROT[x][y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & MASK & b[(x + 2) % 5][y]);
      }
    }
    state[0][0] ^= RC[round];
  }
}

const RATE = 136; // 1088 bits

/** keccak-256 over a byte array. Returns 32 bytes. */
export function keccak256(bytes) {
  const state = Array.from({ length: 5 }, () => [0n, 0n, 0n, 0n, 0n]);
  const padded = new Uint8Array(Math.floor(bytes.length / RATE) * RATE + RATE);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) {
        lane = (lane << 8n) | BigInt(padded[offset + i * 8 + j]);
      }
      const x = i % 5;
      const y = Math.floor(i / 5);
      state[x][y] ^= lane;
    }
    keccakF(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i % 5][Math.floor(i / 5)];
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

const toHex = (bytes) => "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Topic0 of an event signature, e.g. topicOf("Transfer(address,address,uint256)"). */
export function topicOf(signature) {
  return toHex(keccak256(new TextEncoder().encode(signature)));
}

/** Canonical signature string for an ABI event entry. */
export function eventSignature(entry) {
  return entry.name + "(" + entry.inputs.map((i) => i.type).join(",") + ")";
}
