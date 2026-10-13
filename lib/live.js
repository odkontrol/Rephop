/*
 * RepHop live group hauls: the part that talks to a relay.
 *
 * A relay passes updates between the browsers in a haul. It is never trusted with what is in them:
 * everything that leaves this browser is encrypted here, with a key that only travels inside the
 * invite the host hands to their friends. The relay sees a room id, who is in it, and when something
 * changed. See the relay's own source for its side of this.
 *
 * Works in the background worker, in the list page and in Node (the tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'));
  else root.RepLive = factory(root.RepUtil);
})(typeof self !== 'undefined' ? self : this, function (U) {
  'use strict';

  const ROOM = /^[A-Za-z0-9_-]{16,64}$/;
  const KEY = /^[A-Za-z0-9_-]{43}$/; // 32 bytes
  const MAX_PLAIN = 1500000;

  const utf8 = new TextEncoder();

  /** n random bytes as letters and digits. */
  function rand(n) {
    return U.toB64(crypto.getRandomValues(new Uint8Array(n)));
  }

  async function sha256(text) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(String(text))));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * A relay's address, tidied: https only (plain http is accepted for this computer alone, which is
   * what the tests use). Returns '' for anything else.
   */
  function relayUrl(text) {
    let u;
    try {
      u = new URL(String(text || '').trim());
    } catch (_) {
      return '';
    }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) return '';
    if (u.username || u.password || u.search || u.hash) return '';
    return u.origin + u.pathname.replace(/\/+$/, '');
  }

  // ---------------------------------------------------------------- invites

  /** The line of text a host sends to their friends. It holds where the haul is and the key to read it. */
  function makeInvite(live) {
    const body = { u: live.relay, r: live.room, k: live.key, n: String(live.name || '').slice(0, 30) };
    return 'RHL1.' + U.toB64(utf8.encode(JSON.stringify(body)));
  }

  /** Read an invite out of whatever was pasted. Returns { relay, room, key, name } or null. */
  function readInvite(text) {
    const m = String(text || '').match(/RHL1\.([A-Za-z0-9_-]{40,2000})/);
    if (!m) return null;
    try {
      const o = JSON.parse(new TextDecoder().decode(U.fromB64(m[1])));
      const relay = relayUrl(o.u);
      if (!relay || !ROOM.test(o.r || '') || !KEY.test(o.k || '')) return null;
      return { relay, room: o.r, key: o.k, name: typeof o.n === 'string' ? o.n.replace(/\s+/g, ' ').trim().slice(0, 30) : '' };
    } catch (_) {
      return null;
    }
  }

  // ------------------------------------------------------------- encryption

  const keys = new Map();

  function keyOf(k) {
    if (!keys.has(k)) keys.set(k, crypto.subtle.importKey('raw', U.fromB64(k), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
    return keys.get(k);
  }

  /**
   * Encrypt an object for the haul. `about` says what the blob is and whose ("room|member|list"); it is
   * bound into the encryption, so a blob moved to another slot or another member does not open.
   */
  async function seal(k, about, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = await U.pipeBytes(utf8.encode(JSON.stringify(obj)), new CompressionStream('deflate'), MAX_PLAIN);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(about) }, await keyOf(k), plain));
    return 'v1.' + U.toB64(iv) + '.' + U.toB64(sealed);
  }

  /** The other direction. Returns the object, or null when the blob is not ours, was altered, or is too big. */
  async function open(k, about, blob) {
    try {
      const parts = String(blob || '').split('.');
      if (parts.length !== 3 || parts[0] !== 'v1' || parts[2].length > 400000) return null;
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: U.fromB64(parts[1]), additionalData: utf8.encode(about) }, await keyOf(k), U.fromB64(parts[2])));
      const bytes = await U.pipeBytes(plain, new DecompressionStream('deflate'), MAX_PLAIN);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) {
      return null;
    }
  }

  const about = (live, member, what) => live.room + '|' + member + '|' + what;

  // ------------------------------------------------------------- the relay

  /** Who this browser is in the haul: the host, or a member with an id. */
  function who(live) {
    return live.role === 'host' ? 'host' : live.mid;
  }

  /** One request to the relay. Resolves to { http, ok, … } and never throws. */
  async function call(live, action, opts) {
    const o = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (o.auth !== false) headers.Authorization = 'Bearer ' + who(live) + '.' + live.secret;
    try {
      const res = await fetch(live.relay + '/r/' + live.room + '/' + action, {
        method: o.method || 'POST', headers, body: o.body ? JSON.stringify(o.body) : undefined, cache: 'no-store',
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_) {
        /* not JSON: an error page */
      }
      return Object.assign({}, data, { http: res.status, ok: res.ok && data.ok !== false });
    } catch (_) {
      return { http: 0, ok: false, error: 'offline' };
    }
  }

  /** What a WebSocket to the relay needs. (A browser cannot put headers on one, so the two values ride as sub-protocols.) */
  function socket(live) {
    return { url: live.relay.replace(/^http/, 'ws') + '/r/' + live.room + '/ws', protocols: ['rh1', who(live), live.secret] };
  }

  return { rand, sha256, relayUrl, makeInvite, readInvite, seal, open, about, who, call, socket };
});
