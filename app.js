// CCPC 주일예배 출석현황 - app.js
// GitHub Pages(프론트) + Google Apps Script(백엔드, Google Sheets) 구조

const CONFIG = {
  // Code.gs를 웹앱으로 배포한 뒤 나오는 URL로 교체하세요.
  // 예: https://script.google.com/macros/s/AKfycb.../exec
  API_URL: 'https://script.google.com/macros/s/AKfycbxxxwG1hJFS9WIuFlbp0831AqvcinaVS51IrYHoBBPwoTV_5wmX4h0c6RN-xm9tBegc_w/exec',
};

const PERSISTENT_TAGS = ['환우', '타교', 'EM', '타주'];

let state = { date: '', members: [] }; // members: [{id,name,samter,nam,yeo}]
let editMode = false;
let membersById = {};

// ---------- JSONP helper (avoids CORS for GET reads) ----------
function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cbName = 'jsonp_cb_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    let done = false;

    window[cbName] = (data) => {
      done = true;
      resolve(data);
      cleanup();
    };

    function cleanup() {
      delete window[cbName];
      script.remove();
    }

    script.onerror = () => {
      if (!done) { reject(new Error('네트워크 오류')); cleanup(); }
    };
    script.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cbName;
    document.body.appendChild(script);

    setTimeout(() => {
      if (!done) { reject(new Error('요청 시간 초과')); cleanup(); }
    }, 12000);
  });
}

// ---------- Backend calls ----------
async function apiGet() {
  const url = CONFIG.API_URL + '?action=get';
  return jsonp(url);
}

// Fire-and-forget write (no-cors POST). We don't get a readable response,
// so we optimistically trust it and let manual "서버와 동기화" catch any drift.
function apiUpdateCell(id, field, value) {
  fetch(CONFIG.API_URL, {
    method: 'POST',
    mode: 'no-cors',
    body: JSON.stringify({ action: 'update', id, field, value }),
  }).catch(() => showToast('서버 저장에 실패했을 수 있습니다. 인터넷 연결을 확인해 주세요.'));
}

async function apiNewWeek() {
  return jsonp(CONFIG.API_URL + '?action=newweek');
}

async function apiSetDate(dateStr) {
  return jsonp(CONFIG.API_URL + '?action=setdate&date=' + encodeURIComponent(dateStr));
}

// ---------- Rendering helpers ----------
function isPresentValue(v) {
  return v === '' || v === '✓';
}

