(() => {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const { api, call, esc, spin, setStatus, setSession, clearSession, isAuthenticated } = window.ERAPOR;

  let DATA = {};
  let USER = null;
  let CURRENT_RAPOR_DATA = null;
  let gradeDirty = false;
  let pendingSave = false;
  let toastTimer = 0;
  let navSeq = 0;          // guard navigasi async: hasil lambat tak menimpa klik berikutnya
  let activeRaporTab = 'aktif';   // tab rapor yang sedang aktif ('aktif'|'arsip')

  const PERIOD_OPTIONS = [
    ['Ganjil', '2025/2026'], ['Genap', '2025/2026'],
    ['Ganjil', '2026/2027'], ['Genap', '2026/2027'],
    ['Ganjil', '2027/2028'], ['Genap', '2027/2028']
  ];

  // -------------------------------------------- consistency + safe rendering
  function toast(message, ok) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
      el.className = 'toast'; document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle('toast-error', !ok);
    el.classList.add('toast-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('toast-visible'), 4500);
  }

  // --------------------------------------------- Layar progres boot (Tahap 9)
  // Satu layar bertahap menemani pemanggilan data awal (validateSession saat
  // restore sesi, getInitialData, getDashboardStats), menggantikan berkedipnya
  // #loader global pada tiap request kecil.
  const BOOT_STEPS = ['session', 'initial', 'dashboard'];
  let bootRetry = null;   // callback "Coba lagi" terakhir

  function bootStart() {
    const view = $('#boot-view');
    if (!view) return;
    view.classList.remove('hidden');
    $('#login-view')?.classList.add('hidden');
    $('#reset-view')?.classList.add('hidden');
    $('#boot-error')?.classList.add('hidden');
    $('#boot-retry')?.classList.add('hidden');
    bootRetry = null;
    // Reset status semua langkah.
    BOOT_STEPS.forEach(k => {
      const step = document.querySelector('[data-boot-step="' + k + '"]');
      if (step) step.classList.remove('is-active', 'is-done', 'is-error');
    });
  }
  function bootStep(key, state) {
    const step = document.querySelector('[data-boot-step="' + key + '"]');
    if (!step) return;
    // Satu langkah aktif dalam satu waktu; keadaan sebelumnya ditutup sebagai selesai.
    BOOT_STEPS.forEach(k => {
      const el = document.querySelector('[data-boot-step="' + k + '"]');
      if (el && k !== key) el.classList.remove('is-active');
    });
    step.classList.toggle('is-active', state === 'active');
    step.classList.toggle('is-done', state === 'done');
    step.classList.toggle('is-error', state === 'error');
  }
  function bootDone() {
    $('#boot-view')?.classList.add('hidden');
    bootRetry = null;
  }
  /** Gagal di tengah boot: tampilkan pesan + Coba lagi (app-shell tidak pernah
   *  tampil setengah jadi). `retry` = fungsi untuk menjalankan ulang boot. */
  function bootFail(message, retry) {
    $('#boot-error').textContent = message;
    $('#boot-error').classList.remove('hidden');
    const btn = $('#boot-retry');
    btn.classList.remove('hidden');
    bootRetry = retry;
  }

  function setBusy(button, busy, text) {
    if (!button) return;
    button.disabled = !!busy;
    if (busy) {
      button.dataset.originalText = button.innerHTML;
      button.innerHTML = '<i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i> ' + esc(text || 'Memproses…');
      button.setAttribute('aria-busy', 'true');
    } else {
      if (button.dataset.originalText) button.innerHTML = button.dataset.originalText;
      delete button.dataset.originalText;
      button.removeAttribute('aria-busy');
    }
  }

  function safeMsg(id, text, ok) {
    const el = document.getElementById(id);
    if (!el) return;
    el.replaceChildren();
    if (!text) return;
    const span = document.createElement('span');
    span.className = (ok ? 'text-green-700 bg-green-50 border-green-200' : 'text-red-700 bg-red-50 border-red-200') + ' font-bold text-sm px-3 py-1.5 rounded border block text-center shadow-sm';
    span.textContent = text;
    el.appendChild(span);
    setTimeout(() => { if (span.parentNode === el) el.replaceChildren(); }, 5000);
  }

  /**
   * Konfirmasi inline menggantikan dialog native (Tahap 10) — dialog bawaan OS
   * memblokir thread & tampil beda tiap platform. Bar muncul di bawah layar dengan
   * `okLabel` khusus untuk aksi berisiko (mis. "Jalankan Promosi").
   * @returns {Promise<boolean>} true bila pengguna menekan tombol ya.
   */
  function confirmBar(text, okLabel) {
    return new Promise(resolve => {
      let el = $('#confirm-bar');
      if (!el) {
        el = document.createElement('div');
        el.id = 'confirm-bar';
        el.className = 'confirm-bar';
        document.body.appendChild(el);
      }
      el.replaceChildren();
      el.setAttribute('role', 'alertdialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', 'Konfirmasi');
      const msg = document.createElement('p'); msg.className = 'confirm-msg'; msg.textContent = text;
      const no = document.createElement('button');
      no.type = 'button'; no.className = 'btn-secondary'; no.textContent = 'Batal';
      const yes = document.createElement('button');
      yes.type = 'button'; yes.className = 'btn-primary'; yes.textContent = okLabel || 'Ya, lanjutkan';
      const row = document.createElement('div'); row.className = 'confirm-actions'; row.append(no, yes);
      el.append(msg, row);
      el.classList.remove('hidden');
      yes.focus();
      const done = ok => { el.classList.add('hidden'); document.removeEventListener('keydown', onKey); resolve(ok); };
      const onKey = e => { if (e.key === 'Escape') done(false); };
      yes.onclick = () => done(true);
      no.onclick = () => done(false);
      document.addEventListener('keydown', onKey);
    });
  }

  function setOptions(select, options, placeholder) {
    select.replaceChildren();
    if (placeholder !== false) {
      const option = document.createElement('option');
      option.value = ''; option.textContent = placeholder || '-Pilih-';
      select.appendChild(option);
    }
    options.forEach(item => {
      const option = document.createElement('option');
      if (Array.isArray(item)) { option.value = item[0]; option.textContent = item[1]; }
      else { option.value = item.value ?? item; option.textContent = item.label ?? item; }
      select.appendChild(option);
    });
  }

  function populatePeriodSelects() {
    ['n','a','e','s','r','m','sum'].forEach(prefix => {
      const sem = $('#' + prefix + '-sem');
      const year = $('#' + prefix + '-thn');
      if (sem) { setOptions(sem, ['Ganjil','Genap']); }
    if (year) { setOptions(year, [...new Set(PERIOD_OPTIONS.map(x => x[1]))]); }
    });
  }

  /**
   * Terapkan periode aktif (dari server) ke seluruh dropdown periode (Tahap 9).
   *  - Halaman INPUT (n nilai, a absen, e ekstra, r cetak, c capaian) → terkunci
   *    pada periode aktif: value terisi, disabled. Menulis ke periode lain
   *    ditolak server (PERIOD_ARCHIVED), jadi pilihan palsu hanya membingungkan.
   *  - Halaman BACA (s status, m monitor, sum rekap) → bebas pilih dari
   *    daftar periode berisi data (arsip tetap bisa dilihat).
   *  - Kartu pengatur (ap-*) → bebas, untuk Operator/Admin.
   */
  function applyPeriods() {
    const periode = DATA.periode || {};
    const aktif = periode.aktif || null;
    const tersedia = periode.tersedia || [];    // [{semester, tahunAjaran}]
    // Fallback: server belum pernah menyimpan periode & belum ada data —
    // tetap tampilkan pilihan agar UI tidak kosong total.
    const free = tersedia.length ? tersedia.map(p => [p.semester, p.tahunAjaran]) : PERIOD_OPTIONS.map(x => [x[0], x[1]]);
    const setLocked = (prefix) => {
      const sem = $('#' + prefix + '-sem'), year = $('#' + prefix + '-thn');
      [sem, year].forEach(el => { if (el) el.disabled = true; });
      if (!aktif) {
        // Tanpa periode aktif → kosongkan (tulis akan ditolak server PERIOD_NOT_SET).
        [sem, year].forEach(el => { if (el) setOptions(el, [], false); });
        return;
      }
      // Tetap sisakan SATU opsi bernilai periode aktif — select tanpa opsi
      // tidak bisa memegang .value, sehingga tampilannya justru kosong.
      if (sem) { setOptions(sem, [[aktif.semester, aktif.semester]], false); sem.value = aktif.semester; }
      if (year) { setOptions(year, [[aktif.tahunAjaran, aktif.tahunAjaran]], false); year.value = aktif.tahunAjaran; }
    };
    const setFree = (prefix) => {
      const sem = $('#' + prefix + '-sem'), year = $('#' + prefix + '-thn');
      [sem, year].forEach(el => { if (!el) return; el.disabled = false; });
      // Isi semester dari daftar (Ganjil/Genap unik) & tahun dari daftar unik.
      if (sem) { setOptions(sem, [...new Set(free.map(x => x[0]))]); if (aktif) sem.value = aktif.semester; }
      if (year) { setOptions(year, [...new Set(free.map(x => x[1]))]); if (aktif) year.value = aktif.tahunAjaran; }
    };
    ['n','a','e','r','c'].forEach(setLocked);   // input → terkunci periode aktif
    ['s','m','sum'].forEach(setFree);           // baca → bebas pilih
    // Kartu pengatur Operator/Admin.
    if ($('#ap-sem') && $('#ap-thn')) {
      setOptions($('#ap-sem'), [...new Set(free.map(x => x[0]))]);
      setOptions($('#ap-thn'), [...new Set(free.map(x => x[1]))]);
      if (aktif) { $('#ap-sem').value = aktif.semester; $('#ap-thn').value = aktif.tahunAjaran; }
    }
    ['n','a','e','r','c'].forEach(prefix => {
      const chip = $('[data-period-chip="' + prefix + '"]');
      if (chip) {
        chip.replaceChildren();
        if (aktif) {
          chip.append('Periode aktif: ');
          const strong = document.createElement('strong'); strong.textContent = aktif.semester + ' ' + aktif.tahunAjaran;
          chip.appendChild(strong);
        } else chip.textContent = 'Periode aktif belum ditetapkan';
      }
    });
    const badge = $('#period-badge');
    if (badge) {
      badge.classList.toggle('hidden', !aktif);
      badge.textContent = aktif ? aktif.semester + ' ' + aktif.tahunAjaran : '';
    }
    // Arsip: defaultkan ke periode berbeda yang masih berisi data.
    if (aktif && tersedia.length > 1 && $('#ar-sem')) {
      const lain = tersedia.find(p => !(p.semester === aktif.semester && p.tahunAjaran === aktif.tahunAjaran));
      const chosen = lain || tersedia[0];
      $('#ar-sem').value = chosen.semester; $('#ar-thn').value = chosen.tahunAjaran;
    }
  }

  function resetSessionExpired(err) {
    USER = null; DATA = {};
    $('#app-view').classList.add('hidden');
    $('#boot-view')?.classList.add('hidden');
    $('#login-view').classList.remove('hidden');
    $('#reset-view')?.classList.add('hidden');
    const error = $('#login-error');
    error.classList.remove('hidden');
    error.textContent = (err && err.message) || 'Sesi berakhir. Silakan masuk kembali.';
  }
  window.onSessionExpired = resetSessionExpired;

  window.addEventListener('beforeunload', e => {
    if (gradeDirty && !pendingSave) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------------- Login/session
  document.addEventListener('DOMContentLoaded', init);
  async function init() {
    populatePeriodSelects();
    bindEvents();
    const toggleButton = $('#toggle-login-password');
    if (toggleButton) toggleButton.addEventListener('click', toggleLoginPassword);
    // Coba lagi di layar progres (setelah boot gagal karena jaringan/CORS).
    const retry = $('#boot-retry');
    if (retry) retry.addEventListener('click', () => { if (bootRetry) bootRetry(); });

    if (isAuthenticated()) {
      // Seluruh rangkaian (validasi sesi → data awal → dashboard) berjalan di
      // layar progres; gagal jaringan menampilkan Coba lagi di layar itu.
      await enterApp(false);
      return;
    }
    $('#login-view').classList.remove('hidden');
  }

  function bindEvents() {
    // React to normal user interaction + delegated events from all dropdowns.
    document.addEventListener('change', e => {
      const id = e.target && e.target.id;
      if (!id) return;
      // `isTrusted` = false untuk Event yang didispatch programatis (popDrops boot).
      // Auto-load halaman hanya pada interaksi user asli — tanpa guard ini setiap
      // halaman termuat dua kali (dispatch boot + auto-load nav).
      const userGesture = e.isTrusted !== false;
      if (id === 'c-kelas') updateSubjects(e.target.value, 'c-mapel');
      if (id === 'n-kelas') { updateSubjects(e.target.value, 'n-mapel'); if (userGesture) checkAndLoadNilai(); }
      if (['n-mapel','n-sem','n-thn'].includes(id) && userGesture) checkAndLoadNilai();
      if (id === 'a-kelas' || id === 'a-sem' || id === 'a-thn') { if (userGesture) loadAbsen(); }
      if (id === 'e-kelas' || id === 'e-sem' || id === 'e-thn') { if (userGesture) loadEkstra(); }
      // Guard sama seperti halaman lain: preselect boot tidak boleh memicu
      // muat daftar siswa halaman rapor yang belum dibuka (toast error saat login).
      if (id === 'r-kelas' && userGesture) loadSiswa(e.target.value);
      if (id === 'c-mapel' && userGesture) loadCapaian();
      if (id === 'm-kelas' || id === 'm-sem' || id === 'm-thn') { /* explicit button */ }
      if (id === 'ar-kelas' && userGesture) loadArchiveStudents(e.target.value);
      if (id === 'ak-mode') {
        const temp = e.target.value === 'temporary';
        $('#ak-temp-wrap')?.classList.toggle('hidden', !temp);
        $('#ak-btn-temp')?.classList.toggle('hidden', !temp);
        $('#ak-btn-flag')?.classList.toggle('hidden', temp);
      }
      if (id === 'pl-kelas') {
        // Isi pilihan mapel sesuai kelas terpilih (data dari getAssignmentList).
        const list = (window.__PLOT_MAPEL && window.__PLOT_MAPEL[e.target.value]) || [];
        setOptions($('#pl-mapel'), list.map(m => [m.kode, m.kode + ' — ' + m.nama]), '-Pilih Mapel-');
      }
    });

    document.addEventListener('input', e => {
      if (e.target && e.target.id === 'c-text') updateCapaianCount();
      if (e.target && e.target.closest('#n-table-area') && e.target.matches('input[type=number]')) {
        gradeDirty = true;
        e.target.classList.remove('input-invalid');
        const n = e.target.value === '' ? null : Number(e.target.value);
        if (n !== null && (!Number.isFinite(n) || n < 0 || n > 100)) e.target.classList.add('input-invalid');
        updateDirtyIndicator();
      }
    });

    document.addEventListener('click', e => {
      const navLink = e.target.closest('[data-nav]');
      if (navLink) { e.preventDefault(); nav(navLink.dataset.nav); }
      const button = e.target.closest('[data-action]');
      if (button) { e.preventDefault(); runAction(button.dataset.action, button); }
      // Tab halaman Rapor (Periode Aktif | Arsip).
      const raporTab = e.target.closest('#rapor-tab-active, #rapor-tab-archive');
      if (raporTab) switchRaporTab(raporTab.id === 'rapor-tab-archive' ? 'arsip' : 'aktif');
    });

    // Score keyboard navigation: Enter moves one row down, Shift+Enter up.
    $('#n-table-area').addEventListener('keydown', e => {
      if (e.key !== 'Enter' || !e.target.matches('input[type=number]')) return;
      e.preventDefault();
      const inputs = $$('#n-table-area input[type=number]');
      const index = inputs.indexOf(e.target);
      const next = index + (e.shiftKey ? -7 : 7); // 7 score columns per student
      if (inputs[next]) { inputs[next].focus(); inputs[next].select(); }
    });
  }

  function runAction(name, button) {
    const actions = {
      login: handleLogin, logout: handleLogout, toggleSidebar, saveCapaian,
      saveNilaiManual, uploadNilai, saveAbsen, saveEkstra, loadStatus,
      previewRapor, doPrint, bulkPrint, changePw, loadMonitoring,
      loadSiswaList, saveSiswa, resetSiswaForm, editSiswa, resetAccountFlag, resetAccountTemp,
      saveUserAccount, loadAccounts, saveAssignment, loadProgressSummary,
      previewPromotion, commitPromotion,
      setActivePeriod, loadArchive, archivePreview, archivePrint, archiveBulkPrint
    };
    if (actions[name]) actions[name](button);
  }

  function toggleLoginPassword() {
    const input = $('#password-input'), btn = $('#toggle-login-password');
    const show = input.type === 'password'; input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
    btn.setAttribute('aria-pressed', String(show));
    const icon = btn.querySelector('i');
    icon.classList.toggle('fa-eye', !show); icon.classList.toggle('fa-eye-slash', show);
  }

  async function handleLogin() {
    const username = $('#username-input').value.trim();
    const password = $('#password-input').value;
    $('#login-error').classList.add('hidden');
    if (!username || !password) { $('#login-error').textContent = 'Isi username dan password.'; $('#login-error').classList.remove('hidden'); return; }
    const button = $('[data-action="login"]'); setBusy(button, true, 'Memeriksa…');
    try {
      const result = await api('login', { username, password }, { auth: false });
      if (result && result.resetRequired) {
        $('#reset-username').value = result.username;
        $('#reset-view').classList.remove('hidden');
        $('#login-view').classList.add('hidden');
      } else if (result && result.token && result.user) {
        setSession(result.token, result.user); USER = result.user; enterApp(true);
      } else throw new Error('Respons login tidak lengkap.');
    } catch (e) {
      $('#login-error').textContent = e.message; $('#login-error').classList.remove('hidden');
    } finally { setBusy(button, false); }
  }

  async function submitPasswordReset() {
    const username = $('#reset-username').value;
    const oldPassword = $('#reset-old-password').value;
    const newPassword = $('#reset-new-password').value;
    const confirmPassword = $('#reset-confirm-password').value;
    const status = $('#reset-status');
    if (!username || !oldPassword || !newPassword || !confirmPassword) { status.textContent = 'Lengkapi semua kolom.'; return; }
    if (newPassword !== confirmPassword) { status.textContent = 'Konfirmasi password tidak cocok.'; return; }
    if (newPassword.length < 10) { status.textContent = 'Password baru minimal 10 karakter.'; return; }
    const button = $('#reset-submit'); setBusy(button, true, 'Mengubah password…');
    try {
      const result = await api('resetPassword', { username, oldPassword, newPassword }, { auth: false });
      setSession(result.token, result.user); USER = result.user; enterApp(true);
    } catch (e) { status.textContent = e.message; }
    finally { setBusy(button, false); }
  }

  let loggingOut = false;   // tombol logout bisa diklik ganda sebelum reload
  async function handleLogout() {
    if (loggingOut) return;
    // Keluar dengan nilai belum disimpan = hilang diam-diam. Samakan dengan nav().
    if (gradeDirty) {
      const ok = await confirmBar('Ada perubahan nilai yang belum disimpan. Keluar sekarang?');
      if (!ok) return;
    }
    loggingOut = true;
    try { if (isAuthenticated()) await api('logout', {}, { timeout: 10000 }); }
    catch (_) { /* hapus token lokal walau server tak terjangkau */ }
    clearSession(); USER = null; DATA = {};
    location.reload();
  }

  /**
   * Masuk ke aplikasi + muat data awal, dengan layar progres bertahap.
   * Urutan: MUNGKIN dapat `initial` (sesi sudah divalidasi) → getInitialData →
   * getDashboardStats → SEMUA DATA SIAP → baru paint shell. Dengan begitu
   * dashboard tidak pernah menampilkan angka 0 dan #loader tidak berkedip.
   * @param {boolean} [validated] true bila sesi sudah divalidasi (langkah 1 dilewati)
   * @returns {Promise<boolean>} false bila gagal (login ditampilkan lagi / retry)
   */
  async function enterApp(validated) {
    const boot = () => bootRun(validated);
    bootStart();
    return boot();
  }
  async function bootRun(validated) {
    // `current` = langkah yang sedang berjalan; inilah yang ditandai error bila
    // melempar (pencarian "langkah belum done" bisa salah pilih bila sebuah
    // langkah gagal setelah step berikutnya sempat ditandai done).
    let current = 'session';
    if (!validated) bootStep('session', 'active');
    else bootStep('session', 'done');
    try {
      // Langkah 1 — hanya pada restore sesi; login baru sudah mengembalikan identitas.
      if (!validated) {
        current = 'session';
        USER = await api('validateSession', {}, { timeout: 15000, silent: true });
        setSession(window.ERAPOR.getToken(), USER);
        bootStep('session', 'done');
      }
      // Langkah 2 — data awal (kelas/mapel/ekstra + periode aktif & arsip).
      current = 'initial';
      bootStep('initial', 'active');
      DATA = await api('getInitialData', {}, { silent: true });
      applyPeriods();
      bootStep('initial', 'done');
      // Langkah 3 — statistik dashboard.
      current = 'dashboard';
      bootStep('dashboard', 'active');
      let stats = null;
      try { stats = await api('getDashboardStats', {}, { silent: true }); }
      catch (e) { if (e.code === 'AUTH_EXPIRED' || e.code === 'AUTH_REQUIRED') throw e; }
      bootStep('dashboard', 'done');
      bootDone();
      paintApp(stats);
      return true;
    } catch (e) {
      if (e.code === 'AUTH_EXPIRED' || e.code === 'AUTH_REQUIRED') {
        clearSession(); bootDone(); resetSessionExpired(e); return false;
      }
      // Kegagalan jaringan/CORS → layar boot tetap, tersedia Coba lagi.
      bootStep(current, 'error');
      bootFail(e.message || 'Gagal memuat data. Periksa koneksi.', () => enterApp(validated));
      return false;
    }
  }
  /** Tampilan shell hanya setelah data awal lengkap. */
  function paintApp(stats) {
    $('#login-view').classList.add('hidden'); $('#reset-view')?.classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    const name = USER.fullName || USER.username;
    $('#display-username').textContent = name; $('#dash-greeting-name').textContent = name;
    $('#display-role').textContent = USER.role;
    $('#user-avatar').src = 'https://ui-avatars.com/api/?name=' + encodeURIComponent(name) + '&background=B06161&color=fff';
    $('#profile-button').setAttribute('aria-label', 'Pengaturan akun ' + name);
    // Rekap progres hanya untuk pemantau (Waka Kurikulum & Admin).
    $('#dash-progress')?.classList.toggle('hidden', !(USER.role === 'Waka Kurikulum' || USER.role === 'Admin'));
    // Dua wajah dashboard (keputusan pemilik Tahap 10): admin/Operator/Waka melihat
    // statistik sekolah; Guru Mapel & Wali Kelas melihat daftar tugas mereka.
    const isTeacher = USER.role === 'Guru Mapel' || USER.role === 'Wali Kelas';
    $('#dash-stats')?.classList.toggle('hidden', isTeacher);
    $('#dash-workbench')?.classList.toggle('hidden', !isTeacher);
    // Tab rapor default per role; Guru Mapel tidak punya panel "Periode Aktif"
    // (server menolak getRaportData via assertClassAccess_).
    activeRaporTab = USER.role === 'Guru Mapel' ? 'arsip' : 'aktif';
    $('#rapor-tab-active')?.classList.toggle('hidden', USER.role !== 'Admin' && USER.role !== 'Wali Kelas');
    popDrops();
    buildMenu(USER.role);
    if (stats) renderDashStats(stats);
    // Statistik bisa saja gagal (bukan error auth) → muat lagi di latar belakang.
    if (!stats) loadDash();
    if (isTeacher) loadWorkbench();
  }
  function renderDashStats(s) {
    $('#dash-siswa').textContent = s.siswa; $('#dash-kelas').textContent = s.kelas;
    $('#dash-mapel').textContent = s.mapel; $('#dash-nilai').textContent = s.nilai;
  }

  // -------------------------------------------------------------- Navigation
  const MENUS = {
    'Guru Mapel': [
      ['p-dashboard','fas fa-home','Dashboard'], ['p-capaian','fas fa-book','Input Capaian'],
      ['p-nilai','far fa-file-alt','Input Nilai'], ['p-status','fas fa-chart-line','Status Nilai'],
      ['p-rapor','fas fa-print','Rapor']
    ],
    'Wali Kelas': [
      ['p-dashboard','fas fa-home','Dashboard'], ['p-absen','fas fa-user-clock','Absensi'],
      ['p-ekstra','fas fa-running','Ekstrakurikuler'], ['p-status','fas fa-chart-line','Status Nilai'],
      ['p-rapor','fas fa-print','Rapor']
    ],
    'Admin': [
      ['p-dashboard','fas fa-home','Dashboard'], ['p-capaian','fas fa-book','Input Capaian'],
      ['p-nilai','far fa-file-alt','Input Nilai'], ['p-absen','fas fa-user-clock','Absensi'],
      ['p-ekstra','fas fa-running','Ekstrakurikuler'], ['p-status','fas fa-chart-line','Status Nilai'],
      ['p-rapor','fas fa-print','Rapor'], ['p-siswa','fas fa-user-graduate','Data Siswa'],
      ['p-akun','fas fa-user-shield','Akun & Reset'], ['p-plotting','fas fa-diagram-project','Penugasan'],
      ['p-monitor','fas fa-chart-pie','Pantau Kelengkapan']
    ],
    'Operator': [
      ['p-dashboard','fas fa-home','Dashboard'], ['p-siswa','fas fa-user-graduate','Data Siswa'],
      ['p-akun','fas fa-user-shield','Akun & Reset'], ['p-plotting','fas fa-diagram-project','Penugasan']
    ],
    'Waka Kurikulum': [
      ['p-dashboard','fas fa-home','Dashboard'], ['p-status','fas fa-chart-line','Status Nilai'],
      ['p-monitor','fas fa-chart-pie','Pantau Kelengkapan']
    ]
  };
  function buildMenu(role) {
    // Role tak dikenal → menu minimal. getInitialData_ mengembalikan data KOSONG
    // untuk role tak dikenal, jadi menampilkan menu penuh hanya berisi halaman error.
    const items = MENUS[role] || [['p-dashboard','fas fa-home','Dashboard'], ['p-pass','fas fa-key','Pengaturan Akun']];
    // Dua kontainer dengan gaya berbeda: tab pil di topbar (desktop) dan
    // daftar vertikal di drawer (mobile). id unik — nav() menyorot keduanya.
    const drawer = $('#sidebar-menu'); if (drawer) drawer.replaceChildren();
    const top = $('#topnav-menu'); if (top) top.replaceChildren();
    items.forEach(([id, icon, title]) => {
      if (top) {
        const tab = document.createElement('button');
        tab.type = 'button'; tab.id = 'toplink-' + id; tab.dataset.nav = id;
        tab.className = 'nav-item';
        tab.innerHTML = esc(title);
        top.appendChild(tab);
      }
      if (drawer) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button'; button.id = 'link-' + id; button.dataset.nav = id;
        button.className = 'nav-item';
        button.innerHTML = '<i class="' + icon + '" aria-hidden="true"></i><span>' + esc(title) + '</span>';
        li.appendChild(button); drawer.appendChild(li);
      }
    });
    // Scroll-fade hanya bila menu benar-benar melebihi lebar layar (Tahap 10):
    // tanpa ini bayangan muncul permanen pada menu yang muat.
    if (top) requestAnimationFrame(() => top.classList.toggle('nav-fade', top.scrollWidth > top.clientWidth + 1));
    nav('p-dashboard');
  }
  /** Judul & subjudul per halaman — lebih berguna daripada id huruf kapital. */
  const PAGE_META = {
    'p-dashboard': ['Dashboard', 'Ringkasan kerja dan status hari ini'],
    'p-capaian': ['Input Capaian', 'Deskripsi capaian per kelas, mapel, dan periode aktif'],
    'p-nilai': ['Input Nilai', 'Nilai ulangan harian, STS, dan SAS — periode aktif'],
    'p-status': ['Status Nilai', 'Kelengkapan nilai per kelas dan mata pelajaran'],
    'p-absen': ['Absensi', 'Sakit, izin, dan alpha per siswa — periode aktif'],
    'p-ekstra': ['Ekstrakurikuler', 'Nilai kegiatan per siswa — periode aktif'],
    'p-rapor': ['Rapor', 'Pratinjau dan cetak PDF — periode aktif maupun arsip'],
    'p-monitor': ['Pantau Kelengkapan', 'Leger nilai seluruh siswa per kelas'],
    'p-siswa': ['Data Siswa', 'Kelola data siswa, promosi kelas, dan status kelulusan'],
    'p-akun': ['Akun & Reset', 'Reset password, ubah role, dan periode aktif'],
    'p-plotting': ['Penugasan', 'Plotting mata pelajaran per kelas'],
    'p-pass': ['Pengaturan Akun', 'Ganti password Anda']
  };

  async function nav(id) {
    const seq = ++navSeq;
    if (gradeDirty && id !== 'p-nilai') {
      const ok = await confirmBar('Ada perubahan nilai yang belum disimpan. Tinggalkan halaman?');
      if (!ok || seq !== navSeq) return;
    }
    $$('.page-section').forEach(el => el.classList.add('hidden'));
    const page = document.getElementById(id); if (!page) return;
    page.classList.remove('hidden');
    const meta = PAGE_META[id];
    $('#page-title').textContent = meta ? meta[0] : id.replace('p-', '').replace(/-/g, ' ').toUpperCase();
    const sub = $('#page-sub');
    if (sub) sub.textContent = meta ? meta[1] : 'Sistem Penilaian Terpadu SMP-MA DAFI';
    $$('.nav-item').forEach(el => { el.classList.remove('active-nav'); el.removeAttribute('aria-current'); });
    ['#link-','#toplink-'].forEach(sel => {
      const link = $(sel + id);
      if (link) { link.classList.add('active-nav'); link.setAttribute('aria-current','page'); }
    });
    if (innerWidth < 768) closeSidebar();
    // ---- Halaman yang langsung termuat (Tahap 10): tidak perlu klik "Muat" manual.
    if (id === 'p-akun' || id === 'p-plotting') loadAccounts();
    if (id === 'p-siswa') { loadSiswaList(); promotionOptions(); }
    if (id === 'p-nilai') { preselectNilai(); checkAndLoadNilai(); }
    if (id === 'p-absen') loadAbsen();
    if (id === 'p-ekstra') loadEkstra();
    if (id === 'p-capaian') { preselectCapaian(); loadCapaian(); }
    if (id === 'p-status') loadStatus();
    if (id === 'p-rapor') {
      // Tab default sudah diset paintApp per role (Guru Mapel → arsip).
      switchRaporTab(activeRaporTab, true);
    }
    if (id === 'p-monitor') loadMonitoring();
  }
  /** Preselect kelas & mapel pertama agar auto-load benar-benar memuat tabel. */
  function preselectNilai() {
    const k = $('#n-kelas'), m = $('#n-mapel');
    if (k && !k.value && k.options.length > 1) k.value = k.options[1].value;
    if (k && k.value) {
      if (!m || !m.value) {
        updateSubjects(k.value, 'n-mapel');
        if (m && m.options.length > 1) { m.value = m.options[1].value; }
      }
    }
  }
  function preselectCapaian() {
    const k = $('#c-kelas'), m = $('#c-mapel');
    if (k && !k.value && k.options.length > 1) k.value = k.options[1].value;
    if (k && k.value) {
      if (!m || !m.value) {
        updateSubjects(k.value, 'c-mapel');
        if (m && m.options.length > 1) m.value = m.options[1].value;
      }
    }
  }
  /** Ganti panel rapor (Periode Aktif | Arsip). Inisialisasi arsip dipanggil di sini. */
  function switchRaporTab(tab, silent) {
    activeRaporTab = tab === 'arsip' ? 'arsip' : 'aktif';
    const showAktif = activeRaporTab === 'aktif';
    $('#p-cetak')?.classList.toggle('hidden', !showAktif);
    $('#p-arsip')?.classList.toggle('hidden', showAktif);
    $('#rapor-tab-active')?.setAttribute('aria-selected', String(showAktif));
    $('#rapor-tab-archive')?.setAttribute('aria-selected', String(!showAktif));
    if (!showAktif) archiveOptions();   // isi filter arsip + gate blok cetak per role
    else {
      // Preselect kelas di popDrops tidak memicu loadSiswa (guard isTrusted),
      // jadi muat daftar siswa cetak di sini agar tab Aktif tidak pernah kosong.
      const kelas = $('#r-kelas');
      if (kelas && kelas.value) loadSiswa(kelas.value);
    }
    if (!silent) $('#page-title')?.focus?.();
  }
  function toggleSidebar() {
    const side = $('#sidebar'), overlay = $('#mobile-overlay'), btn = $('#sidebar-toggle');
    const open = side.classList.contains('-translate-x-full');
    side.classList.toggle('-translate-x-full', !open); overlay.classList.toggle('hidden', !open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) side.querySelector('button[data-nav]')?.focus(); else btn.focus();
  }
  function closeSidebar() {
    $('#sidebar').classList.add('-translate-x-full'); $('#mobile-overlay').classList.add('hidden');
    $('#sidebar-toggle').setAttribute('aria-expanded','false');
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && innerWidth < 768 && !$('#sidebar').classList.contains('-translate-x-full')) closeSidebar(); });

  // ---------------------------------------------------------- Drop-downs/data
  function popDrops() {
    let classes = DATA.kelas || [];
    if (USER.role === 'Wali Kelas' && USER.waliKelasOf) classes = [USER.waliKelasOf];
    ['c-kelas','n-kelas','a-kelas','e-kelas','r-kelas','m-kelas'].forEach(id => {
      const el = $('#' + id); if (!el) return;
      setOptions(el, classes);
      if (USER.role === 'Wali Kelas' && USER.waliKelasOf) { el.value = USER.waliKelasOf; el.disabled = true; }
      else el.disabled = false;
      // Preselect kelas pertama (Tahap 10) agar halaman auto-load punya input;
      // dispatch sintetis ditahan guard isTrusted di handler change.
      if (!el.value && classes.length) el.value = classes[0];
      if (el.value) el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  function updateSubjects(k, id) {
    const select = $('#' + id);
    if (!k) return setOptions(select, [], '-Pilih Kelas-');
    const rows = (DATA.mapel || []).filter(m => m.kelas === k || m.kelas === 'ALL');
    const seen = new Set();
    const options = rows.filter(m => { if (seen.has(m.kode)) return false; seen.add(m.kode); return true; }).map(m => [m.kode, m.nama]);
    setOptions(select, options);
    // Preselect mapel pertama bila belum ada pilihan — auto-load butuh nilai terisi.
    if (select && !select.value && options.length) select.value = options[0][0];
  }
  async function loadDash() {
    try {
      const s = await api('getDashboardStats');
      $('#dash-siswa').textContent = s.siswa; $('#dash-kelas').textContent = s.kelas;
      $('#dash-mapel').textContent = s.mapel; $('#dash-nilai').textContent = s.nilai;
    } catch (e) { toast(e.message, false); }
  }

  // ---------------------------------------------------- Daftar tugas guru (Tahap 10)
  /** Dashboard Guru Mapel & Wali Kelas: pasangan kelas×mapel yang diampu + status
   *  isinya + pintu langsung ke halaman input. Menggantikan 4 kartu statistik global
   *  yang tidak menjawab "hari ini kerja apa". */
  async function loadWorkbench() {
    const area = $('#dash-workbench-list');
    if (!area) return;
    area.replaceChildren();
    let d;
    try {
      d = await api('getMyWorkbench', {}, { silent: true });
    } catch (e) {
      const err = document.createElement('div'); err.className = 'callout bad';
      err.setAttribute('role', 'alert'); err.textContent = e.message;
      area.appendChild(err); return;
    }
    if (!d.periode) {
      const warn = document.createElement('div'); warn.className = 'callout';
      warn.setAttribute('role', 'status');
      warn.textContent = 'Periode aktif belum ditetapkan Operator/Admin — input nilai, absensi, ekstra, dan capaian belum dapat ditulis.';
      area.appendChild(warn); return;
    }
    if (!d.tugas.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state';
      empty.textContent = 'Belum ada penugasan mata pelajaran untuk akun ini.';
      area.appendChild(empty); return;
    }
    d.tugas.forEach(t => {
      const card = document.createElement('div');
      card.className = 'status-card';
      const head = document.createElement('div'); head.className = 'status-card-head';
      const label = document.createElement('span');
      label.textContent = t.nama + ' · ' + t.kelas;
      const pct = document.createElement('span');
      pct.className = 'badge ' + (t.nilai.persen === 100 ? 'badge-ok' : t.nilai.persen >= 70 ? 'badge-warn' : 'badge-bad');
      pct.textContent = t.nilai.persen + '%';
      head.append(label, pct);
      const ul = document.createElement('ul');
      const row = document.createElement('li'); row.className = 'status-row';
      const left = document.createElement('span'); left.className = 'name';
      left.textContent = 'Nilai ' + t.nilai.terisi + '/' + t.nilai.total + ' siswa';
      const cap = document.createElement('span');
      cap.className = 'badge ' + (t.capaian ? 'badge-ok' : 'badge-warn');
      cap.textContent = t.capaian ? 'Capaian ✓' : 'Capaian –';
      row.append(left, cap);
      ul.appendChild(row);
      // Pintu harus menunjuk halaman yang BENAR-BENAR ada di menu role tsb.
      // Menu Wali Kelas sengaja tanpa p-nilai/p-capaian (ia memantau lewat
      // Status Nilai) — memberi pintu ke sana membuat navigasi buntu.
      const role = (USER && USER.role) || '';
      const menuIds = (MENUS[role] || []).map(x => x[0]);
      const go = document.createElement('li'); go.className = 'status-row';
      if (menuIds.indexOf('p-nilai') >= 0) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'btn-secondary'; btn.textContent = 'Input Nilai';
        btn.onclick = () => { openWorkbench('p-nilai', t.kelas, t.kode); };
        go.appendChild(btn);
      }
      if (menuIds.indexOf('p-capaian') >= 0) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'btn-secondary'; btn.textContent = 'Capaian';
        btn.onclick = () => { openWorkbench('p-capaian', t.kelas, t.kode); };
        go.appendChild(btn);
      }
      // Fallback peran pengawas: tautkan ke Status Nilai (ada di menunya).
      if (go.children.length === 0 && menuIds.indexOf('p-status') >= 0) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'btn-secondary'; btn.textContent = 'Lihat Status';
        btn.onclick = () => nav('p-status');
        go.appendChild(btn);
      }
      if (go.children.length) ul.appendChild(go);
      card.append(head, ul);
      area.appendChild(card);
    });
  }
  /** Pintu langsung dari dashboard: preselect kelas+mapel lalu buka halaman. */
  function openWorkbench(page, kelas, kode) {
    const prefix = page === 'p-nilai' ? 'n' : 'c';
    const k = $('#' + prefix + '-kelas'), m = $('#' + prefix + '-mapel');
    if (k) { k.value = kelas; updateSubjects(kelas, prefix + '-mapel'); }
    if (m) m.value = kode;
    nav(page);
  }

  // --------------------------------------------------------- Capaian
  async function loadCapaian() {
    const kode = $('#c-mapel').value, kelas = $('#c-kelas').value;
    if (!kode || !kelas) return;
    try { $('#c-text').value = await api('getCapaian', { kode, kelas, semester: $('#c-sem').value, tahunAjaran: $('#c-thn').value }); updateCapaianCount(); }
    catch (e) { toast(e.message, false); }
  }
  function updateCapaianCount() {
    const text = $('#c-text').value.trim(); const words = text ? text.split(/\s+/).length : 0;
    const el = $('#c-count'); el.textContent = words + '/25 kata';
    el.className = 'text-xs font-medium px-2 py-1 rounded ' + (words > 25 ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-500');
  }
  async function saveCapaian(button) {
    const kode = $('#c-mapel').value, kelas = $('#c-kelas').value, teks = $('#c-text').value;
    if (!kode || !kelas) return toast('Pilih kelas dan mata pelajaran.', false);
    if (teks.trim().split(/\s+/).filter(Boolean).length > 25) return toast('Capaian maksimal 25 kata.', false);
    setBusy(button || $('[data-action="saveCapaian"]'), true, 'Menyimpan…');
    try { await api('saveCapaian', { kode, kelas, teks, semester: $('#c-sem').value, tahunAjaran: $('#c-thn').value }); safeMsg('c-status','Capaian tersimpan.',true); gradeDirty = false; }
    catch (e) { safeMsg('c-status',e.message,false); }
    finally { setBusy(button || $('[data-action="saveCapaian"]'), false); }
  }

  // --------------------------------------------------------- Nilai
  function checkAndLoadNilai() {
    const k=$('#n-kelas').value, m=$('#n-mapel').value, s=$('#n-sem').value, t=$('#n-thn').value;
    if(k&&m&&s&&t) loadNilaiTable(k,m,s,t);
  }
  async function loadNilaiTable(k,m,s,t) {
    const area=$('#n-table-area'); area.innerHTML='<div class="empty-state" role="status" aria-live="polite">Memuat data…</div>';
    try {
      const data=await api('getDataNilaiInput',{kelas:k,kodeMapel:m,semester:s,tahunAjaran:t});
      if(!data || !data.length) { area.innerHTML='<div class="empty-state">Belum ada siswa pada kelas ini.</div>'; return; }
      let html='<table class="data-table" style="min-width:640px"><thead><tr><th rowspan="2" class="sticky sticky-end">Nama Siswa</th><th colspan="5" class="center">Ulangan Harian</th><th rowspan="2" class="center col-sts">STS</th><th rowspan="2" class="center col-sas">SAS</th></tr><tr><th class="center">1</th><th class="center">2</th><th class="center">3</th><th class="center">4</th><th class="center">5</th></tr></thead><tbody>';
      data.forEach(r=>{
        html+='<tr data-nis="'+esc(r.nis)+'"><td class="sticky sticky-end" style="white-space:nowrap"><span class="font-semibold">'+esc(r.nama)+'</span><br><span class="text-[10px] text-gray-400 font-normal">'+esc(r.nis)+'</span></td>';
        [1,2,3,4,5].forEach(i=>html+='<td class="center" style="padding:.4rem .3rem"><input type="number" inputmode="decimal" class="grade-input uh'+i+'" value="'+esc(r['uh'+i]??'')+'" data-original-value="'+esc(r['uh'+i]??'')+'" min="0" max="100" step="1" aria-label="UH '+i+' — '+esc(r.nama)+'"></td>');
        html+='<td class="center col-sts" style="padding:.4rem .3rem"><input type="number" inputmode="decimal" class="grade-input sts" value="'+esc(r.sts??'')+'" data-original-value="'+esc(r.sts??'')+'" min="0" max="100" step="1" aria-label="STS — '+esc(r.nama)+'"></td>';
        html+='<td class="center col-sas" style="padding:.4rem .3rem"><input type="number" inputmode="decimal" class="grade-input sas" value="'+esc(r.sas??'')+'" data-original-value="'+esc(r.sas??'')+'" min="0" max="100" step="1" aria-label="SAS — '+esc(r.nama)+'"></td></tr>';
      });
      area.innerHTML=html+'</tbody></table>'; gradeDirty=false; updateDirtyIndicator();
    } catch(e) { area.innerHTML='<div class="empty-state bad" role="alert">'+esc(e.message)+'</div>'; }
  }
  function getGradeFilters() {
    const k=$('#n-kelas').value,m=$('#n-mapel').value,s=$('#n-sem').value,t=$('#n-thn').value;
    if(!k||!m||!s||!t) throw new Error('Lengkapi filter kelas, mapel, semester, dan tahun.');
    return { k,m,mn:$('#n-mapel option:checked')?.textContent||m,s,t };
  }
  function readGradeRows(filters) {
    return $$('#n-table-area tr[data-nis]').map(row=>{
      const out={nis:row.dataset.nis,kelas:filters.k,kodeMapel:filters.m,sem:filters.s,tahun:filters.t};
      ['uh1','uh2','uh3','uh4','uh5','sts','sas'].forEach(k=>{
        const value=row.querySelector('.'+k).value;
        // Untouched blank values are omitted (preserve existing); when user cleared
        // a prior value, the input's data-original-value tells us to send null.
        const input=row.querySelector('.'+k);
        if(value!=='') out[k]=Number(value);
        else if(input.dataset.originalValue && input.dataset.originalValue!=='') out[k]=null;
      });
      return out;
    });
  }
  function updateDirtyIndicator() {
    const el=$('#n-dirty'); if(el) { el.textContent=gradeDirty?'Ada perubahan belum disimpan':'Semua perubahan tersimpan'; el.classList.toggle('text-orange-600',gradeDirty); }
  }
  async function saveNilaiManual(button) {
    let f; try { f=getGradeFilters(); } catch(e) { return toast(e.message,false); }
    const invalid=$$('#n-table-area .input-invalid'); if(invalid.length) { invalid[0].focus(); return toast('Nilai harus di antara 0 dan 100.',false); }
    if(!gradeDirty) return toast('Tidak ada perubahan nilai.',true);
    if(!await confirmBar('Simpan nilai ' + f.mn + ' untuk kelas ' + f.k + '?', 'Simpan Nilai')) return;
    const rows=readGradeRows(f); pendingSave=true; setBusy(button||$('[data-action="saveNilaiManual"]'),true,'Menyimpan…');
    try { const r=await api('saveNilaiSiswa',{rows}); safeMsg('n-status-m',r.saved+' nilai diproses; '+r.duplicatesRemoved+' duplikat dibersihkan.',true); gradeDirty=false; await loadDash(); }
    catch(e) { safeMsg('n-status-m',e.message,false); }
    finally { pendingSave=false; setBusy(button||$('[data-action="saveNilaiManual"]'),false); updateDirtyIndicator(); }
  }

  async function uploadNilai(button) {
    let f; try { f=getGradeFilters(); } catch(e) { return toast(e.message,false); }
    const file=$('#n-file').files[0]; if(!file) return toast('Pilih file Excel terlebih dahulu.',false);
    if(file.size>5*1024*1024) return toast('Ukuran file maksimal 5 MB.',false);
    setBusy(button||$('[data-action="uploadNilai"]'),true,'Membaca Excel…');
    try {
      const buffer=await file.arrayBuffer(); const wb=XLSX.read(buffer,{type:'array'});
      if(!wb.SheetNames.length) throw new Error('File Excel tidak memiliki worksheet.');
      const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:''});
      if(rows.length<2) throw new Error('Tidak ditemukan baris data setelah header.');
      const students=await api('getSiswaByKelas',{kelas:f.k});
      const validNis=new Set(students.map(s=>String(s.nis)));
      const parsed=[]; const problems=[];
      rows.slice(1).forEach((row,i)=>{
        if(!row[0]) return;
        const nis=String(row[0]).trim();
        if(!validNis.has(nis)) { problems.push('Baris '+(i+2)+': NIS '+nis+' tidak ada di kelas '+f.k); return; }
        const item={nis,kelas:f.k,kodeMapel:f.m,sem:f.s,tahun:f.t};
        ['uh1','uh2','uh3','uh4','uh5','sts','sas'].forEach((key,j)=>{
          const raw=row[j+2]; if(raw===''||raw===null||raw===undefined) return;
          const n=Number(raw); if(!Number.isFinite(n)||n<0||n>100) problems.push('Baris '+(i+2)+': '+key+' harus 0–100'); else item[key]=n;
        });
        parsed.push(item);
      });
      if(problems.length) {
        renderUploadProblems(problems);
        if(problems.length>=parsed.length) throw new Error('Tidak ada baris valid untuk diupload.');
        // Lepas state busy selama konfirmasi (spinner tak boleh berputar di balik bar).
        setBusy(button||$('[data-action="uploadNilai"]'),false);
        const ok = await confirmBar(problems.length+' masalah ditemukan. Tetap simpan '+parsed.length+' baris valid?\n\n'+problems.slice(0,10).join('\n'), 'Simpan yang Valid');
        if(!ok) return;
        setBusy(button||$('[data-action="uploadNilai"]'),true,'Menyimpan…');
      } else {
        setBusy(button||$('[data-action="uploadNilai"]'),false);
        const ok = await confirmBar('Simpan '+parsed.length+' baris nilai '+f.mn+' kelas '+f.k+'?', 'Simpan Nilai');
        if(!ok) return;
        setBusy(button||$('[data-action="uploadNilai"]'),true,'Menyimpan…');
      }
      const result=await api('saveNilaiSiswa',{rows:parsed});
      safeMsg('n-status-u',result.saved+' nilai tersimpan.',true); gradeDirty=false; await loadDash();
    } catch(e) { safeMsg('n-status-u',e.message,false); }
    finally { setBusy(button||$('[data-action="uploadNilai"]'),false); }
  }
  function renderUploadProblems(list) {
    const el=$('#upload-problems'); if(!el) return;
    el.replaceChildren(); const ul=document.createElement('ul');
    list.slice(0,50).forEach(m=>{const li=document.createElement('li');li.textContent=m;ul.appendChild(li);});
    el.appendChild(ul); el.classList.remove('hidden');
  }

  // ------------------------------------------------------------ Attendance
  async function loadAbsen() {
    const kelas=$('#a-kelas').value,semester=$('#a-sem').value,tahunAjaran=$('#a-thn').value;
    if(!kelas||!semester||!tahunAjaran) return;
    try {
      const data=await api('getAbsensiSiswa',{kelas,semester,tahunAjaran});
      let html='<table class="data-table"><thead><tr><th>Nama Siswa</th><th class="center col-sts">Sakit</th><th class="center">Izin</th><th class="center col-sas">Alpha</th></tr></thead><tbody>';
      data.forEach(r=>html+='<tr data-n="'+esc(r.nis)+'"><td class="font-semibold">'+esc(r.nama)+'</td>'+['sakit','izin','alpha'].map((key,i)=>'<td class="center" style="padding:.4rem .3rem"><input type="number" class="attendance-input '+['s','i','a'][i]+'" value="'+esc(r[key])+'" min="0" step="1" aria-label="'+['Sakit','Izin','Alpha'][i]+' — '+esc(r.nama)+'"></td>').join('')+'</tr>');
      $('#a-table').innerHTML=html+'</tbody></table>';
    } catch(e) { $('#a-table').textContent=e.message; }
  }
  async function saveAbsen(button) {
    const semester=$('#a-sem').value,tahunAjaran=$('#a-thn').value;
    if(!$('#a-kelas').value||!semester||!tahunAjaran) return toast('Pilih kelas, semester, dan tahun.',false);
    const rows=$$('#a-table tr[data-n]').map(r=>({nis:r.dataset.n,sakit:r.querySelector('.s').value,izin:r.querySelector('.i').value,alpha:r.querySelector('.a').value}));
    if(!rows.length) return toast('Muat daftar siswa terlebih dahulu.',false);
    setBusy(button||$('[data-action="saveAbsen"]'),true,'Menyimpan…');
    try { const result=await api('saveAbsensiSiswa',{rows,semester,tahunAjaran}); safeMsg('a-status',result.saved+' data absensi tersimpan.',true); }
    catch(e) { safeMsg('a-status',e.message,false); }
    finally { setBusy(button||$('[data-action="saveAbsen"]'),false); }
  }

  // ------------------------------------------------------------ Extracurricular
  async function loadEkstra() {
    const kelas = $('#e-kelas').value, semester = $('#e-sem').value, tahunAjaran = $('#e-thn').value;
    if (!kelas) return;
    try {
      // Nilai TERSIMPAN ikut dimuat (Tahap 10) — sebelumnya hanya daftar siswa,
      // sehingga form selalu tampil kosong walau datanya sudah ada di sheet.
      const [data, saved] = await Promise.all([
        api('getSiswaByKelas', { kelas }),
        (semester && tahunAjaran) ? api('getNilaiEkstra', { kelas, semester, tahunAjaran }) : Promise.resolve([])
      ]);
      const byNis = {};
      (saved || []).forEach(x => { byNis[x.nis] = x.items || []; });
      const opts = (DATA.ekstrakurikuler || []).map(e => '<option value="' + esc(e[0]) + '">' + esc(e[1]) + '</option>').join('');
      const vOpts = '<option value="">-</option><option>A</option><option>B</option><option>C</option>';
      const pairCell = (items, i) => {
        return '<td><select class="e' + (i + 1) + '"><option value="">-</option>' + opts + '</select></td>'
             + '<td class="center"><select class="v' + (i + 1) + '" aria-label="Nilai ekstrakurikuler pilihan ' + (i + 1) + '">' + vOpts + '</select></td>';
      };
      let html = '<table class="data-table" style="min-width:720px"><thead><tr><th>Nama Siswa</th><th>Pilihan Ekstra 1</th><th class="center">Nilai</th><th>Pilihan Ekstra 2</th><th class="center">Nilai</th></tr></thead><tbody>';
      data.forEach(r => {
        const items = (byNis[r.nis] || []).slice(0, 2);
        r.__items = items;
        html += '<tr data-n="' + esc(r.nis) + '"><td class="font-semibold">' + esc(r.nama) + '</td>'
             + pairCell(items, 0) + pairCell(items, 1) + '</tr>';
      });
      $('#e-table').innerHTML = html + '</tbody></table>';
      // Setelah render: pilih option sesuai nilai tersimpan.
      $$('#e-table tr[data-n]').forEach((row, idx) => {
        const items = data[idx].__items || [];
        [0, 1].forEach(i => {
          if (!items[i]) return;
          const eSel = row.querySelector('.e' + (i + 1)), vSel = row.querySelector('.v' + (i + 1));
          if (eSel) eSel.value = items[i].kodeEkstra;
          if (vSel) vSel.value = items[i].nilai;
        });
      });
      safeMsg('e-status', data.length + ' siswa dimuat.', true);
    } catch (e) { safeMsg('e-status', e.message, false); }   // jangan menimpa tabel
  }
  async function saveEkstra(button) {
    const semester=$('#e-sem').value,tahunAjaran=$('#e-thn').value;
    if(!$('#e-kelas').value||!semester||!tahunAjaran) return toast('Pilih kelas, semester, dan tahun.',false);
    const rows=[];
    $$('#e-table tr[data-n]').forEach(r=>{
      const nis=r.dataset.n; const e1=r.querySelector('.e1').value,v1=r.querySelector('.v1').value,e2=r.querySelector('.e2').value,v2=r.querySelector('.v2').value;
      if(e1&&v1) rows.push({nis,kodeEkstra:e1,nilai:v1}); if(e2&&v2) rows.push({nis,kodeEkstra:e2,nilai:v2});
    });
    if(!rows.length) return toast('Pilih minimal satu ekstrakurikuler beserta nilai.',false);
    setBusy(button||$('[data-action="saveEkstra"]'),true,'Menyimpan…');
    try { const r=await api('saveNilaiEkstra',{rows,semester,tahunAjaran}); safeMsg('e-status',r.saved+' nilai ekstrakurikuler tersimpan.',true); }
    catch(e) { safeMsg('e-status',e.message,false); }
    finally { setBusy(button||$('[data-action="saveEkstra"]'),false); }
  }

  // ------------------------------------------------------------ Nilai view tab
  async function switchNilaiView(mode) {
    const manual=$('#view-manual'),upload=$('#view-upload');
    const isManual=mode==='m';
    manual.classList.toggle('hidden',!isManual); upload.classList.toggle('hidden',isManual);
    const btnM=$('#btn-m'),btnU=$('#btn-u');
    // gaya tab ditentukan CSS lewat aria-selected — className tetap 'tab'
    btnM.setAttribute('aria-selected',String(isManual)); btnU.setAttribute('aria-selected',String(!isManual));
    // Pindah tab berarti tinggalkan tabel — konfirmasi bila ada perubahan belum disimpan.
    if(gradeDirty && !isManual && !pendingSave){
      const ok = await confirmBar('Ada nilai yang belum disimpan. Tetap pindah ke tab Upload Excel?');
      if(!ok) {
        manual.classList.remove('hidden'); upload.classList.add('hidden');
        btnM.setAttribute('aria-selected','true'); btnU.setAttribute('aria-selected','false');
      }
    }
  }

  // ------------------------------------------------------------ Status
  async function loadStatus(button) {
    const semester=$('#s-sem').value,tahunAjaran=$('#s-thn').value;
    if(!semester||!tahunAjaran) return toast('Pilih semester dan tahun.',false);
    setBusy(button||$('[data-action="loadStatus"]'),true,'Memuat…');
    try {
      const data=await api('getUploadStatus',{semester,tahunAjaran});
      const area=$('#s-area'); area.replaceChildren();
      const classes=Object.keys(data||{}).sort();
      if(!classes.length) { area.textContent='Belum ada data status untuk periode ini.'; return; }
      classes.forEach(k=>{
        const card=document.createElement('div');card.className='status-card';
        const title=document.createElement('div');title.className='status-card-head';
        const label=document.createElement('span');label.textContent='Kelas '+k;title.appendChild(label);
        const items=(data[k]||[]);
        const total=items.length, lengkap=items.filter(x=>x.status==='Lengkap').length;
        const pct=document.createElement('span');pct.className='badge '+(lengkap===total&&total?'badge-ok':lengkap?'badge-warn':'badge-bad');
        pct.textContent=lengkap+'/'+total;title.appendChild(pct);
        card.appendChild(title);
        const ul=document.createElement('ul');
        items.forEach(item=>{
          const li=document.createElement('li');li.className='status-row';
          const name=document.createElement('span');name.className='name';name.textContent=item.mapel;
          const badge=document.createElement('span');
          // 3-kondisi (Tahap 10): Sebagian = sebagian siswa sudah terisi → kuning.
          badge.className='badge '+(item.status==='Lengkap'?'badge-ok':item.status==='Sebagian'?'badge-warn':'badge-bad');
          badge.textContent=item.status;
          const detail=document.createElement('span');
          detail.style.cssText='font-size:.7rem;color:var(--ink-3)';
          detail.textContent=(item.terisi??0)+'/'+(item.total??0);
          li.append(name,badge,detail);ul.appendChild(li);
        });
        card.appendChild(ul);area.appendChild(card);
      });
    } catch(e) { $('#s-area').textContent=e.message; }
    finally { setBusy(button||$('[data-action="loadStatus"]'),false); }
  }

  // ------------------------------------------------------------ Reports/PDF
  async function loadSiswa(k) {
    if(!k) { setOptions($('#r-siswa'),[]); return; }
    try { const data=await api('getSiswaByKelas',{kelas:k});setOptions($('#r-siswa'),data.map(s=>[s.nis,s.nama]),false); }
    catch(e) { toast(e.message,false); }
  }
  async function previewRapor(button) {
    const nis=$('#r-siswa').value,semester=$('#r-sem').value,tahunAjaran=$('#r-thn').value,jenisRapor=$('#r-jenis').value;
    if(!nis||!semester||!tahunAjaran) return toast('Lengkapi kelas, siswa, semester, dan tahun.',false);
    setBusy(button||$('[data-action="previewRapor"]'),true,'Mengambil preview…');
    try {
      const d=await api('getRaportData',{nis,semester,tahunAjaran,jenisRapor}); CURRENT_RAPOR_DATA=d;
      const area=$('#r-preview'); area.replaceChildren();
      const summary=document.createElement('div');summary.className='preview-summary';
      const left=document.createElement('div');const name=document.createElement('p');name.className='who';name.textContent=d.siswa.nama;const meta=document.createElement('p');meta.className='meta';meta.textContent='NIS: '+d.siswa.nis+'  ·  Kelas: '+d.siswa.kelas;left.append(name,meta);
      const right=document.createElement('div');right.className='period';right.textContent=d.meta.sem+' · '+d.meta.thn+' · '+d.meta.jenis;summary.append(left,right);area.appendChild(summary);
      const table=document.createElement('table');table.className='data-table mb-5';
      const header=document.createElement('thead');header.innerHTML='<tr><th>Mata Pelajaran</th><th class="center" style="width:8rem">Nilai Akhir</th><th>Deskripsi Capaian</th></tr>';
      const tbody=document.createElement('tbody');
      (d.nilai||[]).forEach(n=>{const tr=document.createElement('tr');[n.mapel,n.nilai,n.capaian].forEach((v,i)=>{const td=document.createElement('td');td.className=(i===1?'center font-bold text-lg text-[#B06161]':i===0?'font-semibold':'text-xs text-gray-600 leading-relaxed');td.textContent=v;tr.appendChild(td);});tbody.appendChild(tr);});
      table.append(header,tbody);area.appendChild(table);
      const sign=document.createElement('label');sign.className='sign-check';
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.id='r-ttd';
      sign.append(checkbox,document.createTextNode('Tampilkan Tanda Tangan Wali Kelas ('+d.waliKelas+')'));area.appendChild(sign);
      const one=document.createElement('button');one.type='button';one.className='btn-primary btn-block';one.dataset.action='doPrint';one.innerHTML='<i class="fas fa-file-pdf mr-2" aria-hidden="true"></i> Buat & Buka PDF Rapor';area.appendChild(one);
      const all=document.createElement('button');all.type='button';all.className='btn-secondary btn-block mt-3';all.dataset.action='bulkPrint';all.innerHTML='<i class="fas fa-copy mr-2" aria-hidden="true"></i> Cetak Semua Rapor Kelas '+esc(d.siswa.kelas)+' (seluruh kelas)';area.appendChild(all);
      area.classList.remove('hidden');
    } catch(e) { toast(e.message,false); }
    finally { setBusy(button||$('[data-action="previewRapor"]'),false); }
  }
  async function doPrint(button) {
    if(!CURRENT_RAPOR_DATA) return toast('Ambil preview rapor terlebih dahulu.',false);
    const data=CURRENT_RAPOR_DATA;const withSignature=$('#r-ttd').checked;
    setBusy(button||$('[data-action="doPrint"]'),true,'Membuat PDF…');
    try {
      const result=await api('generatePdf',{nis:data.siswa.nis,semester:data.meta.sem,tahunAjaran:data.meta.thn,jenisRapor:data.meta.jenis,withSignature});
      if(!result.url) throw new Error('Server tidak mengembalikan URL PDF.');
      window.open(result.url,'_blank','noopener');
    } catch(e) { toast(e.message,false); }
    finally { setBusy(button||$('[data-action="doPrint"]'),false); }
  }
  async function bulkPrint(button) {
    const kelas=$('#r-kelas').value,semester=$('#r-sem').value,tahunAjaran=$('#r-thn').value,jenisRapor=$('#r-jenis').value;
    if(!kelas||!semester||!tahunAjaran) return toast('Lengkapi kelas, semester, dan tahun.',false);
    const withSignature=$('#r-ttd').checked;
    const count=await api('getSiswaByKelas',{kelas}).then(x=>x.length).catch(e=>{toast(e.message,false);return 0;});
    if(!count) return;
    if(!await confirmBar('Akan dibuat '+count+' PDF untuk seluruh kelas '+kelas+' (bukan hanya siswa di preview). Lanjutkan?', 'Cetak Semua')) return;
    setBusy(button||$('[data-action="bulkPrint"]'),true,'Membuat '+count+' PDF…');
    try {
      const result=await api('generateAllPdf',{kelas,semester,tahunAjaran,jenisRapor,withSignature},{timeout:360000});
      const summary=result.generated+' berhasil, '+result.failed+' gagal.';
      toast(summary,true); if(result.url) window.open(result.url,'_blank','noopener');
      if(result.errors&&result.errors.length) console.warn('Kesalahan cetak PDF:',result.errors);
    } catch(e) { toast(e.message,false); }
    finally { setBusy(button||$('[data-action="bulkPrint"]'),false); }
  }

  // ------------------------------------------------- Arsip periode (Tahap 9)
  /** Isi filter halaman Arsip: kelas sesuai scope peran + periode bebas. */
  function archiveOptions() {
    let classes = DATA.kelas || [];
    if (USER.role === 'Wali Kelas' && USER.waliKelasOf) classes = [USER.waliKelasOf];
    const kelas = $('#ar-kelas');
    // Cetak rapor arsip hanya Admin/Wali Kelas (gerbang server tetap assertClassAccess_;
    // menyembunyikan blok ini murni UX — otoritas tetap di server).
    $('#ar-print-card')?.classList.toggle('hidden', !(USER.role === 'Admin' || USER.role === 'Wali Kelas'));
    if (kelas) {
      setOptions(kelas, classes);
      if (USER.role === 'Wali Kelas' && USER.waliKelasOf) { kelas.value = USER.waliKelasOf; kelas.disabled = true; }
      else kelas.disabled = false;
      // Preselect kelas pertama — konsisten dengan popDrops() halaman input,
      // supaya tab Arsip langsung berisi daftar siswa (bukan pilih manual dulu).
      if (!kelas.value && classes.length) kelas.value = classes[0];
    }
    const tersedia = (DATA.periode || {}).tersedia || [];   // [{semester, tahunAjaran}]
    // Pasangan opsi [sem, tahun] untuk mengisi dropdown (fallback: PERIOD_OPTIONS).
    const pairs = tersedia.map(x => [x.semester, x.tahunAjaran]);
    const free = pairs.length ? pairs : PERIOD_OPTIONS.map(x => [x[0], x[1]]);
    const sem = $('#ar-sem'), thn = $('#ar-thn');
    if (sem) setOptions(sem, [...new Set(free.map(x => x[0]))]);
    if (thn) setOptions(thn, [...new Set(free.map(x => x[1]))]);
    // Default berbeda dari periode aktif bila memungkinkan (arsip = periode lama).
    const aktif = (DATA.periode || {}).aktif;
    if (sem && thn && free.length) {
      const lain = tersedia.find(x => aktif && !(x.semester === aktif.semester && x.tahunAjaran === aktif.tahunAjaran));
      const chosen = lain || tersedia[0];
      if (chosen) { sem.value = chosen.semester; thn.value = chosen.tahunAjaran; }
      if (sem.value && thn.value) return void (kelas && kelas.value && loadArchiveStudents(kelas.value));
      // Tidak ada `tersedia` sama sekali → pakai fallback pertama agar tidak kosong.
      sem.value = sem.value || free[0][0]; thn.value = thn.value || free[0][1];
    }
    if (kelas && kelas.value) loadArchiveStudents(kelas.value);
  }
  /** Daftar siswa untuk cetak rapor arsip (baca saja). */
  async function loadArchiveStudents(kelas) {
    const sel = $('#ar-r-siswa');
    if (!kelas || !sel) { if (sel) setOptions(sel, []); return; }
    try {
      const data = await api('getSiswaByKelas', { kelas });
      setOptions(sel, data.map(s => [s.nis, s.nama]), '-Pilih Siswa-');
    } catch (e) { toast(e.message, false); }
  }
  /** Muat tabel nilai arsip (read-only, tanpa satu pun input). */
  async function loadArchive(button) {
    const kelas = $('#ar-kelas').value, semester = $('#ar-sem').value, tahunAjaran = $('#ar-thn').value;
    if (!kelas || !semester || !tahunAjaran) return safeMsg('ar-status', 'Pilih kelas dan periode terlebih dahulu.', false);
    setBusy(button || $('[data-action="loadArchive"]'), true, 'Memuat...');
    try {
      const d = await api('getArchiveNilai', { kelas, semester, tahunAjaran });
      renderArchive(d);
      safeMsg('ar-status', 'Arsip dimuat - ' + d.siswa.length + ' siswa, ' + d.mapel.length + ' mata pelajaran.', true);
      if (kelas) loadArchiveStudents(kelas);
    } catch (e) { safeMsg('ar-status', e.message, false); }
    finally { setBusy(button || $('[data-action="loadArchive"]'), false); }
  }
  /** Render tabel arsip - semuanya textContent, tidak ada kontrol yang bisa diedit. */
  function renderArchive(d) {
    const summary = $('#ar-summary');
    summary.replaceChildren();
    const left = document.createElement('div');
    const name = document.createElement('p'); name.className = 'who'; name.textContent = 'Kelas ' + d.kelas;
    const meta = document.createElement('p'); meta.className = 'meta';
    meta.textContent = 'Arsip ' + d.semester + ' / ' + d.tahunAjaran;
    // Rumus ditulis eksplisit — perhitungan klien tidak boleh terlihat "misterius"
    // apalagi beda dengan rapor (jenis rapor memilih rumus berbeda di server).
    const note = document.createElement('p'); note.className = 'meta';
    note.textContent = 'Nilai akhir = (4 × rata-rata UH + STS) / 5 (tengah semester).';
    left.append(name, meta, note);
    const right = document.createElement('div'); right.className = 'period';
    right.innerHTML = '<span class="badge badge-neutral">ARSIP - HANYA BACA</span>';
    summary.append(left, right);
    summary.classList.remove('hidden');

    const head = $('#ar-table-head'), body = $('#ar-table-body');
    head.replaceChildren(); body.replaceChildren();
    // Komponen nilai diperlihatkan apa adanya (bukan hasil hitung tersembunyi):
    // UH (rata-rata), STS, SAS, lalu nilai akhir.
    const cell = (parent, text, cls) => {
      const td = document.createElement('td'); if (cls) td.className = cls;
      td.textContent = text; parent.appendChild(td); return td;
    };
    const score = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v))) ? '-' : String(Number(v));
    const hasSas = d.siswa.some(s => d.mapel.some(m => score(s.nilai[m.kode]?.sas) !== '-'));
    const cols = hasSas ? 4 : 3;
    const hr = document.createElement('tr');
    const thNis = document.createElement('th'); thNis.rowSpan = 2; thNis.textContent = 'NIS';
    const thNama = document.createElement('th'); thNama.rowSpan = 2; thNama.textContent = 'Nama Siswa';
    hr.append(thNis, thNama);
    d.mapel.forEach(m => { const th = document.createElement('th'); th.className = 'center'; th.colSpan = cols; th.textContent = m.nama; hr.appendChild(th); });
    const hr2 = document.createElement('tr');
    d.mapel.forEach(() => {
      ['UH', 'STS'].concat(hasSas ? ['SAS'] : []).concat(['Akhir']).forEach(label => {
        const th = document.createElement('th'); th.className = 'center'; th.textContent = label; hr2.appendChild(th);
      });
    });
    head.append(hr, hr2);
    const colSpan = 2 + d.mapel.length * cols;
    if (!d.siswa.length) {
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = colSpan; td.className = 'empty-state'; td.textContent = 'Tidak ada siswa di kelas ini.';
      tr.appendChild(td); body.appendChild(tr);
    }
    d.siswa.forEach(s => {
      const tr = document.createElement('tr');
      const tdNis = document.createElement('td'); tdNis.className = 'font-semibold'; tdNis.textContent = s.nis;
      const tdNama = document.createElement('td'); tdNama.textContent = s.nama;
      tr.append(tdNis, tdNama);
      d.mapel.forEach(m => {
        const v = s.nilai[m.kode];
        const uhs = v ? [v.uh1, v.uh2, v.uh3, v.uh4, v.uh5].map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
        const avgRaw = uhs.length ? uhs.reduce((a, b) => a + b, 0) / uhs.length : null;
        cell(tr, avgRaw === null ? '-' : String(Math.round(avgRaw)), 'center');
        cell(tr, v ? score(v.sts) : '-', 'center');
        if (hasSas) cell(tr, v ? score(v.sas) : '-', 'center');
        let akhir = '';
        if (v) {
          const sts = Number(v.sts) || 0;
          // Rumus & pembulatan identik dengan getRaportData_ — pakai avg belum
          // dibulatkan supaya hasil persis sama dengan nilai di rapor.
          akhir = (avgRaw && sts) ? Math.round((4 * avgRaw + sts) / 5) : (avgRaw || sts || '');
        }
        cell(tr, akhir === '' ? '-' : String(akhir), 'center font-semibold');
      });
      body.appendChild(tr);
    });
    $('#ar-table-wrap').classList.remove('hidden');
  }
  /** Preview rapor periode arsip - struktur sama dengan previewRapor, tetapi
   *  membaca filter ARSIP (#ar-*), bukan periode aktif. */
  async function archivePreview(button) {
    const nis = $('#ar-r-siswa').value;
    const semester = $('#ar-sem').value, tahunAjaran = $('#ar-thn').value, jenisRapor = $('#ar-jenis').value;
    if (!nis || !semester || !tahunAjaran) return safeMsg('ar-print-status', 'Pilih siswa dan periode arsip.', false);
    setBusy(button || $('[data-action="archivePreview"]'), true, 'Mengambil preview...');
    try {
      const d = await api('getRaportData', { nis, semester, tahunAjaran, jenisRapor });
      CURRENT_RAPOR_DATA = d;
      const area = $('#ar-preview'); area.replaceChildren();
      const summary = document.createElement('div'); summary.className = 'preview-summary';
      const left = document.createElement('div');
      const nm = document.createElement('p'); nm.className = 'who'; nm.textContent = d.siswa.nama;
      const meta = document.createElement('p'); meta.className = 'meta';
      meta.textContent = 'NIS: ' + d.siswa.nis + '  /  Kelas: ' + d.siswa.kelas + '  /  Arsip (hanya baca)';
      left.append(nm, meta);
      const right = document.createElement('div'); right.className = 'period';
      right.textContent = d.meta.sem + ' / ' + d.meta.thn + ' / ' + d.meta.jenis;
      summary.append(left, right); area.appendChild(summary);
      const table = document.createElement('table'); table.className = 'data-table mb-5';
      const thead = document.createElement('thead');
      thead.innerHTML = '<tr><th>Mata Pelajaran</th><th class="center" style="width:8rem">Nilai Akhir</th><th>Deskripsi Capaian</th></tr>';
      const tbody = document.createElement('tbody');
      (d.nilai || []).forEach(n => {
        const tr = document.createElement('tr');
        [n.mapel, n.nilai, n.capaian].forEach((v, i) => {
          const td = document.createElement('td');
          td.className = (i === 1 ? 'center font-bold text-lg text-[#B06161]' : i === 0 ? 'font-semibold' : 'text-xs text-gray-600 leading-relaxed');
          td.textContent = v; tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.append(thead, tbody); area.appendChild(table);
      const sign = document.createElement('label'); sign.className = 'sign-check';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.id = 'ar-ttd';
      sign.append(checkbox, document.createTextNode('Tampilkan Tanda Tangan Wali Kelas (' + d.waliKelas + ')'));
      area.appendChild(sign);
      const one = document.createElement('button'); one.type = 'button'; one.className = 'btn-primary btn-block';
      one.dataset.action = 'archivePrint';
      one.innerHTML = '<i class="fas fa-file-pdf mr-2" aria-hidden="true"></i> Buat & Buka PDF Rapor Arsip';
      area.appendChild(one);
      const all = document.createElement('button'); all.type = 'button'; all.className = 'btn-secondary btn-block mt-3';
      all.dataset.action = 'archiveBulkPrint';
      all.innerHTML = '<i class="fas fa-copy mr-2" aria-hidden="true"></i> Cetak Semua Rapor Kelas ' + esc(d.siswa.kelas) + ' periode ini';
      area.appendChild(all);
      area.classList.remove('hidden');
      safeMsg('ar-print-status', 'Preview periode arsip siap.', true);
    } catch (e) { safeMsg('ar-print-status', e.message, false); }
    finally { setBusy(button || $('[data-action="archivePreview"]'), false); }
  }
  /** Buat PDF satu siswa untuk periode arsip (menulis file BARU ke Drive). */
  async function archivePrint(button) {
    if (!CURRENT_RAPOR_DATA) return safeMsg('ar-print-status', 'Ambil preview terlebih dahulu.', false);
    const data = CURRENT_RAPOR_DATA;
    const withSignature = $('#ar-ttd') ? $('#ar-ttd').checked : false;
    setBusy(button || $('[data-action="archivePrint"]'), true, 'Membuat PDF...');
    try {
      const result = await api('generatePdf', {
        nis: data.siswa.nis, semester: data.meta.sem, tahunAjaran: data.meta.thn,
        jenisRapor: data.meta.jenis, withSignature: withSignature
      });
      if (!result.url) throw new Error('Server tidak mengembalikan URL PDF.');
      window.open(result.url, '_blank', 'noopener');
      safeMsg('ar-print-status', 'PDF arsip dibuat.', true);
    } catch (e) { safeMsg('ar-print-status', e.message, false); }
    finally { setBusy(button || $('[data-action="archivePrint"]'), false); }
  }
  /** Buat PDF seluruh kelas untuk periode arsip. */
  async function archiveBulkPrint(button) {
    const kelas = $('#ar-kelas').value, semester = $('#ar-sem').value, tahunAjaran = $('#ar-thn').value;
    const jenisRapor = $('#ar-jenis').value;
    if (!kelas || !semester || !tahunAjaran) return safeMsg('ar-print-status', 'Pilih kelas dan periode.', false);
    const withSignature = $('#ar-ttd') ? $('#ar-ttd').checked : false;
    setBusy(button || $('[data-action="archiveBulkPrint"]'), true, 'Membuat PDF...');
    try {
      const result = await api('generateAllPdf', { kelas, semester, tahunAjaran, jenisRapor, withSignature }, { timeout: 360000 });
      safeMsg('ar-print-status', result.generated + ' berhasil, ' + result.failed + ' gagal.', true);
      if (result.url) window.open(result.url, '_blank', 'noopener');
      if (result.errors && result.errors.length) console.warn('Kesalahan cetak PDF:', result.errors);
    } catch (e) { safeMsg('ar-print-status', e.message, false); }
    finally { setBusy(button || $('[data-action="archiveBulkPrint"]'), false); }
  }

  // ------------------------------------------- Periode aktif (Operator/Admin)
  async function setActivePeriod(button) {
    const semester = $('#ap-sem').value, tahunAjaran = $('#ap-thn').value;
    if (!semester || !tahunAjaran) return safeMsg('ap-status', 'Pilih semester dan tahun ajaran.', false);
    const aktif = (DATA.periode || {}).aktif;
    if (aktif && aktif.semester === semester && aktif.tahunAjaran === tahunAjaran) {
      return safeMsg('ap-status', 'Periode itu sudah aktif.', false);
    }
    const before = aktif ? aktif.semester + ' ' + aktif.tahunAjaran : '(belum ditetapkan)';
    const pesan = 'Jadikan ' + semester + ' ' + tahunAjaran + ' sebagai periode aktif?\n\n'
      + 'Sebelumnya: ' + before + '\nSeluruh guru & wali kelas akan menulis ke periode baru mulai sekarang; '
      + 'periode lain berubah jadi arsip (hanya baca).';
    if (!await confirmBar(pesan, 'Jadikan Periode Aktif')) return;
    setBusy(button || $('[data-action="setActivePeriod"]'), true, 'Menyimpan...');
    try {
      const r = await api('setActivePeriod', { semester, tahunAjaran });
      DATA.periode = DATA.periode || {};
      DATA.periode.aktif = r.aktif;
      applyPeriods();
      safeMsg('ap-status', 'Periode aktif: ' + r.aktif.semester + ' ' + r.aktif.tahunAjaran + '. Berlaku untuk semua pengguna.', true);
    } catch (e) { safeMsg('ap-status', e.message, false); }
    finally { setBusy(button || $('[data-action="setActivePeriod"]'), false); }
  }

  // ------------------------------------------------------------ Password
  async function changePw(button) {
    const oldPassword=$('#pw-old').value,newPassword=$('#pw-new').value,confirmPassword=$('#pw-conf').value;
    if(!oldPassword||!newPassword||!confirmPassword) return safeMsg('p7-msg','Isi semua kolom.',false);
    if(newPassword!==confirmPassword) return safeMsg('p7-msg','Konfirmasi password tidak cocok.',false);
    if(newPassword.length<10) return safeMsg('p7-msg','Password baru minimal 10 karakter.',false);
    setBusy(button||$('[data-action="changePw"]'),true,'Mengubah password…');
    try {
      await api('changePassword',{oldPassword,newPassword}); clearSession(); USER=null;
      safeMsg('p7-msg','Password berubah. Silakan login kembali dengan password baru.',true);
      setTimeout(()=>location.reload(),1500);
    } catch(e) { safeMsg('p7-msg',e.message,false); }
    finally { setBusy(button||$('[data-action="changePw"]'),false); }
  }

  // ------------------------------------------------------------ Monitoring
  async function loadMonitoring(button) {
    const kelas=$('#m-kelas').value,semester=$('#m-sem').value,tahun=$('#m-thn').value;
    if(!kelas||!semester||!tahun) return toast('Pilih kelas, semester, dan tahun.',false);
    setBusy(button||$('[data-action="loadMonitoring"]'),true,'Memuat leger…');
    try {
      const data=await api('getMonitoringData',{kelas,semester,tahun});
      const head=$('#m-table-head'),body=$('#m-table-body');
      head.replaceChildren();body.replaceChildren();
      if(!data.siswa||!data.siswa.length) { const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=100;td.className='empty-state';td.textContent='Belum ada data untuk kelas/periode ini.';tr.appendChild(td);body.appendChild(tr);return; }
      const hr=document.createElement('tr');
      ['NIS','Nama Siswa',...(data.codes||[]).map(c=>c), 'S','I','A','Ekstrakurikuler'].forEach((label,i)=>{const th=document.createElement('th');th.className=(i===1?'sticky sticky-end':'')+(i>=2&&i<2+(data.codes||[]).length?' center':'');th.textContent=label;if(i>=2&&i<2+(data.codes||[]).length)th.title=data.names[label]||label;hr.appendChild(th);});head.appendChild(hr);
      data.siswa.forEach(s=>{const tr=document.createElement('tr');
        const add=(v,cls)=>{const td=document.createElement('td');td.className=(cls||'')+(v===null||v===undefined?'':'');td.textContent=v===null||v===undefined?'':String(v);tr.appendChild(td);};
        add(s.nis,'center');add(s.nama,'font-semibold sticky sticky-end');
        (data.codes||[]).forEach(c=>{const v=s.nilai[c];if(!v){const td=document.createElement('td');td.className='center font-bold text-red-400';td.textContent='×';td.setAttribute('aria-label','Belum diisi');tr.appendChild(td);}else add(v,'center');});
        add(s.absen.s,'center col-sts');add(s.absen.i,'center');add(s.absen.a,'center col-sas');add(s.ekskul,'text-xs');body.appendChild(tr);
      });
    } catch(e) { toast(e.message,false); }
    finally { setBusy(button||$('[data-action="loadMonitoring"]'),false); }
  }

  // ------------------------------------------------ Operator: data siswa
  function siswaFormOptions(kelas) {
    const classes = DATA.kelas || [];
    const sel = $('#w-kelas-input'); if (!sel) return;
    setOptions(sel, classes, '-Pilih Kelas-');
    if (kelas !== undefined && kelas !== null) sel.value = kelas;
  }
  async function loadSiswaList(button) {
    const kelas = $('#w-kelas')?.value || '';
    setBusy(button || $('[data-action="loadSiswaList"]'), true, 'Memuat…');
    try {
      const data = await api('getSiswaList', { kelas });
      const body = $('#w-table-body'); body.replaceChildren();
      if (!data.length) {
        const tr = document.createElement('tr'); const td = document.createElement('td');
        td.colSpan = 6; td.className = 'empty-state'; td.textContent = 'Belum ada siswa.';
        tr.appendChild(td); body.appendChild(tr); return;
      }
      data.forEach(s => {
        const tr = document.createElement('tr');
        tr.dataset.siswaNis = s.nis; // sengaja BUKAN data-nis (hindari tabrakan selector tabel nilai)
        const cell = (v, cls) => { const td = document.createElement('td'); td.className = cls || ''; td.textContent = v; return td; };
        const lulus = String(s.status || 'Aktif').toUpperCase() === 'LULUS';
        tr.append(cell(s.nis, 'font-semibold'), cell(s.nisn, 'text-gray-500'), cell(s.nama), cell(s.kelas || '—', 'center'));
        const st = document.createElement('td'); st.className = 'center';
        const badge = document.createElement('span');
        badge.className = 'badge ' + (lulus ? 'badge-neutral' : 'badge-ok');
        badge.textContent = lulus ? 'Lulus' : 'Aktif';
        st.appendChild(badge); tr.appendChild(st);
        const act = document.createElement('td'); act.className = 'center';
        const btn = document.createElement('button');
        btn.type = 'button'; btn.dataset.action = 'editSiswa'; btn.dataset.nis = s.nis;
        btn.className = 'btn-secondary'; btn.style.minHeight = '34px'; btn.style.padding = '.3rem .8rem';
        btn.textContent = 'Ubah';
        act.appendChild(btn); tr.appendChild(act);
        body.appendChild(tr);
      });
    } catch (e) { safeMsg('w-status', e.message, false); }
    finally { setBusy(button || $('[data-action="loadSiswaList"]'), false); }
  }
  function editSiswa(button) {
    const nis = button.dataset.nis;
    const row = $('#w-table-body tr[data-siswa-nis="' + CSS.escape(nis) + '"]');
    if (!row) return;
    const cells = row.children;
    $('#w-nis').value = cells[0].textContent;
    $('#w-nisn').value = cells[1].textContent === '—' ? '' : cells[1].textContent;
    $('#w-nama').value = cells[2].textContent;
    siswaFormOptions(cells[3].textContent === '—' ? '' : cells[3].textContent);
    $('#w-nis').readOnly = true; // NIS tidak bisa diubah — kunci nilai/absensi
    $('#w-nama').focus();
    toast('Mode ubah siswa ' + nis + '. NIS dikunci.', true);
  }
  function resetSiswaForm() {
    $('#w-nis').value = ''; $('#w-nisn').value = ''; $('#w-nama').value = '';
    $('#w-nis').readOnly = false;
    siswaFormOptions('');
    $('#w-nis').focus();
  }
  async function saveSiswa(button) {
    const nis = $('#w-nis').value.trim();
    const kelas = $('#w-kelas-input').value;
    if (!nis || !$('#w-nama').value.trim() || !kelas) return safeMsg('w-status', 'Isi NIS, nama, dan kelas.', false);
    const editing = $('#w-nis').readOnly; // true saat diisi lewat tombol Ubah
    const row = { nis, nisn: $('#w-nisn').value.trim(), nama: $('#w-nama').value.trim(), kelas };
    if (editing) row.originalNis = nis;
    setBusy(button || $('[data-action="saveSiswa"]'), true, 'Menyimpan…');
    try {
      const r = await api('saveSiswa', { rows: [row] });
      safeMsg('w-status', 'Tersimpan (' + r.added + ' tambah, ' + r.updated + ' ubah).', true);
      resetSiswaForm(); await loadSiswaList();
    } catch (e) { safeMsg('w-status', e.message, false); }
    finally { setBusy(button || $('[data-action="saveSiswa"]'), false); }
  }

  // ---------------------------------------------- Operator: promosi kelas
  function promotionOptions() {
    const classes = DATA.kelas || [];
    const asal = $('#pr-asal'); if (asal) setOptions(asal, classes, '-Pilih Kelas Asal-');
    const tujuan = $('#pr-tujuan');
    if (tujuan) {
      setOptions(tujuan, classes, '-Pilih Tujuan-');
      const opt = document.createElement('option');
      opt.value = 'Lulus'; opt.textContent = 'Lulus (tandai kelulusan)';
      tujuan.appendChild(opt);
    }
  }
  async function previewPromotion(button) {
    const asal = $('#pr-asal').value, tujuan = $('#pr-tujuan').value;
    if (!asal || !tujuan) return safeMsg('pr-status', 'Pilih kelas asal dan tujuan terlebih dahulu.', false);
    if (tujuan === asal) return safeMsg('pr-status', 'Kelas tujuan sama dengan kelas asal.', false);
    setBusy(button || $('[data-action="previewPromotion"]'), true, 'Menyiapkan pratinjau…');
    try {
      const data = await api('getSiswaList', { kelas: asal });
      const body = $('#pr-table-body'); body.replaceChildren();
      const toLulus = tujuan.toUpperCase() === 'LULUS';
      let aktif = 0, lulus = 0;
      if (!data.length) {
        const tr = document.createElement('tr'); const td = document.createElement('td');
        td.colSpan = 5; td.className = 'empty-state'; td.textContent = 'Tidak ada siswa di kelas ini.';
        tr.appendChild(td); body.appendChild(tr);
      }
      data.forEach(s => {
        const isLulus = String(s.status || 'Aktif').toUpperCase() === 'LULUS';
        isLulus ? lulus++ : aktif++;
        const tr = document.createElement('tr');
        tr.dataset.prNis = s.nis;
        tr.dataset.prLulus = isLulus ? '1' : '0';
        const cell = (v, cls) => { const td = document.createElement('td'); td.className = cls || ''; td.textContent = v; return td; };
        const pick = document.createElement('td'); pick.className = 'center';
        if (!isLulus) {
          const cb = document.createElement('input');
          cb.type = 'checkbox'; cb.checked = true; cb.dataset.prPick = '1';
          cb.setAttribute('aria-label', 'Ikut promosi — ' + s.nama);
          cb.addEventListener('change', updatePromotionSummary);
          pick.appendChild(cb);
        } else {
          pick.textContent = '—';
        }
        tr.append(pick, cell(s.nis), cell(s.nama), cell(asal), cell(isLulus ? 'Lulus' : 'Aktif', 'center'));
        body.appendChild(tr);
      });
      $('#pr-preview').classList.remove('hidden');
      updatePromotionSummary();
      safeMsg('pr-status', 'Pratinjau siap. Hilangkan centang untuk mengecualikan siswa.', true);
    } catch (e) { safeMsg('pr-status', e.message, false); }
    finally { setBusy(button || $('[data-action="previewPromotion"]'), false); }
  }
  function updatePromotionSummary() {
    const rows = [...document.querySelectorAll('#pr-table-body tr[data-pr-nis]')];
    const aktif = rows.filter(r => r.dataset.prLulus === '0');
    const pilih = aktif.filter(r => { const cb = r.querySelector('input'); return cb && cb.checked; });
    const toLulus = ($('#pr-tujuan').value || '').toUpperCase() === 'LULUS';
    $('#pr-summary').textContent =
      'Kelas ' + ($('#pr-asal').value || '?') + ' → ' + ($('#pr-tujuan').value || '?') +
      ' · aktif: ' + aktif.length +
      ' · ikut: ' + pilih.length +
      ' · dikecualikan: ' + (aktif.length - pilih.length) +
      ' · sudah lulus: ' + (rows.length - aktif.length) +
      (toLulus ? ' · NIS & kelas tidak berubah' : ' · NIS tidak berubah');
  }
  async function commitPromotion(button) {
    const asal = $('#pr-asal').value, tujuan = $('#pr-tujuan').value;
    const rows = [...document.querySelectorAll('#pr-table-body tr[data-pr-nis]')];
    if (!rows.length) return safeMsg('pr-status', 'Jalankan Pratinjau terlebih dahulu.', false);
    const aktif = rows.filter(r => r.dataset.prLulus === '0');
    const ikut = aktif.filter(r => { const cb = r.querySelector('input'); return cb && cb.checked; }).map(r => r.dataset.prNis);
    const exclude = aktif.filter(r => !ikut.includes(r.dataset.prNis)).map(r => r.dataset.prNis);
    if (!ikut.length) return safeMsg('pr-status', 'Tidak ada siswa yang dipilih.', false);
    const ke = tujuan === 'Lulus' ? 'ditandai LULUS (kelas & NIS tetap)' : 'dipindah ke kelas ' + tujuan;
    const pesan = 'Kelas ' + asal + ': ' + ikut.length + ' siswa ' + ke + '.\n' +
      'Dikecualikan: ' + exclude.length + ' · sudah lulus: ' + (rows.length - aktif.length) + '.\n\n' +
      'NIS tidak berubah, jadi nilai & absensi tetap terhubung.\n' +
      'Cetak rapor periode lama SEBELUM melanjutkan.\n\nLanjutkan?';
    if (!await confirmBar(pesan, 'Jalankan Promosi')) return;
    setBusy(button || $('[data-action="commitPromotion"]'), true, 'Memproses…');
    try {
      const r = await api('promoteClassStudents', { kelasAsal: asal, tujuan, exclude });
      safeMsg('pr-status', r.diproses + ' diproses, ' + r.dikecualikan + ' dikecualikan, ' + r.sudahLulus + ' sudah lulus.', true);
      $('#pr-preview').classList.add('hidden');
      await loadSiswaList();
    } catch (e) { safeMsg('pr-status', e.message, false); }
    finally { setBusy(button || $('[data-action="commitPromotion"]'), false); }
  }

  // ------------------------------------------------ Operator: akun & role
  async function loadAccounts() {
    try {
      const data = await api('getAssignmentList');
      window.__PLOT_MAPEL = data.mapel;
      const body = $('#ak-table-body'); body.replaceChildren();
      data.accounts.forEach(a => {
        const tr = document.createElement('tr');
        const cell = (v, cls) => { const td = document.createElement('td'); td.className = cls || ''; td.textContent = v; return td; };
        const isSelf = a.username.toLowerCase() === USER.username.toLowerCase();
        tr.append(cell(a.username, 'font-semibold'), cell(a.name, 'text-gray-500'), cell(a.role, 'center'), cell(a.kelas || '—', 'center'));
        const act = document.createElement('td'); act.className = 'center';
        const btn = document.createElement('button');
        btn.type = 'button'; btn.textContent = 'Pilih';
        btn.className = 'btn-secondary'; btn.style.minHeight = '34px'; btn.style.padding = '.3rem .8rem';
        btn.title = isSelf ? 'Akun sendiri tidak bisa dirubah/reset' : 'Isi form reset & role dengan akun ini';
        btn.disabled = isSelf;
        btn.addEventListener('click', () => {
          $('#ak-username').value = a.username; $('#ak-role-user').value = a.username;
          $('#ak-role').value = a.role; $('#ak-kelas').value = a.kelas;
        });
        act.appendChild(btn); tr.appendChild(act);
        body.appendChild(tr);
      });
      const users = data.accounts.map(a => [a.username, a.username + ' (' + a.role + ')']);
      const plUser = $('#pl-user'); if (plUser) setOptions(plUser, users, '-Pilih Username-');
      const plKelas = $('#pl-kelas'); if (plKelas) setOptions(plKelas, data.classes, '-Pilih Kelas-');
      const akRole = $('#ak-role'); if (akRole) setOptions(akRole, data.roles, '-Pilih Role-');
      const akKelas = $('#ak-kelas'); if (akKelas) setOptions(akKelas, data.classes, '-Tanpa Kelas-');
      const wKelas = $('#w-kelas'); if (wKelas) { setOptions(wKelas, data.classes, 'Semua Kelas'); if (!wKelas.value) loadSiswaList(); }
      const wIn = $('#w-kelas-input'); if (wIn) setOptions(wIn, data.classes, '-Pilih Kelas-');
      const plBody = $('#pl-table-body');
      if (plBody) {
        plBody.replaceChildren();
        if (!data.assignments.length) { const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=3;td.className='empty-state';td.textContent='Belum ada penugasan.';tr.appendChild(td);plBody.appendChild(tr); }
        data.assignments.forEach(a => {
          const tr = document.createElement('tr');
          [a.username, a.kelas, a.kodeMapel].forEach((v,i) => { const td=document.createElement('td'); td.className = i===0 ? 'font-semibold' : ''; td.textContent = v; tr.appendChild(td); });
          plBody.appendChild(tr);
        });
      }
    } catch (e) { toast(e.message, false); }
  }
  async function resetAccountFlag(button) {
    const username = $('#ak-username').value.trim();
    if (!username) return safeMsg('ak-status', 'Isi akun target.', false);
    if (!await confirmBar('Tandai akun "' + username + '" wajib ganti password saat login berikutnya?', 'Tandai')) return;
    setBusy(button || $('[data-action="resetAccountFlag"]'), true, 'Menandai…');
    try { await api('resetAccount', { username, mode: 'flag' }); safeMsg('ak-status', 'Akun ditandai wajib reset.', true); await loadAccounts(); }
    catch (e) { safeMsg('ak-status', e.message, false); }
    finally { setBusy(button || $('[data-action="resetAccountFlag"]'), false); }
  }
  async function resetAccountTemp(button) {
    const username = $('#ak-username').value.trim();
    const temp = $('#ak-temp').value.trim();
    if (!username) return safeMsg('ak-status', 'Isi akun target.', false);
    if (temp.length < 10) return safeMsg('ak-status', 'Password sementara minimal 10 karakter.', false);
    if (!await confirmBar('Setel password sementara untuk "' + username + '"? Password tampil sekali — salin sekarang.', 'Setel Password')) return;
    setBusy(button || $('[data-action="resetAccountTemp"]'), true, 'Menyetel…');
    try {
      const r = await api('resetAccount', { username, mode: 'temporary', temporaryPassword: temp });
      safeMsg('ak-status', 'Password sementara disetel — salin sekarang (tidak bisa dilihat lagi).', true);
      const box = $('#ak-temp-result');
      box.replaceChildren();
      box.append('Password sementara untuk ' + r.username + ': ');
      const code = document.createElement('code'); code.textContent = r.temporaryPassword;
      box.append(code, ' — catat dan sampaikan secara aman, lalu minta ia menggantinya saat login.');
      box.classList.remove('hidden');
      $('#ak-temp').value = '';
      await loadAccounts();
    } catch (e) { safeMsg('ak-status', e.message, false); }
    finally { setBusy(button || $('[data-action="resetAccountTemp"]'), false); }
  }
  async function saveUserAccount(button) {
    const username = $('#ak-role-user').value.trim();
    const role = $('#ak-role').value, kelas = $('#ak-kelas').value;
    if (!username || !role) return safeMsg('ak-status', 'Isi akun target dan role.', false);
    setBusy(button || $('[data-action="saveUserAccount"]'), true, 'Menyimpan…');
    try {
      const r = await api('updateUserAccount', { username, role, kelas });
      safeMsg('ak-status', 'Akun ' + r.username + ' → ' + r.role + (r.kelas ? ' (' + r.kelas + ')' : '') + '.', true);
      await loadAccounts();
    } catch (e) { safeMsg('ak-status', e.message, false); }
    finally { setBusy(button || $('[data-action="saveUserAccount"]'), false); }
  }

  // ------------------------------------------------ Operator: penugasan
  async function saveAssignment(button) {
    const username = $('#pl-user').value, kelas = $('#pl-kelas').value, kodeMapel = $('#pl-mapel').value;
    if (!username || !kelas || !kodeMapel) return safeMsg('pl-status', 'Lengkapi username, kelas, dan mapel.', false);
    setBusy(button || $('[data-action="saveAssignment"]'), true, 'Menyimpan…');
    try {
      const r = await api('saveAssignment', { rows: [{ username, kelas, kodeMapel }] });
      safeMsg('pl-status', 'Penugasan ditambahkan (' + r.added + ').', true);
      await loadAccounts();
    } catch (e) { safeMsg('pl-status', e.message, false); }
    finally { setBusy(button || $('[data-action="saveAssignment"]'), false); }
  }

  // ------------------------------------------------ Waka: rekap progres
  function progressGroup(title, items, labelKey, subKey) {
    const card = document.createElement('div'); card.className = 'status-card';
    const head = document.createElement('div'); head.className = 'status-card-head';
    const t = document.createElement('span'); t.textContent = title; head.appendChild(t); card.appendChild(head);
    const ul = document.createElement('ul');
    items.forEach(it => {
      const li = document.createElement('li'); li.className = 'status-row';
      const left = document.createElement('div');
      const name = document.createElement('span'); name.className = 'name'; name.textContent = it[labelKey];
      left.appendChild(name);
      if (subKey && it[subKey]) {
        const sub = document.createElement('div'); sub.style.cssText = 'font-size:.7rem;color:var(--ink-3)';
        sub.textContent = Array.isArray(it[subKey]) ? it[subKey].join(', ') : String(it[subKey]) + (it.kelas ? ' · ' + it.kelas : '');
        left.appendChild(sub);
      }
      const right = document.createElement('div'); right.style.cssText = 'display:flex;align-items:center;gap:.5rem';
      const badge = document.createElement('span');
      badge.className = 'badge ' + (it.persen === 100 ? 'badge-ok' : it.persen >= 70 ? 'badge-warn' : 'badge-bad');
      badge.textContent = it.persen + '%';
      const detail = document.createElement('span'); detail.style.cssText = 'font-size:.72rem;color:var(--ink-3)';
      detail.textContent = it.terisi + '/' + it.total;
      right.append(badge, detail);
      li.append(left, right); ul.appendChild(li);
    });
    card.appendChild(ul);
    return card;
  }
  /** Grup mapel: SATU baris agregat per mapel + rincian per kelas yang SELALU
   *  terlihat di bawahnya (tanpa tombol lipat — keputusan desain pemilik). */
  function progressSubjectGroup(title, items) {
    const card = document.createElement('div'); card.className = 'status-card';
    const head = document.createElement('div'); head.className = 'status-card-head';
    const t = document.createElement('span'); t.textContent = title; head.appendChild(t); card.appendChild(head);
    const ul = document.createElement('ul');
    items.forEach(m => {
      const li = document.createElement('li');
      li.style.cssText = 'padding:.55rem 1rem;border-bottom:1px solid #F0EFED';
      // baris agregat
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:.75rem';
      const left = document.createElement('div');
      const name = document.createElement('span'); name.className = 'name'; name.textContent = m.nama;
      const code = document.createElement('span');
      code.style.cssText = 'font-size:.7rem;color:var(--ink-3);margin-left:.5rem';
      code.textContent = m.kode;
      left.append(name, code);
      const right = document.createElement('div');
      right.style.cssText = 'display:flex;align-items:center;gap:.5rem';
      const badge = document.createElement('span');
      badge.className = 'badge ' + (m.persen === 100 ? 'badge-ok' : m.persen >= 70 ? 'badge-warn' : 'badge-bad');
      badge.textContent = m.persen + '%';
      const detail = document.createElement('span');
      detail.style.cssText = 'font-size:.72rem;color:var(--ink-3)';
      detail.textContent = m.terisi + '/' + m.total;
      right.append(badge, detail);
      row.append(left, right);
      li.appendChild(row);
      // rincian per kelas — selalu terlihat
      const list = document.createElement('ul');
      list.style.cssText = 'list-style:none;margin:.35rem 0 0;padding:0 0 0 .9rem;border-left:2px solid var(--border)';
      (m.perKelas || []).forEach(pk => {
        const sub = document.createElement('li');
        sub.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.15rem 0;font-size:.75rem;color:var(--ink-2)';
        const kl = document.createElement('span'); kl.textContent = pk.kelas;
        const rightSub = document.createElement('span');
        rightSub.style.cssText = 'display:flex;align-items:center;gap:.5rem';
        const b = document.createElement('span');
        b.className = 'badge ' + (pk.persen === 100 ? 'badge-ok' : pk.persen >= 70 ? 'badge-warn' : 'badge-bad');
        b.style.fontSize = '.6rem';
        b.textContent = pk.persen + '%';
        const d = document.createElement('span');
        d.style.cssText = 'font-size:.7rem;color:var(--ink-3)';
        d.textContent = pk.terisi + '/' + pk.total;
        rightSub.append(b, d);
        sub.append(kl, rightSub);
        list.appendChild(sub);
      });
      li.appendChild(list);
      ul.appendChild(li);
    });
    card.appendChild(ul);
    return card;
  }
  async function loadProgressSummary(button) {
    const semester = $('#sum-sem').value, tahunAjaran = $('#sum-thn').value;
    if (!semester || !tahunAjaran) return toast('Pilih semester dan tahun.', false);
    setBusy(button || $('[data-action="loadProgressSummary"]'), true, 'Memuat rekap…');
    try {
      const d = await api('getProgressSummary', { semester, tahunAjaran });
      const area = $('#sum-area'); area.replaceChildren();
      if (!d.kelas.length && !d.mapel.length && !d.guru.length) { area.textContent = 'Belum ada data untuk periode ini.'; return; }
      // Ringkasan keseluruhan (sel terisi / sel mungkin) di atas.
      if (d.ringkas && d.ringkas.total >= 0) {
        const box = document.createElement('div');
        box.className = 'stat-card';
        box.style.marginBottom = '1rem';
        const lbl = document.createElement('p'); lbl.className = 'label'; lbl.textContent = 'Rekap Seluruh Kelas';
        const val = document.createElement('p'); val.className = 'value';
        val.textContent = d.ringkas.persen + '%';
        const det = document.createElement('p');
        det.style.cssText = 'font-size:.75rem;color:var(--ink-3);margin:.2rem 0 0';
        det.textContent = d.ringkas.terisi + ' dari ' + d.ringkas.total + ' sel terisi' +
          (d.ringkas.unmatched ? ' · ' + d.ringkas.unmatched + ' baris nilai di luar hitungan' : '');
        box.append(lbl, val, det);
        area.appendChild(box);
      }
      area.append(
        progressGroup('Per Kelas', d.kelas, 'kelas'),
        progressSubjectGroup('Per Mata Pelajaran', d.mapel),
        progressGroup('Per Guru', d.guru, 'username', 'mapel')
      );
    } catch (e) { toast(e.message, false); }
    finally { setBusy(button || $('[data-action="loadProgressSummary"]'), false); }
  }

  // ---------------------------------------------------------------- Exports
  window.handleLogin=handleLogin;
  window.handleLogout=handleLogout;
  window.toggleSidebar=toggleSidebar;
  window.submitPasswordReset=submitPasswordReset;
  window.saveCapaian=saveCapaian;
  window.saveNilaiManual=saveNilaiManual;
  window.uploadNilai=uploadNilai;
  window.saveAbsen=saveAbsen;
  window.saveEkstra=saveEkstra;
  window.loadStatus=loadStatus;
  window.previewRapor=previewRapor;
  window.doPrint=doPrint;
  window.bulkPrint=bulkPrint;
  window.changePw=changePw;
  window.loadMonitoring=loadMonitoring;
  window.switchNilaiView=switchNilaiView;
  window.nav=nav;
})();
