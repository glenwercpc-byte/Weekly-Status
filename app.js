// CCPC 주일예배 출석현황 - app.js
// GitHub Pages(프론트) + Google Apps Script(백엔드, Google Sheets) 구조

const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbwB8hMRMECTFp3mYzAAPw0mAuAbZ6a-TDzksiWgvXr02ri6I8zioIHMzmsupML9I2o_aw/exec',
};

// "한국": 일시적으로 한국에 가 있고 다시 돌아오는 사람 (자동 유지, 총원에는 포함)
// "귀국": 영구적으로 돌아오지 않는 사람 (자동 유지, 총원에서는 제외 + 이름 빨간색)
const PERSISTENT_TAGS = ['환우', '타교', '한국', '타주', '장결', '귀국'];

// 타교/타주/귀국 상태인 사람은 총원 집계 및 결석자 명단(자료 제출)에서도
// 제외되고, 이름이 빨간색으로 표시됩니다.
const EXCLUDE_FROM_TOTAL = ['타교', '타주', '귀국'];

let state = { date: '', members: [], extra: { kids: 0, youth: 0, visitors: 0 }, readonly: false, weekStarted: false };
let editMode = false;
let MAX_ID = 240; // EM 구역(201~) 끝 번호 — 마지막 자리가 채워지면 자동으로 20씩 늘어납니다

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
// so we optimistically trust it and let manual "저장 및 동기화" catch any drift.
function apiUpdateCell(id, field, value) {
  fetch(CONFIG.API_URL, {
    method: 'POST',
    mode: 'no-cors',
    body: JSON.stringify({ action: 'update', id, field, value }),
  }).catch(() => showToast('서버 저장에 실패했을 수 있습니다. 인터넷 연결을 확인해 주세요.'));
}

// Same as apiUpdateCell but writes into an archived weekly snapshot inside
// the "기록" sheet (used when viewing/editing a past week via 조회).
function apiUpdateHistoricalCell(dateStr, id, field, value) {
  fetch(CONFIG.API_URL, {
    method: 'POST',
    mode: 'no-cors',
    body: JSON.stringify({ action: 'updatehistorical', date: dateStr, id, field, value }),
  }).catch(() => showToast('서버 저장에 실패했을 수 있습니다. 인터넷 연결을 확인해 주세요.'));
}

// Same idea but for the 유초등부/중고등부/방문자 counts of an archived week.
function apiUpdateHistoricalExtra(dateStr, key, value) {
  fetch(CONFIG.API_URL, {
    method: 'POST',
    mode: 'no-cors',
    body: JSON.stringify({ action: 'updatehistoricalextra', date: dateStr, key, value }),
  }).catch(() => showToast('서버 저장에 실패했을 수 있습니다. 인터넷 연결을 확인해 주세요.'));
}

// Routes a single-field edit to the right place: the live current sheet,
// or the archived historical snapshot, depending on what's being viewed.
// Editing the CURRENT week also flips weekStarted on (both locally, for an
// immediate UI switch from all-zero to real counts, and on the server via
// updateCell(), so it survives a page reload).
function saveField(id, field, value) {
  if (state.readonly) {
    apiUpdateHistoricalCell(state.date, id, field, value);
  } else {
    apiUpdateCell(id, field, value);
    state.weekStarted = true;
  }
}

async function apiNewWeek(newDateStr) {
  return jsonp(CONFIG.API_URL + '?action=newweek&newDate=' + encodeURIComponent(newDateStr || ''));
}

// Creates a blank entry directly in "기록" for a date that's a gap BEFORE
// the current live week — never touches the live 출석현황/설정 sheets.
async function apiCreateBlankHistoricalWeek(dateStr) {
  return jsonp(CONFIG.API_URL + '?action=createblankweek&date=' + encodeURIComponent(dateStr));
}

async function apiSetExtra(key, value) {
  return jsonp(CONFIG.API_URL + '?action=setextra&key=' + encodeURIComponent(key) + '&value=' + encodeURIComponent(value));
}