function classifyCell(v) {
  if (v === '') return 'blank';
  if (v === '✓') return 'present';
  if (v === 'X') return 'absent';
  return 'tag';
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function renderSummary() {
  let presentCount = 0, absentCount = 0;
  const tagCounts = { 환우: 0, 타교: 0, EM: 0, 타주: 0 };

  state.members.forEach(m => {
    if (!m.name) return; // skip empty placeholder rows (future registrations)
    const single = !m.name.includes('/');
    let slots;
    if (single) {
      const activeSlot = m.gender === 'nam' ? 'nam' : 'yeo';
      slots = [m[activeSlot]];
    } else {
      slots = [m.nam, m.yeo];
    }
    slots.forEach(v => {
      if (isPresentValue(v)) presentCount++;
      else {
        absentCount++;
        if (tagCounts[v] !== undefined) tagCounts[v]++;
      }
    });
  });

  document.getElementById('summaryBar').innerHTML = `
    <div class="chip present">출석 <b>${presentCount}</b></div>
    <div class="chip absent">결석 <b>${absentCount}</b></div>
    <div class="chip">환우 <b>${tagCounts['환우']}</b></div>
    <div class="chip">타교 <b>${tagCounts['타교']}</b></div>
    <div class="chip">EM <b>${tagCounts['EM']}</b></div>
    <div class="chip">타주 <b>${tagCounts['타주']}</b></div>
  `;
}

function buildCellHTML(memberId, gender, value, hidden) {
  if (hidden) {
    return `<span class="cellbox hidden-slot"></span>`;
  }
  const cls = classifyCell(value);
  const label = value === '' ? '' : value;
  return `<span class="cellbox ${cls}" data-id="${memberId}" data-gender="${gender}">${label}</span>`;
}

function rowHTML(m) {
  const single = !m.name.includes('/');
  const hasName = !!m.name;
  let flag = '';
  let namHidden = false, yeoHidden = false;

  if (single && hasName) {
    flag = `<span class="flag" data-id="${m.id}" title="클릭해서 남/여 선택">●</span>`;
    if (m.gender === 'nam') yeoHidden = true;
    else if (m.gender === 'yeo') namHidden = true;
    // gender === '' (not yet chosen): show both until admin picks one
  }

  return `
  <tr data-search="${m.name}">
    <td class="num">${m.id}</td>
    <td class="name">
      <span class="nameView"><span class="nameText">${m.name}</span>${flag}</span>
      <input class="nameEdit" style="display:none" data-id="${m.id}" value="${m.name}" placeholder="새 교인 이름">
    </td>
    <td class="samter">
      <span class="samterView">${m.samter || ''}</span>
      <input class="samterEdit" style="display:none" data-id="${m.id}" value="${m.samter || ''}" maxlength="6">
    </td>
    <td class="cell">${buildCellHTML(m.id, 'nam', m.nam, namHidden)}</td>
    <td class="cell">${buildCellHTML(m.id, 'yeo', m.yeo, yeoHidden)}</td>
  </tr>`;
}

function chooseGender(id, newGender) {
  const m = findMember(id);
  const oldGender = m.gender || 'yeo';
  if (oldGender !== newGender) {
    const val = m[oldGender];
    m[newGender] = val;
    m[oldGender] = '';
    apiUpdateCell(id, newGender, val);
    apiUpdateCell(id, oldGender, '');
  }
  m.gender = newGender;
  apiUpdateCell(id, 'gender', newGender);
  renderGrid();
  renderSummary();
}

function attachFlagHandlers() {
  document.querySelectorAll('.flag[data-id]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const id = el.dataset.id;
      const pick = document.createElement('span');
      pick.className = 'genderPick';
      pick.innerHTML = `<button type="button" class="gpBtn" data-g="nam">남</button><button type="button" class="gpBtn" data-g="yeo">여</button>`;
      el.replaceWith(pick);
      pick.querySelectorAll('.gpBtn').forEach(b => {
        b.addEventListener('click', ev => {
          ev.stopPropagation();
          chooseGender(id, b.dataset.g);
        });
      });
    });
  });
}

function renderGrid() {
  const blocks = [];
  for (let start = 1; start <= 240; start += 20) {
    const end = start + 19;
    blocks.push(state.members.filter(m => m.id >= start && m.id <= end));
  }
  const root = document.getElementById('gridRoot');
  root.innerHTML = blocks.map(list => `
    <div class="block">
      <table>
        <colgroup>
          <col class="col-num"><col class="col-name"><col class="col-samter"><col class="col-cell"><col class="col-cell">
        </colgroup>
        <thead><tr><th>#</th><th>이름</th><th>샘터</th><th>남</th><th>여</th></tr></thead>
        <tbody>${list.map(rowHTML).join('')}</tbody>
      </table>
    </div>
  `).join('');

  attachCellHandlers();
  attachEditHandlers();
  attachFlagHandlers();
  applySearchFilter();
}

function attachCellHandlers() {
  document.querySelectorAll('.cellbox[data-id]').forEach(el => {
    el.addEventListener('click', onCellClick);
    el.addEventListener('contextmenu', onCellClear);
  });
}

function findMember(id) {
  return state.members.find(m => String(m.id) === String(id));
}

function onCellClear(e) {
  e.preventDefault();
  const id = e.currentTarget.dataset.id;
  const gender = e.currentTarget.dataset.gender;
  const m = findMember(id);
  m[gender] = '';
  apiUpdateCell(id, gender, '');
  renderGrid();
  renderSummary();
}

