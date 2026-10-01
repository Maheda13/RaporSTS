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
    ['n','a','e','s','r','m'].forEach(prefix => {
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
      previewRapor, doPrint, bulkPrint, changePw, loadMonitoring
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
      ['p-cetak','fas fa-print','Cetak Rapor']
    ]
  };
  function buildMenu(role) {
    const menu = $('#sidebar-menu'); menu.replaceChildren();
    (MENUS[role] || MENUS['Guru Mapel']).forEach(([id, icon, title]) => {
      const li = document.createElement('li'); li.className = 'mb-1';
      const button = document.createElement('button');
      button.type = 'button'; button.id = 'link-' + id; button.dataset.nav = id;
      button.className = 'flex items-center px-4 py-3 nav-item rounded-lg transition w-full text-left';
      button.innerHTML = '<i class="' + icon + ' w-6 mr-3 text-lg text-center" aria-hidden="true"></i><span class="font-medium">' + esc(title) + '</span>';
      li.appendChild(button); menu.appendChild(li);
    });
    nav('p-dashboard');
  }
  function nav(id) {
    if (gradeDirty && id !== 'p-nilai' && !confirm('Ada perubahan nilai yang belum disimpan. Tinggalkan halaman?')) return;
    $$('.page-section').forEach(el => el.classList.add('hidden'));
    const page = document.getElementById(id); if (!page) return;
    page.classList.remove('hidden'); $('#page-title').textContent = id.replace('p-','').replace(/-/g,' ').toUpperCase();
    $$('.nav-item').forEach(el => { el.classList.remove('active-nav'); el.removeAttribute('aria-current'); });
    const link = $('#link-' + id); if (link) { link.classList.add('active-nav'); link.setAttribute('aria-current','page'); }
    if (innerWidth < 768) closeSidebar();
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
    const area=$('#n-table-area'); area.innerHTML='<div class="p-10 text-center text-gray-500" role="status" aria-live="polite">Memuat data…</div>';
    try {
      const data=await api('getDataNilaiInput',{kelas:k,kodeMapel:m,semester:s,tahunAjaran:t});
      if(!data || !data.length) { area.innerHTML='<div class="p-8 text-center text-gray-500">Belum ada siswa pada kelas ini.</div>'; return; }
      let html='<table class="min-w-full divide-y divide-gray-200 border text-sm text-center"><thead class="bg-gray-100 text-gray-600 sticky top-0 z-20"><tr><th rowspan="2" class="px-4 text-left w-1/4 sticky left-0 bg-gray-100 z-30 border-r border-b">Nama Siswa</th><th colspan="5" class="border-b py-2">Ulangan Harian</th><th rowspan="2" class="border-l border-b bg-blue-50 w-24">STS</th><th rowspan="2" class="border-l border-b bg-green-50 w-24">SAS</th></tr><tr><th class="py-1">1</th><th>2</th><th>3</th><th>4</th><th>5</th></tr></thead><tbody class="bg-white divide-y">';
      data.forEach(r=>{
        html+='<tr data-nis="'+esc(r.nis)+'"><td class="px-4 py-2 text-left font-medium sticky left-0 bg-white border-r whitespace-nowrap">'+esc(r.nama)+'<br><span class="text-[10px] text-gray-400 font-normal">'+esc(r.nis)+'</span></td>';
        [1,2,3,4,5].forEach(i=>html+='<td class="p-1"><input type="number" inputmode="decimal" class="grade-input uh'+i+'" value="'+esc(r['uh'+i]??'')+'" data-original-value="'+esc(r['uh'+i]??'')+'" min="0" max="100" step="1" aria-label="UH '+i+' — '+esc(r.nama)+'"></td>');
        html+='<td class="p-1 border-l bg-blue-50/50"><input type="number" inputmode="decimal" class="grade-input sts" value="'+esc(r.sts??'')+'" data-original-value="'+esc(r.sts??'')+'" min="0" max="100" step="1" aria-label="STS — '+esc(r.nama)+'"></td>';
        html+='<td class="p-1 border-l bg-green-50/50"><input type="number" inputmode="decimal" class="grade-input sas" value="'+esc(r.sas??'')+'" data-original-value="'+esc(r.sas??'')+'" min="0" max="100" step="1" aria-label="SAS — '+esc(r.nama)+'"></td></tr>';
      });
      area.innerHTML=html+'</tbody></table>'; gradeDirty=false; updateDirtyIndicator();
    } catch(e) { area.innerHTML='<div class="p-8 text-center text-red-600" role="alert">'+esc(e.message)+'</div>'; }
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
      let html='<table class="w-full text-sm text-left"><thead class="bg-gray-100 text-gray-600 font-bold border-b sticky top-0"><tr><th class="px-4 py-3">Nama Siswa</th><th class="text-center w-24">Sakit</th><th class="text-center w-24">Izin</th><th class="text-center w-24">Alpha</th></tr></thead><tbody class="divide-y bg-white">';
      data.forEach(r=>html+='<tr data-n="'+esc(r.nis)+'"><td class="px-4 py-2 font-medium">'+esc(r.nama)+'</td>'+['sakit','izin','alpha'].map((key,i)=>'<td class="p-1"><input type="number" class="attendance-input '+['s','i','a'][i]+'" value="'+esc(r[key])+'" min="0" step="1" aria-label="'+['Sakit','Izin','Alpha'][i]+' — '+esc(r.nama)+'"></td>').join('')+'</tr>');
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
      let html='<div class="min-w-[720px]"><table class="w-full text-sm text-left"><thead class="bg-gray-100 text-gray-600 font-bold border-b sticky top-0"><tr><th class="px-4 py-3">Nama Siswa</th><th>Pilihan Ekstra 1</th><th class="w-24 text-center">Nilai</th><th>Pilihan Ekstra 2</th><th class="w-24 text-center">Nilai</th></tr></thead><tbody class="divide-y bg-white">';
      data.forEach(r=>html+='<tr data-n="'+esc(r.nis)+'"><td class="px-4 py-2 font-medium">'+esc(r.nama)+'</td><td><select class="e1"><option value="">-</option>'+opts+'</select></td><td><select class="v1"><option value="">-</option><option>A</option><option>B</option><option>C</option></select></td><td><select class="e2"><option value="">-</option>'+opts+'</select></td><td><select class="v2"><option value="">-</option><option>A</option><option>B</option><option>C</option></select></td></tr>');
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
    const active='px-6 py-2 text-sm font-bold rounded-t-lg bg-[#B06161] text-white shadow-sm';
    const idle='px-6 py-2 text-sm font-bold text-gray-500 hover:bg-gray-100 rounded-t-lg';
    btnM.className=active; btnU.className=idle;
    if(!isManual){btnM.className=idle;btnU.className=active;}
    btnM.setAttribute('aria-selected',String(isManual)); btnU.setAttribute('aria-selected',String(!isManual));
    // Pindah tab berarti tinggalkan tabel — konfirmasi bila ada perubahan belum disimpan.
    if(gradeDirty && !isManual && !pendingSave){
      if(!confirm('Ada nilai yang belum disimpan. Tetap pindah ke tab Upload Excel?')) {
        manual.classList.remove('hidden'); upload.classList.add('hidden');
        btnM.className=active; btnU.className=idle; btnM.setAttribute('aria-selected','true'); btnU.setAttribute('aria-selected','false');
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
        const card=document.createElement('div');card.className='bg-white rounded-lg border border-gray-200 shadow-sm mb-4 overflow-hidden';
        const title=document.createElement('div');title.className='bg-gray-50 px-4 py-3 font-bold border-b text-gray-700 border-l-4 border-l-[#B06161]';title.textContent='Kelas '+k;card.appendChild(title);
        const ul=document.createElement('ul');ul.className='divide-y divide-gray-100';
        (data[k]||[]).forEach(item=>{const li=document.createElement('li');li.className='px-4 py-2.5 flex justify-between items-center text-sm';const name=document.createElement('span');name.className='font-medium text-gray-600';name.textContent=item.mapel;const badge=document.createElement('span');badge.className='text-[10px] font-bold px-2 py-1 rounded uppercase tracking-wider '+(item.status==='Lengkap'?'bg-green-100 text-green-800':'bg-red-100 text-red-800');badge.textContent=item.status;li.append(name,badge);ul.appendChild(li);});
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
      const summary=document.createElement('div');summary.className='mb-4 p-5 bg-blue-50/50 border border-blue-200 rounded-xl flex justify-between items-center';
      const left=document.createElement('div');const name=document.createElement('h5');name.className='font-bold text-blue-900 text-lg';name.textContent=d.siswa.nama;const meta=document.createElement('p');meta.className='text-sm text-blue-600 mt-1 font-medium';meta.textContent='NIS: '+d.siswa.nis+' | Kelas: '+d.siswa.kelas;left.append(name,meta);
      const right=document.createElement('div');right.className='text-right text-xs text-gray-600 bg-white p-2.5 rounded-lg border border-blue-100 shadow-sm';right.textContent=d.meta.sem+' · '+d.meta.thn+' · '+d.meta.jenis;summary.append(left,right);area.appendChild(summary);
      const table=document.createElement('table');table.className='w-full text-sm border border-gray-200 mb-6 bg-white rounded-lg';
      const header=document.createElement('thead');header.className='bg-gray-100 border-b border-gray-200 text-gray-700';header.innerHTML='<tr><th class="p-3 text-left">Mata Pelajaran</th><th class="p-3 text-center w-24">Nilai Akhir</th><th class="p-3 text-left">Deskripsi Capaian</th></tr>';
      const tbody=document.createElement('tbody');tbody.className='divide-y divide-gray-100';
      (d.nilai||[]).forEach(n=>{const tr=document.createElement('tr');[n.mapel,n.nilai,n.capaian].forEach((v,i)=>{const td=document.createElement('td');td.className='p-3 '+(i===1?'text-center font-bold text-lg text-[#B06161]':i===0?'font-medium text-gray-800':'text-xs text-gray-600 leading-relaxed');td.textContent=v;tr.appendChild(td);});tbody.appendChild(tr);});
      table.append(header,tbody);area.appendChild(table);
      const sign=document.createElement('label');sign.className='mb-6 bg-gray-50 p-4 rounded-xl border border-gray-200 flex items-center font-bold text-sm text-gray-700';
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.id='r-ttd';checkbox.className='w-5 h-5 mr-3';
      sign.append(checkbox,document.createTextNode('Tampilkan Tanda Tangan Wali Kelas ('+d.waliKelas+')'));area.appendChild(sign);
      const one=document.createElement('button');one.type='button';one.className='w-full bg-[#B06161] text-white font-bold py-3.5 rounded-xl shadow-lg';one.dataset.action='doPrint';one.innerHTML='<i class="fas fa-file-pdf mr-2" aria-hidden="true"></i> Buat & Buka PDF Rapor';area.appendChild(one);
      const all=document.createElement('button');all.type='button';all.className='w-full mt-3 bg-indigo-600 text-white font-bold py-3.5 rounded-xl shadow-lg';all.dataset.action='bulkPrint';all.innerHTML='<i class="fas fa-copy mr-2" aria-hidden="true"></i> Cetak Semua Rapor Kelas '+esc(d.siswa.kelas)+' (seluruh kelas)';area.appendChild(all);
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
      if(!data.siswa||!data.siswa.length) { const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=100;td.className='p-8 text-center text-gray-500';td.textContent='Belum ada data untuk kelas/periode ini.';tr.appendChild(td);body.appendChild(tr);return; }
      const hr=document.createElement('tr');
      ['NIS','Nama Siswa',...(data.codes||[]).map(c=>c), 'S','I','A','Ekstrakurikuler'].forEach((label,i)=>{const th=document.createElement('th');th.className='p-3 border min-w-[80px] '+(i===1?'sticky left-0 bg-gray-200 z-10 shadow-md':'');th.textContent=label;if(i>=2&&i<2+(data.codes||[]).length)th.title=data.names[label]||label;hr.appendChild(th);});head.appendChild(hr);
      data.siswa.forEach(s=>{const tr=document.createElement('tr');tr.className='hover:bg-blue-50';
        const add=(v,cls)=>{const td=document.createElement('td');td.className='p-3 border '+(cls||'');td.textContent=v===null||v===undefined?'':String(v);tr.appendChild(td);};
        add(s.nis,'text-center');add(s.nama,'font-bold sticky left-0 bg-white z-10 shadow-md');
        (data.codes||[]).forEach(c=>{const v=s.nilai[c];if(!v){const td=document.createElement('td');td.className='p-3 border text-center text-red-400';td.textContent='×';td.setAttribute('aria-label','Belum diisi');tr.appendChild(td);}else add(v,'text-center');});
        add(s.absen.s,'text-center bg-yellow-50');add(s.absen.i,'text-center bg-blue-50');add(s.absen.a,'text-center bg-red-50');add(s.ekskul,'text-xs');body.appendChild(tr);
      });
    } catch(e) { toast(e.message,false); }
    finally { setBusy(button||$('[data-action="loadMonitoring"]'),false); }
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
