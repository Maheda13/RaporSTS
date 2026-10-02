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
      if (sem) setOptions(sem, ['Ganjil','Genap']);
      if (year) setOptions(year, [...new Set(PERIOD_OPTIONS.map(x => x[1]))]);
    });
  }

  function resetSessionExpired(err) {
    USER = null; DATA = {};
    $('#app-view').classList.add('hidden');
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

    if (isAuthenticated()) {
      try {
        USER = await api('validateSession', {}, { timeout: 15000 });
        setSession(window.ERAPOR.getToken(), USER);
        enterApp();
        return;
      } catch (e) {
        clearSession();
        if (e.code === 'AUTH_EXPIRED' || e.code === 'AUTH_REQUIRED') {
          resetSessionExpired(e);
          return;
        }
        // Network/CORS errors: do NOT show cached profile as authenticated.
        $('#login-view').classList.remove('hidden');
        $('#login-error').classList.remove('hidden');
        $('#login-error').textContent = e.message + ' Coba lagi saat koneksi pulih.';
        return;
      }
    }
    $('#login-view').classList.remove('hidden');
  }

  function bindEvents() {
    // React to normal user interaction + delegated events from all dropdowns.
    document.addEventListener('change', e => {
      const id = e.target && e.target.id;
      if (!id) return;
      if (id === 'c-kelas') updateSubjects(e.target.value, 'c-mapel');
      if (id === 'n-kelas') { updateSubjects(e.target.value, 'n-mapel'); checkAndLoadNilai(); }
      if (['n-mapel','n-sem','n-thn'].includes(id)) checkAndLoadNilai();
      if (id === 'a-kelas' || id === 'a-sem' || id === 'a-thn') loadAbsen();
      if (id === 'e-kelas' || id === 'e-sem' || id === 'e-thn') loadEkstra();
      if (id === 'r-kelas') loadSiswa(e.target.value);
      if (id === 'c-mapel') loadCapaian();
      if (id === 'm-kelas' || id === 'm-sem' || id === 'm-thn') { /* explicit button */ }
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
      saveUserAccount, loadAccounts, saveAssignment, loadProgressSummary
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
        setSession(result.token, result.user); USER = result.user; enterApp();
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
      setSession(result.token, result.user); USER = result.user; enterApp();
    } catch (e) { status.textContent = e.message; }
    finally { setBusy(button, false); }
  }

  async function handleLogout() {
    try { if (isAuthenticated()) await api('logout', {}, { timeout: 10000 }); }
    catch (_) { /* hapus token lokal walau server tak terjangkau */ }
    clearSession(); USER = null; DATA = {};
    location.reload();
  }

  async function enterApp() {
    $('#login-view').classList.add('hidden'); $('#reset-view')?.classList.add('hidden'); $('#app-view').classList.remove('hidden');
    const name = USER.fullName || USER.username;
    $('#display-username').textContent = name; $('#dash-greeting-name').textContent = name;
    $('#display-role').textContent = USER.role;
    $('#user-avatar').src = 'https://ui-avatars.com/api/?name=' + encodeURIComponent(name) + '&background=B06161&color=fff';
    $('#profile-button').setAttribute('aria-label', 'Pengaturan akun ' + name);
    $('#menu-admin').classList.toggle('hidden', USER.role !== 'Admin');
    // Rekap progres hanya untuk pemantau (Waka Kurikulum & Admin).
    $('#dash-progress')?.classList.toggle('hidden', !(USER.role === 'Waka Kurikulum' || USER.role === 'Admin'));
    buildMenu(USER.role);
    try {
      DATA = await api('getInitialData');
      popDrops();
      await loadDash();
    } catch (e) { toast(e.message, false); }
  }

  // -------------------------------------------------------------- Navigation
  const MENUS = {
    'Guru Mapel': [
      ['p-dashboard','fas fa-home','Dashboard'], ['p-capaian','fas fa-book','Input Capaian'],
      ['p-nilai','far fa-file-alt','Input Nilai'], ['p-status','fas fa-chart-line','Status Nilai']
    ],
    'Wali Kelas': [
      ['p-dashboard','fas fa-home','Dashboard'], ['p-absen','fas fa-user-clock','Absensi'],
      ['p-ekstra','fas fa-running','Ekstrakurikuler'], ['p-cetak','fas fa-print','Cetak Rapor']
    ],
    'Admin': [
      ['p-dashboard','fas fa-home','Dashboard'], ['p-capaian','fas fa-book','Input Capaian'],
      ['p-nilai','far fa-file-alt','Input Nilai'], ['p-absen','fas fa-user-clock','Absensi'],
      ['p-ekstra','fas fa-running','Ekstrakurikuler'], ['p-status','fas fa-chart-line','Status Nilai'],
      ['p-cetak','fas fa-print','Cetak Rapor'], ['p-siswa','fas fa-user-graduate','Data Siswa'],
      ['p-akun','fas fa-user-shield','Akun & Reset'], ['p-plotting','fas fa-diagram-project','Penugasan']
    ],
    'Operator': [
      ['p-dashboard','fas fa-home','Dashboard'], ['p-siswa','fas fa-user-graduate','Data Siswa'],
      ['p-akun','fas fa-user-shield','Akun & Reset'], ['p-plotting','fas fa-diagram-project','Penugasan'],
      ['p-status','fas fa-chart-line','Status Nilai']
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
    nav('p-dashboard');
  }
  function nav(id) {
    if (gradeDirty && id !== 'p-nilai' && !confirm('Ada perubahan nilai yang belum disimpan. Tinggalkan halaman?')) return;
    $$('.page-section').forEach(el => el.classList.add('hidden'));
    const page = document.getElementById(id); if (!page) return;
    page.classList.remove('hidden'); $('#page-title').textContent = id.replace('p-','').replace(/-/g,' ').toUpperCase();
    $$('.nav-item').forEach(el => { el.classList.remove('active-nav'); el.removeAttribute('aria-current'); });
    ['#link-','#toplink-'].forEach(sel => {
      const link = $(sel + id);
      if (link) { link.classList.add('active-nav'); link.setAttribute('aria-current','page'); }
    });
    if (innerWidth < 768) closeSidebar();
    if (id === 'p-akun' || id === 'p-plotting') loadAccounts();
    if (id === 'p-siswa') loadSiswaList();
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
  }
  async function loadDash() {
    try {
      const s = await api('getDashboardStats');
      $('#dash-siswa').textContent = s.siswa; $('#dash-kelas').textContent = s.kelas;
      $('#dash-mapel').textContent = s.mapel; $('#dash-nilai').textContent = s.nilai;
    } catch (e) { toast(e.message, false); }
  }

  // --------------------------------------------------------- Capaian
  async function loadCapaian() {
    const kode = $('#c-mapel').value, kelas = $('#c-kelas').value;
    if (!kode || !kelas) return;
    try { $('#c-text').value = await api('getCapaian', { kode, kelas }); updateCapaianCount(); }
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
    try { await api('saveCapaian', { kode, kelas, teks }); safeMsg('c-status','Capaian tersimpan.',true); gradeDirty = false; }
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
    if(!confirm('Simpan nilai '+f.mn+' untuk kelas '+f.k+'?')) return;
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
        if(!confirm(problems.length+' masalah ditemukan. Tetap simpan '+parsed.length+' baris valid?\n\n'+problems.slice(0,10).join('\n'))) return;
      } else if(!confirm('Simpan '+parsed.length+' baris nilai '+f.mn+' kelas '+f.k+'?')) return;
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
    const kelas=$('#e-kelas').value; if(!kelas) return;
    try {
      const data=await api('getSiswaByKelas',{kelas});
      const opts=(DATA.ekstrakurikuler||[]).map(e=>'<option value="'+esc(e[0])+'">'+esc(e[1])+'</option>').join('');
      let html='<table class="data-table" style="min-width:720px"><thead><tr><th>Nama Siswa</th><th>Pilihan Ekstra 1</th><th class="center">Nilai</th><th>Pilihan Ekstra 2</th><th class="center">Nilai</th></tr></thead><tbody>';
      data.forEach(r=>html+='<tr data-n="'+esc(r.nis)+'"><td class="font-semibold">'+esc(r.nama)+'</td><td><select class="e1"><option value="">-</option>'+opts+'</select></td><td class="center"><select class="v1"><option value="">-</option><option>A</option><option>B</option><option>C</option></select></td><td><select class="e2"><option value="">-</option>'+opts+'</select></td><td class="center"><select class="v2"><option value="">-</option><option>A</option><option>B</option><option>C</option></select></td></tr>');
      $('#e-table').innerHTML=html+'</tbody></table></div>';
    } catch(e) { $('#e-table').textContent=e.message; }
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
  function switchNilaiView(mode) {
    const manual=$('#view-manual'),upload=$('#view-upload');
    const isManual=mode==='m';
    manual.classList.toggle('hidden',!isManual); upload.classList.toggle('hidden',isManual);
    const btnM=$('#btn-m'),btnU=$('#btn-u');
    // gaya tab ditentukan CSS lewat aria-selected — className tetap 'tab'
    btnM.setAttribute('aria-selected',String(isManual)); btnU.setAttribute('aria-selected',String(!isManual));
    // Pindah tab berarti tinggalkan tabel — konfirmasi bila ada perubahan belum disimpan.
    if(gradeDirty && !isManual && !pendingSave){
      if(!confirm('Ada nilai yang belum disimpan. Tetap pindah ke tab Upload Excel?')) {
        manual.classList.remove('hidden'); upload.classList.add('hidden');
        btnM.setAttribute('aria-selected','true'); btnU.setAttribute('aria-selected','false');
        return;
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
        const total=(data[k]||[]).length, lengkap=(data[k]||[]).filter(x=>x.status==='Lengkap').length;
        const pct=document.createElement('span');pct.className='badge '+(lengkap===total?'badge-ok':lengkap?'badge-warn':'badge-bad');
        pct.textContent=lengkap+'/'+total;title.appendChild(pct);
        card.appendChild(title);
        const ul=document.createElement('ul');
        (data[k]||[]).forEach(item=>{const li=document.createElement('li');li.className='status-row';const name=document.createElement('span');name.className='name';name.textContent=item.mapel;const badge=document.createElement('span');badge.className='badge '+(item.status==='Lengkap'?'badge-ok':'badge-bad');badge.textContent=item.status;li.append(name,badge);ul.appendChild(li);});
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
    if(!confirm('Akan dibuat '+count+' PDF untuk seluruh kelas '+kelas+' (bukan hanya siswa di preview). Lanjutkan?')) return;
    setBusy(button||$('[data-action="bulkPrint"]'),true,'Membuat '+count+' PDF…');
    try {
      const result=await api('generateAllPdf',{kelas,semester,tahunAjaran,jenisRapor,withSignature},{timeout:360000});
      const summary=result.generated+' berhasil, '+result.failed+' gagal.';
      toast(summary,true); if(result.url) window.open(result.url,'_blank','noopener');
      if(result.errors&&result.errors.length) console.warn('Kesalahan cetak PDF:',result.errors);
    } catch(e) { toast(e.message,false); }
    finally { setBusy(button||$('[data-action="bulkPrint"]'),false); }
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
        td.colSpan = 5; td.className = 'empty-state'; td.textContent = 'Belum ada siswa.';
        tr.appendChild(td); body.appendChild(tr); return;
      }
      data.forEach(s => {
        const tr = document.createElement('tr');
        tr.dataset.siswaNis = s.nis; // sengaja BUKAN data-nis (hindari tabrakan selector tabel nilai)
        const cell = (v, cls) => { const td = document.createElement('td'); td.className = cls || ''; td.textContent = v; return td; };
        tr.append(cell(s.nis, 'font-semibold'), cell(s.nisn, 'text-gray-500'), cell(s.nama), cell(s.kelas || '—', 'center'));
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
    if (!confirm('Tandai akun "' + username + '" wajib ganti password saat login berikutnya?')) return;
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
    if (!confirm('Setel password sementara untuk "' + username + '"? Password tampil sekali — salin sekarang.')) return;
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
  async function loadProgressSummary(button) {
    const semester = $('#sum-sem').value, tahunAjaran = $('#sum-thn').value;
    if (!semester || !tahunAjaran) return toast('Pilih semester dan tahun.', false);
    setBusy(button || $('[data-action="loadProgressSummary"]'), true, 'Memuat rekap…');
    try {
      const d = await api('getProgressSummary', { semester, tahunAjaran });
      const area = $('#sum-area'); area.replaceChildren();
      if (!d.kelas.length && !d.mapel.length && !d.guru.length) { area.textContent = 'Belum ada data untuk periode ini.'; return; }
      area.append(
        progressGroup('Per Kelas', d.kelas, 'kelas'),
        progressGroup('Per Mata Pelajaran', d.mapel, 'nama', 'kode'),
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