async function apiGetHistory() {
  return jsonp(CONFIG.API_URL + '?action=history');
}

// Lightweight: just the archived dates, no member/extra data. Used on every
// page load to figure out "what's the most recent saved week" without the
// cost of transferring every archived week's full roster each time.
async function apiGetHistoryDates() {
  return jsonp(CONFIG.API_URL + '?action=historydates');
}

async function apiGetWeek(dateStr) {
  return jsonp(CONFIG.API_URL + '?action=getweek&date=' + encodeURIComponent(dateStr));
}

function apiBulkSave(members) {
  const rows = members.map(m => [m.id, m.name, m.samter, m.nam, m.yeo, m.gender]);
  return fetch(CONFIG.API_URL, {
    method: 'POST',
    mode: 'no-cors',
    body: JSON.stringify({ action: 'bulkset', rows }),
  });
}

// SAFETY GUARD (critical): refuses to bulk-save a roster that has gone
// completely blank. This exists because of a real incident where a failed
// mid-flight network refresh inside "저장 및 동기화" left state.members with
// no named people, and the code went ahead and wrote that blank state over
// the real roster, wiping every name/samter for the current week. Any bulk
// write that would erase every name is almost certainly a bug, not a real
// user action — so we block it here as a last line of defense.
function hasAnyNamedMember(members) {
  return Array.isArray(members) && members.some(m => m.name && m.name.trim() !== '');
}

// ---------- Rendering helpers ----------
// 이제 빈칸은 "출석"이 아니라 "결석"으로 계산됩니다 — 명시적으로 ✓를 클릭해야
// 출석으로 집계됩니다. (전에는 "빈칸=출석"이었습니다.)
function isPresentValue(v) {
  return v === '✓';
}

function classifyCell(v) {
  if (v === '') return 'blank';
  if (v === '✓') return 'present';
  if (v === 'X') return 'absent';
  return 'tag';
}

// 짧게 스쳐가는 상태 메시지(저장 중/실패/안내 등)는 조회 날짜 칸 바로 오른쪽의
// 작은 인라인 표시(lookupStatus)에 나타났다가 일정 시간 후 자동으로 사라집니다.
function showToast(msg) {
  const el = document.getElementById('lookupStatus');
  if (!el) return;
  el.textContent = msg;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.textContent = ''; }, 3200);
}

// 지금 화면에 어떤 날짜가 떠 있는지 알려주는 라벨은 자동으로 사라지지 않고,
// 다른 날짜를 고르기 전까지 계속 보입니다 (showToast와 달리 타이머가 없습니다).
function setLookupLabel(msg) {
  const el = document.getElementById('lookupStatus');
  if (!el) return;
  clearTimeout(el._timer);
  el.textContent = msg;
}

function showCurrentDateLabel() {
  if (!state.date) return;
  setLookupLabel(`${formatDateKoreanMD(state.date)} 출석 데이터입니다.`);
}

function formatDateMDY(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const [y, m, d] = parts;
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
}

// "8월 16일" 형식 — 조회 결과를 계속 보여주는 라벨에 사용합니다.
function formatDateKoreanMD(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const [y, m, d] = parts;
  return `${parseInt(m, 10)}월 ${parseInt(d, 10)}일`;
}

function updateCurrentDateLabel() {
  const el = document.getElementById('currentDateLabel');
  if (el) el.textContent = state.date ? `이번 주: ${formatDateMDY(state.date)}` : '';
}

// Turns a raw {members, extra, ...} API payload into state fields. Shared by
// every place that loads a week's data, so the mapping logic lives in one spot.
function applyWeekPayload(dateVal, payload, isCurrentWeek) {
  state.date = dateVal;
  state.members = (payload.members || []).map(m => ({
    id: Number(m.id), name: m.name || '', samter: m.samter || '', nam: m.nam || '', yeo: m.yeo || '',
    gender: m.gender || '',
  }));
  state.extra = payload.extra || { kids: 0, youth: 0, visitors: 0 };
  state.readonly = !isCurrentWeek;
  state.weekStarted = !!payload.weekStarted;

  const highestId = state.members.reduce((max, m) => Math.max(max, m.id), 240);
  MAX_ID = Math.max(240, Math.ceil(highestId / 20) * 20);
}

