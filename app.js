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
  <tr>
    <td class="num">${m.id}</td>
    <td class="name">
      <span class="nameView" style="display:${editMode ? 'none' : ''}"><span class="nameText">${m.name}</span>${flag}</span>
      <input class="nameEdit" style="display:${editMode ? '' : 'none'}" data-id="${m.id}" value="${m.name}">
    </td>
    <td class="samter">
      <span class="samterView" style="display:${editMode ? 'none' : ''}">${m.samter || ''}</span>
      <input class="samterEdit" style="display:${editMode ? '' : 'none'}" data-id="${m.id}" value="${m.samter || ''}" maxlength="6">
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

function koreanCompare(a, b) {
  return a.localeCompare(b, 'ko');
}

function apiBulkSave(members) {
  const rows = members.map(m => [m.id, m.name, m.samter, m.nam, m.yeo, m.gender]);
  return fetch(CONFIG.API_URL, {
    method: 'POST',
    mode: 'no-cors',
    body: JSON.stringify({ action: 'bulkset', rows }),
  });
}

async function resortRoster() {
  const named = state.members.filter(m => m.name && m.name.trim() !== '');
  named.sort((a, b) => koreanCompare(a.name, b.name));

  const newMembers = named.map((m, idx) => Object.assign({}, m, { id: idx + 1 }));
  const blanksCount = 240 - newMembers.length;
  for (let i = 0; i < blanksCount; i++) {
    newMembers.push({ id: newMembers.length + 1, name: '', samter: '', nam: '', yeo: '', gender: '' });
  }

  state.members = newMembers;
  renderGrid();
  renderSummary();
  showToast('가나다순으로 재정렬했습니다. 저장 중...');
  try {
    await apiBulkSave(newMembers);
    showToast('저장 완료');
  } catch (err) {
    showToast('저장 실패: ' + err.message + ' — "서버와 동기화"로 다시 확인해 주세요.');
  }
}

function attachEditHandlers() {
  document.querySelectorAll('.nameEdit, .samterEdit').forEach(inp => {
    inp.addEventListener('change', e => {
      const id = e.target.dataset.id;
      const m = findMember(id);
      const isName = e.target.classList.contains('nameEdit');
      const field = isName ? 'name' : 'samter';
      const newValue = e.target.value.trim();
      const isNewRegistration = isName && !m.name && newValue;

      m[field] = newValue;

      if (isNewRegistration) {
        resortRoster();
      } else {
        apiUpdateCell(id, field, newValue);
      }
    });
  });
}

function setEditMode(on) {
  editMode = on;
  document.getElementById('editModeBtn').textContent = on ? '편집 완료' : '편집 모드';
  renderGrid();
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

async function apiGetHistory() {
  return jsonp(CONFIG.API_URL + '?action=history');
}

function formatDateMDY(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const [y, m, d] = parts;
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
}

// Returns the (name, samter, gender-label, applicable-slot) list of "real"
// attendance slots to track: couples => both nam & yeo; singles => whichever slot is active.
function getTrackedSlots() {
  const slots = [];
  state.members.forEach(m => {
    if (!m.name) return; // skip blank future-registration rows
    const single = !m.name.includes('/');
    if (single) {
      const activeSlot = m.gender === 'nam' ? 'nam' : 'yeo';
      slots.push({ id: m.id, name: m.name, samter: m.samter || '', slot: activeSlot, label: '' });
    } else {
      slots.push({ id: m.id, name: m.name, samter: m.samter || '', slot: 'nam', label: '(남편)' });
      slots.push({ id: m.id, name: m.name, samter: m.samter || '', slot: 'yeo', label: '(아내)' });
    }
  });
  return slots;
}

function buildWeekLookup(weeks) {
  // weeks: [{date, members:[{id,nam,yeo}, ...]}], returns Map(id -> {nam,yeo}) per week
  return weeks.map(w => {
    const map = {};
    (w.members || []).forEach(m => { map[String(m.id)] = m; });
    return { date: w.date, map };
  });
}

// Every person is assigned to exactly ONE bucket — their longest current
// consecutive-absence streak — never duplicated across shorter buckets.
async function computeAllAbsenceReport() {
  const histRes = await apiGetHistory();
  if (histRes.error) throw new Error(histRes.error);

  const weeks = (histRes.weeks || []).slice();
  weeks.push({ date: state.date || '9999-99-99', members: state.members });
  weeks.sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));

  const lookups = buildWeekLookup(weeks); // oldest -> newest
  const slots = getTrackedSlots();

  const results = []; // {name, samter, count, lastReason}
  slots.forEach(({ id, name, samter, slot, label }) => {
    let count = 0;
    let lastReason = '';
    for (let i = lookups.length - 1; i >= 0; i--) {
      const rec = lookups[i].map[String(id)];
      if (!rec) break; // no data that far back — stop counting
      const v = rec[slot] || '';
      if (isPresentValue(v)) break; // present breaks the streak
      count++;
      if (!lastReason) lastReason = v || 'X';
    }
    if (count > 0) {
      results.push({ name: name + (label ? ' ' + label : ''), samter, count, lastReason });
    }
  });

  return results;
}

