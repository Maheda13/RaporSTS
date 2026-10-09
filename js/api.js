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
    apiUrl: global.ERAPOR_API_URL || 'https://script.google.com/macros/s/AKfycbzJXEXyL0WRf6VHrtn3C0561i5DxYia91Syp6Qx1SdFhha89Tx-O2pBi3YCJfJPRt3tCQ/exec',
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

  // ---------------------------------------------------------------- read cache
  // Tahap 11: cache baca jangka pendek agar berpindah tab tidak selalu minta
  // data lagi (prefetchRole() mengisinya sesaat setelah shell tampil).
  //
  // ATURAN (sengaja selektif):
  //  - HANYA READ_CACHE_ACTIONS yang boleh di-cache: monitor/metadata murni baca.
  //  - Nilai & absensi TIDAK pernah: angka basi di form input lebih berbahaya
  //    daripada menunggu (user bisa mengedit data yang sudah berubah).
  //  - sessionStorage, BUKAN localStorage: hilang saat tab ditutup, jadi data
  //    tidak tertinggal di komputer bersama; token pun tidak ikut disimpan.
  //  - TTL pendek (60 dtk).
  var READ_CACHE_ACTIONS = [
    'getUploadStatus',       // Status Nilai (per role)
    'getProgressSummary',    // rekap progres Admin/Waka
    'getCapaianTracking',    // tracking Capaian periode aktif Admin/Waka
    'getMonitoringData',     // leger Admin/Waka
    'getAssignmentList'      // metadata akun & penugasan — 1 baca untuk 2 halaman
  ];
  // Seluruh aksi BACA di routeRequest_ (mirror code.gs — bukan prefiks `get*`,
  // supaya aksi tulis yang namanya tak biasa tetap terbaca sebagai tulis).
  //
  // Invalidasi: aksi DI LUAR daftar ini (semua tulis, dan aksi tak dikenal)
  // membuang seluruh cache. Arah gagal ini sengaja aman: aksi tulis baru yang
  // kelak lupa dicatat di sini justru merusak cache (refetch) — bukan
  // menyajikan data basi. Sebaliknya aksi baca baru yang lupa dicatat hanya
  // membuat prefetch tidak terpakai; tetap tidak berbahaya.
  var READ_ACTIONS = [
    'validateSession', 'getInitialData', 'getDashboardStats', 'getCapaian',
    'getDataNilaiInput', 'getAbsensiSiswa', 'getSiswaByKelas', 'getUploadStatus',
    'getRaportData', 'getMonitoringData', 'getArchiveNilai', 'getMyWorkbench',
    'getNilaiEkstra', 'getProgressSummary', 'getCapaianTracking', 'getSiswaList', 'getAssignmentList'
  ];
  var READ_CACHE_TTL_ = 60000;
  var READ_CACHE_NS_ = 'rCache.1.';
  var inflight_ = Object.create(null);

  /** sessionStorage bisa melempar (private mode / quota) → nonaktifkan cache saja. */
  function cacheStore_() {
    try { return global.sessionStorage || null; } catch (_) { return null; }
  }
  function cacheKey_(action, payload) {
    var role = (session.user && session.user.role) || '';
    var p = payload || {};
    var q = Object.keys(p).sort().map(function (k) { return k + '=' + String(p[k]); }).join('&');
    return READ_CACHE_NS_ + session.token + '.' + role + '.' + action + '.' + q;
  }
  function cacheGet_(key) {
    var st = cacheStore_(); if (!st) return undefined;
    try {
      var raw = st.getItem(key); if (raw === null) return undefined;
      var o = JSON.parse(raw);
      if (!o || typeof o.t !== 'number' || Date.now() - o.t > READ_CACHE_TTL_) { st.removeItem(key); return undefined; }
      return o.v;
    } catch (_) { return undefined; }
  }
  function cachePut_(key, value) {
    var st = cacheStore_(); if (!st) return;
    try { st.setItem(key, JSON.stringify({ v: value, t: Date.now() })); } catch (_) { /* quota */ }
  }
  function clearReadCache_() {
    var st = cacheStore_(); if (!st) return;
    try {
      var drop = [];
      for (var i = 0; i < st.length; i++) { var k = st.key(i); if (k && k.indexOf(READ_CACHE_NS_) === 0) drop.push(k); }
      drop.forEach(function (k) { st.removeItem(k); });
    } catch (_) { /* abaikan */ }
  }

  // ---------------------------------------------------------------- utilities
  function endpoint() {
    if (CONFIG.apiUrl) return CONFIG.apiUrl;
    throw new Error('Endpoint API belum dikonfigurasi. Setel window.ERAPOR_API_URL (lihat DEPLOYMENT.md).');
  }

  function setSession(token, user) {
    var nextToken = token || '';
    var nextUser = user || null;
    // Pergantian login/role harus melepas snapshot sesi sebelumnya dari tab.
    if (session.token !== nextToken || JSON.stringify(session.user) !== JSON.stringify(nextUser)) clearReadCache_();
    session.token = nextToken;
    session.user = nextUser;
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
    var isRead = auth && READ_CACHE_ACTIONS.indexOf(action) >= 0 && opts.cache !== false;
    var cacheKey = isRead ? cacheKey_(action, payload) : null;

    var body = { action: action, payload: payload || {} };
    if (auth) {
      if (!session.token) {
        return Promise.reject(makeError('AUTH_REQUIRED', 'Sesi tidak valid. Silakan masuk kembali.'));
      }
      body.token = session.token;
    }

    // Invalidasi: aksi DI LUAR READ_ACTIONS (semua tulis + aksi tak dikenal)
    // membuang seluruh cache → data basi tidak pernah terpakai. Baca biasa
    // (mis. getDataNilaiInput saat membuka Input) TIDAK menghapus cache:
    // baca tidak memutasi data, jadi prefetch tetap berguna.
    // Dilakukan SETELAH auth lolos agar request gagal tak menghapus cache benar.
    if (READ_ACTIONS.indexOf(action) < 0) clearReadCache_();

    // Aksi terdaftar (baca murni) → pakai cache kalau masih hidup, atau gabung
    // request yang SEDANG berjalan (prefetch di latar belakang) supaya membuka
    // tab saat prefetch belum selesai tidak menghasilkan 2 request identik.
    if (cacheKey) {
      var hit = cacheGet_(cacheKey);
      if (hit !== undefined) return Promise.resolve(hit);
      if (inflight_[cacheKey]) return inflight_[cacheKey];
    }

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeout = setTimeout(function () { if (controller) controller.abort(); }, opts.timeout || 60000);

    // opts.silent: lewati spinner global. Dipakai request boot (layar progres
    // bertahap sudah memberi umpan balik) supaya overlay tidak berkedip dobel.
    var silent = !!opts.silent;
    if (!silent) spin(true);
    var req = fetch(endpoint(), {
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
          var result = parsed ? parsed.data : null;
          if (cacheKey) cachePut_(cacheKey, result);
          return result;
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
        if (!silent) spin(false);
        if (cacheKey) delete inflight_[cacheKey];
      });
    // Bergabung dengan request identik yang sedang berjalan (prefetch vs klik
    // tab hampir bersamaan). Di-registrasi setelah dibentuk supaya promise sudah
    // lengkap sebelum dipakai pemanggil lain.
    if (cacheKey) inflight_[cacheKey] = req;
    return req;
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