// Counts how many of the 201~MAX_ID EM-section members are currently present.
function countEmPresent() {
  let count = 0;
  state.members.forEach(m => {
    if (!m.name) return;
    if (m.id < 201 || m.id > MAX_ID) return;
    const single = !m.name.includes('/');
    if (single) {
      const activeSlot = m.gender === 'nam' ? 'nam' : 'yeo';
      if (isPresentValue(m[activeSlot])) count++;
    } else {
      if (isPresentValue(m.nam)) count++;
      if (isPresentValue(m.yeo)) count++;
    }
  });
  return count;
}

function renderSummary() {
  let presentCount = 0, absentCount = 0;
  const tagCounts = { 환우: 0, 타교: 0, 한국: 0, 타주: 0, 장결: 0, 귀국: 0 };

  state.members.forEach(m => {
    if (!m.name) return; // skip blank future-registration rows
    // EM 구역(201번 이상)은 총원/출석/결석 집계에서 완전히 제외됩니다 —
    // 별도의 "EM" 칩(countEmPresent)에서만 따로 집계됩니다.
    if (m.id >= 201) return;
    const single = !m.name.includes('/');
    let slots;
    if (single) {
      const activeSlot = m.gender === 'nam' ? 'nam' : 'yeo';
      slots = [m[activeSlot]];
    } else {
      slots = [m.nam, m.yeo];
    }
    slots.forEach(v => {
      // 타교/타주/귀국은 총원(=출석+결석) 집계에서 완전히 제외됩니다 — 아래 상태별
      // 칩(타교/타주/귀국)에서만 별도로 카운트합니다. "한국"(일시 귀국)은 계속 포함됩니다.
      if (EXCLUDE_FROM_TOTAL.indexOf(v) !== -1) {
        tagCounts[v]++;
        return;
      }
      if (isPresentValue(v)) presentCount++;
      else {
        absentCount++;
        if (tagCounts[v] !== undefined) tagCounts[v]++;
      }
    });
  });

  // 총원: 이름이 있는 남/여 칸 수를 모두 합한 전체 등록 인원 (EM 구역, 타교/타주/귀국 제외)
  const totalCount = presentCount + absentCount;

  const extra = state.extra || { kids: 0, youth: 0, visitors: 0 };
  const kids = Number(extra.kids) || 0;
  const youth = Number(extra.youth) || 0;
  const visitors = Number(extra.visitors) || 0;

  // 출석 표시 숫자에는 방문자만 더합니다 — 유,초등부/중고등부/EM은 각자 따로
  // 카운트되므로(별도 칩) 여기에는 포함하지 않습니다.
  const displayedPresent = presentCount + visitors;

  // EM 칸: 상태 태그 개수가 아니라 201~MAX_ID EM 구역의 이번 주 출석 인원 수
  const emPresentCount = countEmPresent();

  // 아직 아무 칸도 클릭/저장하지 않은 새 주에는 총원~EM까지 전부 0으로 보여줍니다.
  const showZero = !state.readonly && !state.weekStarted;

  const dTotal = showZero ? 0 : totalCount;
  const dPresent = showZero ? 0 : displayedPresent;
  const dAbsent = showZero ? 0 : absentCount;
  const dTags = showZero
    ? { 환우: 0, 타교: 0, 한국: 0, 타주: 0, 장결: 0, 귀국: 0 }
    : tagCounts;
  const dEm = showZero ? 0 : emPresentCount;

  // 유초등부/중고등부/방문자는 언제든 편집 가능합니다 — 지난 기록은 saveField와
  // 마찬가지로 해당 날짜의 기록에 바로 저장됩니다.
  const extraInputsHTML = `
    <div class="chip extra">유,초등부: <input type="number" min="0" class="extraInput" data-key="kids" value="${kids}">명</div>
    <div class="chip extra">중고등부: <input type="number" min="0" class="extraInput" data-key="youth" value="${youth}">명</div>
    <div class="chip extra">방문자: <input type="number" min="0" class="extraInput" data-key="visitors" value="${visitors}">명</div>
  `;

  document.getElementById('summaryBar').innerHTML = `
    <div class="chip total">총원 <b>${dTotal}</b>명</div>
    <div class="chip present">출석 <b>${dPresent}</b></div>
    <div class="chip absent">결석 <b>${dAbsent}</b></div>
    <div class="chip">환우 <b>${dTags['환우']}</b></div>
    <div class="chip">타교 <b>${dTags['타교']}</b></div>
    <div class="chip">타주 <b>${dTags['타주']}</b></div>
    <div class="chip">장결 <b>${dTags['장결']}</b></div>
    <div class="chip">한국 <b>${dTags['한국']}</b></div>
    <div class="chip">귀국 <b>${dTags['귀국']}</b></div>
    <div class="chip" title="201~${MAX_ID}번 EM 구역의 이번 주 출석 인원">EM <b>${dEm}</b></div>
    ${extraInputsHTML}
  `;

  document.querySelectorAll('.extraInput').forEach(inp => {
    inp.addEventListener('change', e => {
      const key = e.target.dataset.key;
      const val = Math.max(0, parseInt(e.target.value, 10) || 0);
      if (!state.extra) state.extra = { kids: 0, youth: 0, visitors: 0 };
      state.extra[key] = val;
      renderSummary();
      if (state.readonly) {
        apiUpdateHistoricalExtra(state.date, key, val);
      } else {
        apiSetExtra(key, val);
      }
    });
  });
}

