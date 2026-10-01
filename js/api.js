/**
 * eRapor DAFI — lapisan akses API (GitHub Pages → Apps Script JSON API).
 *
 * Kunci desain (lihat docs-development/tahap-0.md & API.md):
 *  - POST dengan Content-Type text/plain → CORS-safelisted, TIDAK memicu preflight.
 *  - Token dikirim di body envelope, BUKAN header Authorization (juga agar tidak
 *    memicu preflight). Header Authorization sudah terbukti diblokir di uji Tahap 0.
 *  - Loader SELALU dibersihkan lewat try/finally — inilah penyebab "spinner macet
 *    selamanya" pada versi lama (19 panggilan, hanya 2 punya failure handler).
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Konfigurasi endpoint.
  // Ganti nilai di bawah setelah deployment (lihat DEPLOYMENT.md).
  //   ''            → gunakan endpoint konfigurasi (window.ERAPOR_API_URL)
  //   'direct'      → panggil Apps Script /exec langsung (syarat: gerbang CORS lolos)
  //   <url worker>  → lewat Cloudflare Worker proxy (jika CORS gagal)
  //
  // Definisi di window.ERAPOR_API_URL memudahkan mengganti endpoint tanpa
  // mengedit source (mis. ditanam oleh GitHub Actions).
  // ---------------------------------------------------------------------------
  var CONFIG = {
    apiUrl: global.ERAPOR_API_URL || 'https://script.google.com/macros/s/AKfycbw1NcpBeehBXcV-e0UGGbo8wj11Le3PDcVrNVJkERSTtlL6ShDGtAVbm88NR_-lUCFWuQ/exec',
    mode: 'direct' // 'direct' | 'proxy'
  };

  var TOKEN_KEY = 'rToken';   // token sesi — display convenience saja, bukan otoritas
  var USER_KEY = 'rUser';     // cache identity untuk render awal (divalidasi ulang server)

  var session = {
    token: global.localStorage.getItem(TOKEN_KEY) || '',
    user: null
  };
  try {
    var cached = global.localStorage.getItem(USER_KEY);
    session.user = cached ? JSON.parse(cached) : null;
  } catch (_) { session.user = null; }

  // ---------------------------------------------------------------- utilities
  function endpoint() {
    if (CONFIG.apiUrl) return CONFIG.apiUrl;
    throw new Error('Endpoint API belum dikonfigurasi. Setel window.ERAPOR_API_URL (lihat DEPLOYMENT.md).');
  }

  function setSession(token, user) {
    session.token = token || '';
    session.user = user || null;
    if (token) global.localStorage.setItem(TOKEN_KEY, token);
    else global.localStorage.removeItem(TOKEN_KEY);
    if (user) global.localStorage.setItem(USER_KEY, JSON.stringify(user));
    else global.localStorage.removeItem(USER_KEY);
  }

  function clearSession() { setSession('', null); }

  function isAuthenticated() { return !!session.token; }

  /** Escape teks dari server sebelum masuk innerHTML — data sheet tidak dipercaya. */
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // --------------------------------------------------------------- UI helpers
  var spinCount = 0;
  function spin(on) {
    spinCount = Math.max(0, spinCount + (on ? 1 : -1));
    var el = document.getElementById('loader');
    if (el) el.style.display = spinCount > 0 ? 'block' : 'none';
  }

  var AUTH_ERROR_CODES = ['AUTH_REQUIRED', 'AUTH_EXPIRED'];

  /**
   * Satu-satunya jalan untuk memanggil backend.
   *
   * @param {string} action  nama aksi pada allowlist server
   * @param {object} payload payload aksi
   * @param {object} [opts]  { auth:true, silent:false, timeout:ms }
   * @returns {Promise<*>}   data envelope
   * @throws {Error}         dengan properti .code (kode API) dan .message (Bahasa)
   */
  function api(action, payload, opts) {
    opts = opts || {};
    var auth = opts.auth !== false;

    var body = { action: action, payload: payload || {} };
    if (auth) {
      if (!session.token) {
        return Promise.reject(makeError('AUTH_REQUIRED', 'Sesi tidak valid. Silakan masuk kembali.'));
      }
      body.token = session.token;
    }

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeout = setTimeout(function () { if (controller) controller.abort(); }, opts.timeout || 60000);

    spin(true);
    return fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    })
      .then(function (res) {
        // ContentService me-redirect; browser mengikuti otomatis (redirect:'follow'
        // adalah default). Baca sebagai teks dulu agar JSON rusak terdeteksi jelas.
        return res.text().then(function (text) {
          if (!res.ok && !text) throw makeError('HTTP_' + res.status, 'Server merespons ' + res.status + '.');
          var parsed;
          try { parsed = JSON.parse(text); }
          catch (_) { throw makeError('BAD_RESPONSE', 'Respons server bukan JSON yang valid.'); }
          if (parsed && parsed.ok === false && parsed.error) {
            throw makeError(parsed.error.code || 'UNKNOWN', parsed.error.message || 'Permintaan gagal.');
          }
          return parsed ? parsed.data : null;
        });
      })
      .catch(function (err) {
        if (err && err.isApiError) {
          // Sesi kedaluwarsa/terhapus di server → lepaskan sesi lokal sekarang juga,
          // bukan setelah pemanggil menangkap (UI tak boleh tetap terlihat login).
          handleAuthError(err);
          throw err;
        }
        if (err && err.name === 'AbortError') throw makeError('TIMEOUT', 'Permintaan melebihi batas waktu. Periksa koneksi.');
        throw makeError('NETWORK', 'Tidak dapat terhubung ke server. Periksa koneksi internet.');
      })
      .finally(function () {
        clearTimeout(timeout);
        spin(false);
      });
  }

  function makeError(code, message) {
    var e = new Error(message);
    e.code = code;
    e.isApiError = true;
    return e;
  }

  /**
   * Wrapper dengan penanganan konsisten untuk hampir semua kasus UI:
   *   - spinner & tombol selalu dipulihkan (finally)
   *   - error auth → kembali ke login
   *   - pesan gagal ditampilkan di elemen status (aria-live), bukan alert()
   * @returns {Promise<boolean>} true bila sukses
   */
  function call(action, payload, opts) {
    opts = opts || {};
    var buttons = opts.buttons ? opts.buttons.filter(Boolean) : [];
    buttons.forEach(function (b) { b.disabled = true; b.dataset.busy = '1'; });

    return api(action, payload, opts)
      .then(function (data) {
        if (opts.onSuccess) opts.onSuccess(data);
        return data;
      })
      .catch(function (err) {
        handleAuthError(err);
        if (opts.statusId) setStatus(opts.statusId, err.message, false);
        else if (!opts.silent) setStatus(null, err.message, false);
        return null;
      })
      .finally(function () {
        buttons.forEach(function (b) { b.disabled = false; delete b.dataset.busy; });
      });
  }

  function handleAuthError(err) {
    if (err && AUTH_ERROR_CODES.indexOf(err.code) >= 0 && session.token) {
      clearSession();
      if (global.onSessionExpired) global.onSessionExpired(err);
    }
  }

  /** Pesan status inline (role=status → dibacakan screen reader). */
  function setStatus(id, text, ok) {
    var el = id ? document.getElementById(id) : document.getElementById('global-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = (el.dataset.baseClass || 'text-sm font-bold') +
      ' ' + (text ? (ok ? 'text-green-700' : 'text-red-600') : '');
    if (text) setTimeout(function () { if (el.textContent === text) el.textContent = ''; }, 6000);
  }

  // ---------------------------------------------------------------- exports
  global.ERAPOR = {
    api: api,
    call: call,
    esc: esc,
    spin: spin,
    setStatus: setStatus,
    setSession: setSession,
    clearSession: clearSession,
    isAuthenticated: isAuthenticated,
    getToken: function () { return session.token; },
    getUser: function () { return session.user; },
    makeError: makeError,
    config: CONFIG,
    handleAuthError: handleAuthError
  };
})(window);