function onCellClick(e) {
  const el = e.currentTarget;
  const id = el.dataset.id;
  const gender = el.dataset.gender;
  const m = findMember(id);
  const current = m[gender];

  if (current === '') {
    m[gender] = '✓';
    apiUpdateCell(id, gender, '✓');
    renderGrid(); renderSummary();
    return;
  }
  if (current === '✓') {
    m[gender] = 'X';
    apiUpdateCell(id, gender, 'X');
    renderGrid(); renderSummary();
    return;
  }
  if (current === 'X') {
    el.innerHTML = `<input type="text" maxlength="4" value="">`;
    const input = el.querySelector('input');
    input.focus();
    const commit = () => {
      const v = input.value.trim();
      m[gender] = v;
      apiUpdateCell(id, gender, v);
      renderGrid(); renderSummary();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') { input.value = ''; input.blur(); }
    });
    return;
  }
  // custom tag -> back to blank
  m[gender] = '';
  apiUpdateCell(id, gender, '');
  renderGrid(); renderSummary();
}

function attachEditHandlers() {
  document.querySelectorAll('.nameEdit, .samterEdit').forEach(inp => {
    inp.addEventListener('change', e => {
      const id = e.target.dataset.id;
      const m = findMember(id);
      const isName = e.target.classList.contains('nameEdit');
      const field = isName ? 'name' : 'samter';
      m[field] = e.target.value;
      apiUpdateCell(id, field, e.target.value);
    });
  });
}

function setEditMode(on) {
  editMode = on;
  document.querySelectorAll('.nameView, .samterView').forEach(el => {
    el.style.display = on ? 'none' : '';
  });
  document.querySelectorAll('.nameEdit, .samterEdit').forEach(el => {
    el.style.display = on ? '' : 'none';
  });
  document.getElementById('editModeBtn').textContent = on ? '편집 완료' : '편집 모드';
}

function applySearchFilter() {
  const q = document.getElementById('searchBox').value.trim();
  document.querySelectorAll('tbody tr').forEach(tr => {
    if (!q) { tr.classList.remove('hidden'); return; }
    tr.classList.toggle('hidden', !(tr.dataset.search || '').includes(q));
  });
}

// ---------- Init & top bar wiring ----------
async function loadAndRender() {
  try {
    const data = await apiGet();
    if (data.error) throw new Error(data.error);
    state.date = data.date || '';
    state.members = (data.members || []).map(m => ({
      id: Number(m.id), name: m.name || '', samter: m.samter || '', nam: m.nam || '', yeo: m.yeo || '',
      gender: m.gender || '',
    }));
    document.getElementById('serviceDate').value = state.date;
    renderGrid();
    renderSummary();
  } catch (err) {
    showToast('서버 연결 실패: ' + err.message + ' (app.js의 CONFIG.API_URL을 확인해 주세요)');
  }
}

document.getElementById('editModeBtn').addEventListener('click', () => setEditMode(!editMode));
document.getElementById('searchBox').addEventListener('input', applySearchFilter);

document.getElementById('syncBtn').addEventListener('click', async () => {
  showToast('서버에서 최신 데이터를 불러옵니다...');
  await loadAndRender();
  showToast('동기화 완료');
});

document.getElementById('serviceDate').addEventListener('change', async e => {
  state.date = e.target.value;
  await apiSetDate(state.date);
});

document.getElementById('newWeekBtn').addEventListener('click', async () => {
  const ok = confirm('새 주 출석표를 시작할까요?\n환우·타교·EM·타주 표시는 그대로 유지되고,\n✓ / X / 기타 직접입력(출타,한국 등) 표시만 모두 지워집니다.\n\n(이전 표는 "기록" 시트에 저장됩니다)');
  if (!ok) return;
  try {
    const res = await apiNewWeek();
    if (res.error) throw new Error(res.error);
    showToast('새 주 출석표가 준비되었습니다.');
    await loadAndRender();
  } catch (err) {
    showToast('새 주 시작 실패: ' + err.message);
  }
});

document.getElementById('refreshSamterBtn').addEventListener('click', async () => {
  showToast('샘터 조직표 사이트에 접속을 시도합니다...');
  try {
    await fetch('https://glenwercpc-byte.github.io/Cell-Group/', { mode: 'cors' });
    showToast('사이트 연결은 되었지만, 실제 샘터 번호는 그 사이트가 나중에 자바스크립트로 불러오는 데이터라 이 화면에서 자동으로 읽어올 수 없습니다. 편집 모드에서 직접 수정해 주세요.');
  } catch (e) {
    showToast('교차 출처(CORS) 제한으로 자동 연결에 실패했습니다. 편집 모드에서 샘터 번호를 직접 수정해 주세요.');
  }
});

loadAndRender();