function renderAllAbsenceReport(results) {
  document.getElementById('reportTitle').textContent = `전체 결석자 명단(${formatDateMDY(state.date)})`;

  const groups = { 1: [], 2: [], 3: [], '4+': [] };
  results.forEach(r => {
    const key = r.count >= 4 ? '4+' : String(r.count);
    groups[key].push(r);
  });
  Object.keys(groups).forEach(k => groups[k].sort((a, b) => a.name.localeCompare(b.name, 'ko')));

  const titles = { 1: '1주 결석', 2: '2주 연속 결석', 3: '3주 연속 결석', '4+': '4주 이상 연속 결석' };

  const colHTML = key => `
    <div class="report-col">
      <h3>${titles[key]} (${groups[key].length}명)</h3>
      ${groups[key].length
        ? `<ul>${groups[key].map(r => `<li><span class="rname">${r.name} <span class="rsamter">${r.samter}</span></span><span class="rreason">${r.lastReason}</span></li>`).join('')}</ul>`
        : `<div class="report-empty">해당 없음</div>`}
    </div>
  `;

  document.getElementById('reportBody').innerHTML = `
    <div class="report-columns">
      ${['1', '2', '3', '4+'].map(colHTML).join('')}
    </div>
    <div class="report-note">
      "새 주 시작"으로 보관된 기록(기록 시트)과 이번 주 현재 데이터를 기준으로 계산했습니다. 3주 이상 결석한 사람은 1주·2주 명단에는 중복 표시되지 않고 최종 해당하는 칸에만 한 번 나타납니다.
      기록이 없는 사람(신규 등록 등)은 해당 기간만큼만 계산되며, 자동 기록이 쌓일수록 정확해집니다.
    </div>
  `;
}

// This-week-only absentees, grouped by 샘터 번호 (ascending).
function computeBySamterReport() {
  const groupsMap = {}; // samter -> [ {name, reason} ]

  state.members.forEach(m => {
    if (!m.name) return;
    const single = !m.name.includes('/');
    const samterKey = m.samter && m.samter.trim() !== '' ? m.samter.trim() : '미배정';
    const checks = single
      ? [{ slot: m.gender === 'nam' ? 'nam' : 'yeo', label: '' }]
      : [{ slot: 'nam', label: '(남편)' }, { slot: 'yeo', label: '(아내)' }];

    checks.forEach(({ slot, label }) => {
      const v = m[slot] || '';
      if (!isPresentValue(v)) {
        if (!groupsMap[samterKey]) groupsMap[samterKey] = [];
        groupsMap[samterKey].push({ name: m.name + (label ? ' ' + label : ''), reason: v || 'X' });
      }
    });
  });

  const keys = Object.keys(groupsMap).filter(k => k !== '미배정');
  keys.sort((a, b) => Number(a) - Number(b));
  if (groupsMap['미배정']) keys.push('미배정');

  return keys.map(k => ({
    samter: k,
    members: groupsMap[k].sort((a, b) => a.name.localeCompare(b.name, 'ko')),
  }));
}

function renderBySamterReport(groups) {
  document.getElementById('reportTitle').textContent = `샘터별 결석자 명단(${formatDateMDY(state.date)})`;

  const colHTML = g => `
    <div class="report-col">
      <h3>${g.samter === '미배정' ? '샘터 미배정' : g.samter + '샘터'} 결석 명단 (${g.members.length}명)</h3>
      <ul>${g.members.map(r => `<li><span class="rname">${r.name}</span><span class="rreason">${r.reason}</span></li>`).join('')}</ul>
    </div>
  `;

  if (!groups.length) {
    document.getElementById('reportBody').innerHTML = `<div class="report-empty">이번 주 결석자가 없습니다.</div>`;
    return;
  }

  document.getElementById('reportBody').innerHTML = `
    <div class="report-columns">${groups.map(colHTML).join('')}</div>
    <div class="report-note">이번 주(${formatDateMDY(state.date)}) 현재 데이터를 기준으로 샘터 번호 순으로 정리했습니다.</div>
  `;
}

// ---------- dropdown menu ----------
const reportDropdown = document.getElementById('reportDropdown');
const reportMenu = document.getElementById('reportMenu');

document.getElementById('submitReportBtn').addEventListener('click', e => {
  e.stopPropagation();
  reportMenu.style.display = reportMenu.style.display === 'none' ? 'block' : 'none';
});
document.addEventListener('click', () => { reportMenu.style.display = 'none'; });

reportMenu.querySelectorAll('.dropdown-item').forEach(btn => {
  btn.addEventListener('click', async e => {
    e.stopPropagation();
    reportMenu.style.display = 'none';
    const type = btn.dataset.report;
    showToast('명단을 계산 중입니다...');
    try {
      if (type === 'all') {
        const results = await computeAllAbsenceReport();
        renderAllAbsenceReport(results);
      } else if (type === 'bysamter') {
        const groups = computeBySamterReport();
        renderBySamterReport(groups);
      }
      document.getElementById('reportOverlay').style.display = 'flex';
    } catch (err) {
      showToast('명단 계산 실패: ' + err.message);
    }
  });
});

document.getElementById('reportCloseBtn').addEventListener('click', () => {
  document.getElementById('reportOverlay').style.display = 'none';
});
document.getElementById('reportOverlay').addEventListener('click', e => {
  if (e.target.id === 'reportOverlay') e.target.style.display = 'none';
});

loadAndRender();