function buildCellHTML(memberId, gender, value, hidden) {
  if (hidden) {
    return `<span class="cellbox hidden-slot"></span>`;
  }
  const cls = classifyCell(value);
  const label = value === '' ? '' : value;
  return `<span class="cellbox ${cls}" data-id="${memberId}" data-gender="${gender}">${label}</span>`;
}

// True if either of the member's applicable status slots is 타교/타주/귀국 —
// used to color the whole name red (couples can't be split visually since
// their name is one combined text, so either spouse triggers it for the row).
function hasExcludedStatus(m) {
  return EXCLUDE_FROM_TOTAL.indexOf(m.nam) !== -1 || EXCLUDE_FROM_TOTAL.indexOf(m.yeo) !== -1;
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

  const showEdit = editMode;
  const nameClass = hasExcludedStatus(m) ? 'nameText excluded' : 'nameText';

  return `
  <tr>
    <td class="num">${m.id}</td>
    <td class="name">
      <span class="nameView" style="display:${showEdit ? 'none' : ''}"><span class="${nameClass}">${m.name}</span>${flag}</span>
      <input class="nameEdit" style="display:${showEdit ? '' : 'none'}" data-id="${m.id}" value="${m.name}">
    </td>
    <td class="samter">
      <span class="samterView" style="display:${showEdit ? 'none' : ''}">${m.samter || ''}</span>
      <input class="samterEdit" style="display:${showEdit ? '' : 'none'}" data-id="${m.id}" value="${m.samter || ''}" maxlength="6">
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
    saveField(id, newGender, val);
    saveField(id, oldGender, '');
  }
  m.gender = newGender;
  saveField(id, 'gender', newGender);
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
  const root = document.getElementById('gridRoot');
  let html = '';
  for (let start = 1; start <= MAX_ID; start += 20) {
    const end = start + 19;
    const list = state.members.filter(m => m.id >= start && m.id <= end);
    const nameHeader = start >= 201 ? 'Name' : '이름';
    html += `
      <div class="block">
        <table>
          <colgroup>
            <col class="col-num"><col class="col-name"><col class="col-samter"><col class="col-cell"><col class="col-cell">
          </colgroup>
          <thead><tr><th>#</th><th>${nameHeader}</th><th>샘터</th><th>남</th><th>여</th></tr></thead>
          <tbody>${list.map(rowHTML).join('')}</tbody>
        </table>
      </div>
    `;
  }
  root.innerHTML = html;

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
  saveField(id, gender, '');
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
    saveField(id, gender, '✓');
    renderGrid(); renderSummary();
    return;
  }
  if (current === '✓') {
    m[gender] = 'X';
    saveField(id, gender, 'X');
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
      saveField(id, gender, v);
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
  saveField(id, gender, '');
  renderGrid(); renderSummary();
}

function koreanCompare(a, b) {
  return a.localeCompare(b, 'ko');
}

// 일반 교인은 1~200번(가나다순), EM(영어이름) 교인은 201~MAX_ID번(알파벳순)에
// 따로 분리되어 관리됩니다 — 두 구역은 서로 섞이지 않습니다.
// (지난 기록 편집 중에는 재정렬을 하지 않습니다 — 아래 attachEditHandlers 참고.)
function resortPartition(startId, endId, compareFn) {
  const partition = state.members.filter(m => m.id >= startId && m.id <= endId);
  const others = state.members.filter(m => m.id < startId || m.id > endId);

  const named = partition.filter(m => m.name && m.name.trim() !== '');
  named.sort((a, b) => compareFn(a.name, b.name));

  const newPartition = named.map((m, idx) => Object.assign({}, m, { id: startId + idx }));
  const blanksCount = (endId - startId + 1) - newPartition.length;
  for (let i = 0; i < blanksCount; i++) {
    newPartition.push({ id: startId + newPartition.length, name: '', samter: '', nam: '', yeo: '', gender: '' });
  }

  state.members = others.concat(newPartition).sort((a, b) => a.id - b.id);
  return state.members;
}

// If the very last EM slot (MAX_ID) has just been filled, the EM section is
// completely full — automatically append 20 more slots after it.
function checkAndExpandCapacity() {
  const last = findMember(MAX_ID);
  if (last && last.name && last.name.trim() !== '') {
    const newMax = MAX_ID + 20;
    for (let i = MAX_ID + 1; i <= newMax; i++) {
      state.members.push({ id: i, name: '', samter: '', nam: '', yeo: '', gender: '' });
    }
    MAX_ID = newMax;
    return true;
  }
  return false;
}

async function resortAndSave(startId, endId, compareFn) {
  resortPartition(startId, endId, compareFn);
  const expanded = checkAndExpandCapacity();
  renderGrid();
  renderSummary();

  if (!hasAnyNamedMember(state.members)) {
    showToast('저장을 건너뛰었습니다 — 명단이 비정상적으로 비어 보여서 안전을 위해 중단했습니다. "저장 및 동기화"를 눌러 서버 상태를 다시 확인해 주세요.');
    return;
  }

  showToast('정렬했습니다. 저장 중...');
  try {
    await apiBulkSave(state.members);
    showToast('저장 완료' + (expanded ? ` (${MAX_ID}번까지 자리를 늘렸습니다)` : ''));
  } catch (err) {
    showToast('저장 실패: ' + err.message + ' — "저장 및 동기화"로 다시 확인해 주세요.');
  }
}

function attachEditHandlers() {
  document.querySelectorAll('.nameEdit, .samterEdit').forEach(inp => {
    inp.addEventListener('change', e => {
      const id = Number(e.target.dataset.id);
      const m = findMember(id);
      const isName = e.target.classList.contains('nameEdit');
      const newValue = e.target.value.trim();

      if (isName) {
        const oldWasBlank = !m.name;
        const newIsBlank = !newValue;
        m.name = newValue;
        // 재정렬(가나다순 자동 정렬)은 "현재 주"에서만 동작합니다 — 지난 기록은
        // 순서를 그대로 유지한 채 그 자리의 값만 바꿉니다.
        if (!state.readonly && oldWasBlank !== newIsBlank) {
          const isEM = id >= 201;
          const range = isEM ? [201, MAX_ID] : [1, 200];
          const cmp = isEM ? (a, b) => a.localeCompare(b) : koreanCompare;
          resortAndSave(range[0], range[1], cmp);
          return;
        }
      } else {
        m.samter = newValue;
      }
      saveField(id, isName ? 'name' : 'samter', newValue);
    });
  });
}

function setEditMode(on) {
  editMode = on;
  document.getElementById('editModeBtn').textContent = on ? '편집 완료' : '편집 모드';
  renderGrid();
}

// 지난 기록/새로 만든 빈 주를 보는 중이어도 별도 배너는 표시하지 않습니다.
function updateReadonlyBanner() {
  const el = document.getElementById('readonlyBanner');
  if (!el) return;
  el.style.display = 'none';
  el.innerHTML = '';
}

// Applies a fetched week's data (from apiGetWeek) into state and re-renders.
function applyFetchedWeek(dateVal, res) {
  applyWeekPayload(dateVal, res, !!res.isCurrent);

  editMode = false;
  document.getElementById('editModeBtn').textContent = '편집 모드';
  updateCurrentDateLabel();
  renderGrid();
  renderSummary();
  updateReadonlyBanner();

  const lookupInput = document.getElementById('lookupDate');
  if (lookupInput) lookupInput.value = dateVal;
}

// ---------- Init & top bar wiring ----------
// 메인 화면은 항상 "가장 최근에 실제로 저장된 주"를 보여줍니다 — 단순히 설정
// 시트의 날짜만 믿지 않고, 기록 시트에 더 최근 주차가 있으면 그쪽을 우선해서
// 보여줍니다.
//
// 속도 개선: apiGet()(현재 주 전체 데이터)과 apiGetHistoryDates()(날짜 목록만)를
// 순서대로 기다리지 않고 동시에 요청합니다(Promise.all) — 초기 로딩이 두 번의
// 왕복 시간을 다 합친 것만큼 걸리던 걸, 더 느린 쪽 하나만큼으로 줄여줍니다.
//
// Returns true on success, false on failure — callers that chain further
// destructive operations (like "저장 및 동기화") MUST check this and abort
// if false, instead of proceeding with a possibly-empty state.members.
async function loadAndRender() {
  try {
    const [data, histDates] = await Promise.all([apiGet(), apiGetHistoryDates()]);
    if (data.error) throw new Error(data.error);

    let latestDate = data.date || '';
    if (!histDates.error && histDates.dates && histDates.dates.length) {
      const lastHistDate = histDates.dates[histDates.dates.length - 1];
      if (!latestDate || lastHistDate > latestDate) {
        latestDate = lastHistDate;
      }
    }

    if (!latestDate || latestDate === data.date) {
      // 아무 데이터도 없거나, 설정 시트의 현재 주가 곧 최신 주인 일반적인 경우.
      applyWeekPayload(data.date || '', data, true);
    } else {
      // 기록 시트에 설정 시트보다 더 최근 주차가 있음 — 그쪽을 메인 화면에 띄웁니다.
      const res = await apiGetWeek(latestDate);
      if (res.error || !res.found) throw new Error('최근 주차 데이터를 불러오지 못했습니다');
      applyWeekPayload(latestDate, res, !!res.isCurrent);
    }

    updateCurrentDateLabel();
    // 조회 날짜 칸은 항상 지금 화면에 떠 있는 날짜로 맞춰줍니다.
    const lookupInput = document.getElementById('lookupDate');
    if (lookupInput) lookupInput.value = state.date;
    renderGrid();
    renderSummary();
    updateReadonlyBanner();
    showCurrentDateLabel();
    return true;
  } catch (err) {
    showToast('서버 연결 실패: ' + err.message + ' (app.js의 CONFIG.API_URL을 확인해 주세요)');
    return false;
  }
}

document.getElementById('editModeBtn').addEventListener('click', () => setEditMode(!editMode));

// 날짜 칸에서 날짜를 고르면(change) 별도 버튼 없이 그 즉시 조회/새 출결 등록이
// 진행됩니다. 하는 일은 두 가지입니다.
// 1) 이미 데이터가 있는 날짜 → 그대로 불러옵니다(현재 주면 편집 가능, 지난
//    기록이면 그 자리에서 수정 시 그 날짜에 바로 저장).
// 2) 데이터가 없는 날짜(과거든 미래든) → "새로 출결을 입력하시겠습니까?" 확인 후
//    - 예 → 빈 출석 화면으로 바로 전환합니다. 선택한 날짜가 지금 진행 중인
//      주와 같거나 미래면 그 주로 전환(현재 주는 기록으로 보관), 과거의
//      빈 주일이면 지금 진행 중인 주는 전혀 건드리지 않고 "기록" 시트에만
//      새 빈 항목을 만듭니다.
//    - 아니오 → 화면은 그대로 유지됩니다 (날짜 칸만 원래대로 되돌립니다).
// 결과 메시지("8월 16일 출석 데이터입니다.")는 showToast와 달리 자동으로
// 사라지지 않고, 다른 날짜를 고르기 전까지 계속 보입니다(setLookupLabel).
document.getElementById('lookupDate').addEventListener('change', async e => {
  const dateVal = e.target.value;
  if (!dateVal) return;
  showToast('데이터를 확인하는 중...');
  try {
    const res = await apiGetWeek(dateVal);
    if (res.error) throw new Error(res.error);

    if (res.found) {
      applyFetchedWeek(dateVal, res);
      showCurrentDateLabel();
      return;
    }

    const proceed = confirm(`${formatDateMDY(dateVal)}에는 데이터가 없습니다.\n새로 출결을 입력하시겠습니까?`);
    if (!proceed) {
      e.target.value = state.date; // 취소하면 날짜 칸도 원래 보던 날짜로 되돌립니다.
      showCurrentDateLabel();
      return;
    }

    // 실제 "현재 진행 중인 주" 날짜를 확인해서, 선택한 날짜가 그보다
    // 미래(또는 같은 날)인지 과거인지에 따라 처리 방식을 나눕니다.
    const cur = await apiGet();
    if (cur.error) throw new Error(cur.error);
    const isFutureOrSame = !cur.date || dateVal >= cur.date;

    if (isFutureOrSame) {
      const newRes = await apiNewWeek(dateVal);
      if (newRes.error) throw new Error(newRes.error);
      await loadAndRender();
      showCurrentDateLabel();
    } else {
      // 이미 지나간, 비어있는 주 — 현재 진행 중인 주는 그대로 두고 기록
      // 시트에만 빈 항목을 새로 만들어서 바로 입력할 수 있게 합니다.
      const created = await apiCreateBlankHistoricalWeek(dateVal);
      if (created.error) throw new Error(created.error);
      const loaded = await apiGetWeek(dateVal);
      if (loaded.error || !loaded.found) throw new Error('새로 만든 기록을 불러오지 못했습니다');
      applyFetchedWeek(dateVal, loaded);
      showCurrentDateLabel();
    }
  } catch (err) {
    showToast('처리 실패: ' + err.message);
  }
});

// "저장 및 동기화": 지난 기록을 보는 중이면, 먼저 자동으로 최신 주로 돌아간
// 뒤(loadAndRender) 이어서 진행합니다.
// 순서: 1) 최신 주로 돌아가기(필요시) → 2) 현재 화면을 저장 → 3) 서버 최신
// 상태를 다시 불러오고 → 4) 1~200번, 201~MAX_ID번 두 구역의 빈 칸(중간에 생긴
// 갭)을 자동으로 압축 정리 → 5) 정리된 결과를 다시 저장합니다.
//
// 안전장치(중요): 3단계의 새로고침(loadAndRender)이 네트워크 문제 등으로 실패하면
// 여기서 즉시 중단합니다 — 예전에는 이 실패를 무시하고 계속 진행하다가, 빈 상태를
// 그대로 서버에 덮어써서 전체 명단이 지워지는 사고가 있었습니다. 또한 최종 저장
// 직전에도 명단이 비정상적으로 비어있지 않은지 한 번 더 확인합니다.
document.getElementById('syncBtn').addEventListener('click', async () => {
  if (state.readonly) {
    showToast('최신 주로 돌아가는 중...');
    const backOk = await loadAndRender();
    if (!backOk) return;
  }

  if (hasAnyNamedMember(state.members)) {
    showToast('현재 화면을 서버에 저장하는 중...');
    try {
      await apiBulkSave(state.members);
    } catch (err) {
      showToast('저장 중 오류가 발생했습니다: ' + err.message);
    }
  } else {
    showToast('현재 화면에 이름이 없어 1단계 저장은 건너뛰고, 서버 데이터부터 다시 불러옵니다...');
  }

  showToast('서버에서 최신 데이터를 다시 불러옵니다...');
  const loaded = await loadAndRender();
  if (!loaded) {
    showToast('서버에서 최신 데이터를 불러오지 못해 동기화를 중단했습니다. 데이터는 그대로 안전합니다 — 인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
    return;
  }

  resortPartition(1, 200, koreanCompare);
  resortPartition(201, MAX_ID, (a, b) => a.localeCompare(b));
  const expanded = checkAndExpandCapacity();
  renderGrid();
  renderSummary();

  if (!hasAnyNamedMember(state.members)) {
    showToast('저장을 중단했습니다 — 명단이 비정상적으로 비어 보입니다. 페이지를 새로고침해서 다시 확인해 주세요 (기존 서버 데이터는 안전합니다).');
    return;
  }

  try {
    await apiBulkSave(state.members);
    showToast('저장 및 동기화 완료 (빈 칸 정리 포함)' + (expanded ? ` — ${MAX_ID}번까지 자리를 늘렸습니다` : ''));
    setTimeout(showCurrentDateLabel, 3300);
  } catch (err) {
    showToast('정리된 내용 저장 실패: ' + err.message);
  }
});

// ---------- 자료 제출: 결석자 리포트 ----------

// Returns the (name, samter, gender-label, applicable-slot) list of "real"
// attendance slots to track: couples => both nam & yeo; singles => whichever slot is active.
// 타교/타주/귀국 상태인 사람(또는 슬롯)은 결석자 명단 계산에서 아예 제외합니다.
function getTrackedSlots() {
  const slots = [];
  state.members.forEach(m => {
    if (!m.name) return; // skip blank future-registration rows
    const single = !m.name.includes('/');
    if (single) {
      const activeSlot = m.gender === 'nam' ? 'nam' : 'yeo';
      if (EXCLUDE_FROM_TOTAL.indexOf(m[activeSlot]) !== -1) return;
      slots.push({ id: m.id, name: m.name, samter: m.samter || '', slot: activeSlot, label: '' });
    } else {
      if (EXCLUDE_FROM_TOTAL.indexOf(m.nam) === -1) {
        slots.push({ id: m.id, name: m.name, samter: m.samter || '', slot: 'nam', label: '(남편)' });
      }
      if (EXCLUDE_FROM_TOTAL.indexOf(m.yeo) === -1) {
        slots.push({ id: m.id, name: m.name, samter: m.samter || '', slot: 'yeo', label: '(아내)' });
      }
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
      "조회"로 보관된 지난 주차 기록(기록 시트)과 현재 화면 데이터를 기준으로 계산했습니다. 타교·타주·귀국 상태인 사람은 명단에서 제외됩니다. 3주 이상 결석한 사람은 1주·2주 명단에는 중복 표시되지 않고 최종 해당하는 칸에만 한 번 나타납니다.
      기록이 없는 사람(신규 등록 등)은 해당 기간만큼만 계산되며, 자동 기록이 쌓일수록 정확해집니다.
    </div>
  `;
}

// This-week-only absentees, grouped by 샘터 번호 (ascending).
// 타교/타주/귀국 상태인 사람(슬롯)은 여기서도 제외됩니다.
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
      if (EXCLUDE_FROM_TOTAL.indexOf(v) !== -1) return;
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
    <div class="report-note">이번 주(${formatDateMDY(state.date)}) 현재 데이터를 기준으로 샘터 번호 순으로 정리했습니다 (타교·타주·귀국 제외).</div>
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
      showCurrentDateLabel();
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
