/* =========================================================
   頻道控制室 · YT 營運儀表板
   資料來源:你自己 GitHub 上的一份私密 repo 裡的 schedule.json
   這支檔案本身不含任何個資或商業資料 —— 資料永遠留在你的私密 repo,
   Token 只會存在你目前這台裝置的瀏覽器 localStorage。
   ========================================================= */

const GH_API = 'https://api.github.com';
const SETTINGS_KEY = 'ytops_settings_v1';
const DEFAULT_CATEGORY_COLOR = '#8B8F97';
const PRIORITY_LABEL = { high: '高', medium: '中', low: '低' };
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const DAY_WIDTH = 26;
const ROW_HEIGHT = 32;

let settings = null;           // {owner, repo, branch, path, token}
let store = { categories: {}, tasks: [] };
let fileSha = null;
let currentView = 'todo';
let calendarCursor = new Date();

/* ---------------- Init ---------------- */

document.addEventListener('DOMContentLoaded', init);

async function init(){
  settings = loadSettings();
  bindNav();
  bindGlobalButtons();
  renderTodayWidget();
  if(!settings || !settings.token || !settings.owner || !settings.repo){
    openSettingsModal(true);
    return;
  }
  await loadAndRender();
}

function bindNav(){
  document.querySelectorAll('.nav-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      currentView = btn.dataset.view;
      document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));
      document.getElementById('view-'+currentView).classList.remove('hidden');
      document.getElementById('view-title').textContent =
        {todo:'代辦事項', calendar:'行事曆', gantt:'時程總覽'}[currentView];
    });
  });
}

function bindGlobalButtons(){
  document.getElementById('btn-settings').addEventListener('click', ()=> openSettingsModal(false));
  document.getElementById('btn-add-task').addEventListener('click', ()=> openTaskModal(null));
}

/* ---------------- Settings (local only) ---------------- */

function loadSettings(){
  try{
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
function saveSettings(s){ localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

function openSettingsModal(forced){
  const s = settings || {};
  document.getElementById('modal-root').innerHTML = `
    <div class="modal-overlay">
      <div class="modal">
        <h3>連線到你的 GitHub 資料庫</h3>
        <p class="modal-hint">這些資訊只存在這台裝置的瀏覽器裡,不會上傳到任何地方(除了你自己的 GitHub)。</p>
        <label>GitHub 帳號 (owner)<input id="set-owner" value="${escapeHtml(s.owner||'')}" placeholder="例如 yourname"></label>
        <label>私密資料 repo 名稱<input id="set-repo" value="${escapeHtml(s.repo||'')}" placeholder="例如 yt-ops-data"></label>
        <label>分支 (branch)<input id="set-branch" value="${escapeHtml(s.branch||'main')}"></label>
        <label>資料檔案路徑<input id="set-path" value="${escapeHtml(s.path||'schedule.json')}"></label>
        <label>Personal Access Token<input id="set-token" type="password" value="${escapeHtml(s.token||'')}" placeholder="github_pat_..."></label>
        <div class="modal-actions">
          ${forced ? '' : '<button id="modal-cancel" class="btn-ghost">取消</button>'}
          <button id="modal-save" class="btn-primary">儲存並連線</button>
        </div>
      </div>
    </div>`;
  const cancelBtn = document.getElementById('modal-cancel');
  if(cancelBtn) cancelBtn.addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', async ()=>{
    settings = {
      owner: val('set-owner'),
      repo: val('set-repo'),
      branch: val('set-branch') || 'main',
      path: val('set-path') || 'schedule.json',
      token: val('set-token')
    };
    saveSettings(settings);
    closeModal();
    await loadAndRender();
  });
}

/* ---------------- GitHub API ---------------- */

async function ghRequest(path, options={}){
  const res = await fetch(GH_API + path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${settings.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
  if(!res.ok){
    const body = await res.text().catch(()=> '');
    throw new Error(`GitHub API ${res.status} ${res.statusText} ${body ? '· ' + body.slice(0,200) : ''}`);
  }
  return res.json();
}

function utf8ToBase64(str){
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}
function base64ToUtf8(b64){
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function fetchScheduleFile(){
  const branch = settings.branch || 'main';
  const data = await ghRequest(`/repos/${settings.owner}/${settings.repo}/contents/${settings.path}?ref=${branch}`);
  fileSha = data.sha;
  return JSON.parse(base64ToUtf8(data.content));
}

async function saveScheduleFile(newStore, message){
  const branch = settings.branch || 'main';
  const content = utf8ToBase64(JSON.stringify(newStore, null, 2));
  const res = await ghRequest(`/repos/${settings.owner}/${settings.repo}/contents/${settings.path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content, branch, sha: fileSha })
  });
  fileSha = res.content.sha;
}

async function loadAndRender(){
  setSyncStatus('讀取中…');
  try{
    store = await fetchScheduleFile();
    if(!store.categories) store.categories = {};
    if(!store.tasks) store.tasks = [];
    setSyncStatus('已連線 · ' + new Date().toLocaleTimeString('zh-TW'));
    renderLegend();
    renderAll();
  }catch(err){
    console.error(err);
    setSyncStatus('連線失敗,請檢查設定', true);
    showToast('讀取失敗:' + err.message, 'error');
  }
}

async function persist(message){
  setSyncStatus('儲存中…');
  try{
    await saveScheduleFile(store, message);
    setSyncStatus('已儲存 · ' + new Date().toLocaleTimeString('zh-TW'));
    renderLegend();
    renderAll();
    showToast('已同步到 GitHub', 'ok');
  }catch(err){
    console.error(err);
    setSyncStatus('儲存失敗', true);
    showToast('儲存失敗:' + err.message, 'error');
  }
}

/* ---------------- Rendering: shared ---------------- */

function renderAll(){
  renderTodoView();
  renderCalendarView();
  renderGanttView();
  renderTodayWidget();
}

function renderLegend(){
  document.getElementById('legend').innerHTML = Object.entries(store.categories).map(([name,color])=>
    `<span class="legend-item"><i style="background:${color}"></i>${escapeHtml(name)}</span>`
  ).join('');
}

function renderTodayWidget(){
  const el = document.getElementById('today-widget');
  const today = todayStr();
  const activeToday = (store.tasks||[]).filter(t => t.startDate <= today && today <= t.endDate);
  const weekday = ['日','一','二','三','四','五','六'][new Date().getDay()];
  el.innerHTML = `
    <div class="today-date">${today.replace(/-/g,'/')} <span>(週${weekday})</span></div>
    <div class="today-count">${activeToday.length} 項任務進行中</div>`;
}

function setSyncStatus(text, isError){
  const el = document.getElementById('sync-status');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}
function showToast(msg, type){
  const root = document.getElementById('toast-root');
  const t = document.createElement('div');
  t.className = `toast ${type||'ok'}`;
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(()=> t.remove(), 3500);
}
function closeModal(){ document.getElementById('modal-root').innerHTML = ''; }
function val(id){ return document.getElementById(id).value.trim(); }
function escapeHtml(str){
  return String(str==null?'':str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function randomColor(){
  const palette = ['#3FA66A','#C9A227','#5D7FD9','#B95DC9','#4FB3BF','#D97B4F'];
  return palette[Math.floor(Math.random()*palette.length)];
}

/* ---------------- Date helpers ---------------- */

function dateToStr(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function todayStr(){ return dateToStr(new Date()); }
function parseDate(str){ return new Date(str + 'T00:00:00'); }
function addDays(d,n){ const r = new Date(d); r.setDate(r.getDate()+n); return r; }
function daysBetween(a,b){ return Math.round((b-a)/86400000); }
function fmtRange(s,e){
  const f = x => x.slice(5).replace('-','/');
  return s===e ? f(s) : `${f(s)} → ${f(e)}`;
}
function dotsFor(p){
  const n = p==='high'?3:p==='medium'?2:1;
  return '●'.repeat(n) + '○'.repeat(3-n);
}

/* ---------------- Task modal (add / edit / delete) ---------------- */

function openTaskModal(existingTask){
  const t = existingTask || {
    id:null, category:Object.keys(store.categories)[0]||'', project:'', task:'',
    owner:'我', startDate: todayStr(), endDate: todayStr(), priority:'medium', status:'待處理', note:''
  };
  const categoryOptions = Object.keys(store.categories).map(c=>
    `<option value="${escapeHtml(c)}" ${c===t.category?'selected':''}>${escapeHtml(c)}</option>`
  ).join('') + `<option value="__new__">+ 新增分類...</option>`;

  document.getElementById('modal-root').innerHTML = `
    <div class="modal-overlay">
      <div class="modal">
        <h3>${existingTask ? '編輯任務' : '新增任務'}</h3>
        <label>分類<select id="tf-category">${categoryOptions}</select></label>
        <label>專案名稱<input id="tf-project" value="${escapeHtml(t.project)}"></label>
        <label>任務內容<input id="tf-task" value="${escapeHtml(t.task)}"></label>
        <label>負責人/協作方<input id="tf-owner" value="${escapeHtml(t.owner)}"></label>
        <div class="row-2">
          <label>開始日期<input type="date" id="tf-start" value="${t.startDate}"></label>
          <label>結束/死線<input type="date" id="tf-end" value="${t.endDate}"></label>
        </div>
        <div class="row-2">
          <label>重要程度
            <select id="tf-priority">
              <option value="high" ${t.priority==='high'?'selected':''}>高</option>
              <option value="medium" ${t.priority==='medium'?'selected':''}>中</option>
              <option value="low" ${t.priority==='low'?'selected':''}>低</option>
            </select>
          </label>
          <label>狀態<input id="tf-status" value="${escapeHtml(t.status)}" placeholder="待處理 / 進行中 / 已完成"></label>
        </div>
        <label>備註<textarea id="tf-note">${escapeHtml(t.note||'')}</textarea></label>
        <div class="modal-actions">
          ${existingTask ? '<button id="modal-delete" class="btn-danger">刪除</button>' : ''}
          <button id="modal-cancel" class="btn-ghost">取消</button>
          <button id="modal-save" class="btn-primary">儲存</button>
        </div>
      </div>
    </div>`;

  document.getElementById('tf-category').addEventListener('change', (e)=>{
    if(e.target.value === '__new__'){
      const name = prompt('新分類名稱：');
      if(name && name.trim()){
        store.categories[name.trim()] = randomColor();
        openTaskModal({...t, category:name.trim()});
      }else{
        e.target.value = t.category;
      }
    }
  });
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', async ()=>{
    const updated = {
      id: t.id || ('t' + Date.now()),
      category: val('tf-category'),
      project: val('tf-project'),
      task: val('tf-task'),
      owner: val('tf-owner'),
      startDate: val('tf-start'),
      endDate: val('tf-end') || val('tf-start'),
      priority: val('tf-priority'),
      status: val('tf-status'),
      note: document.getElementById('tf-note').value.trim()
    };
    if(existingTask){
      const idx = store.tasks.findIndex(x=>x.id===t.id);
      store.tasks[idx] = updated;
    }else{
      store.tasks.push(updated);
    }
    closeModal();
    await persist(existingTask ? `更新任務: ${updated.task}` : `新增任務: ${updated.task}`);
  });
  if(existingTask){
    document.getElementById('modal-delete').addEventListener('click', async ()=>{
      if(confirm('確定要刪除這個任務嗎？')){
        store.tasks = store.tasks.filter(x=>x.id!==t.id);
        closeModal();
        await persist(`刪除任務: ${t.task}`);
      }
    });
  }
}

/* ---------------- Todo view ---------------- */

function renderTodoView(){
  const el = document.getElementById('view-todo');
  const tasks = [...(store.tasks||[])].sort((a,b)=>
    (PRIORITY_ORDER[a.priority]-PRIORITY_ORDER[b.priority]) || a.startDate.localeCompare(b.startDate)
  );
  const byCategory = {};
  tasks.forEach(t => (byCategory[t.category] = byCategory[t.category]||[]).push(t));
  const today = todayStr();

  const html = Object.entries(byCategory).map(([cat, items])=>{
    const color = store.categories[cat] || DEFAULT_CATEGORY_COLOR;
    const rows = items.map(t=>{
      const overdue = t.endDate < today && t.status !== '已完成';
      return `
      <div class="task-row ${overdue?'overdue':''}">
        <span class="priority-dots" title="重要程度：${PRIORITY_LABEL[t.priority]||t.priority}">${dotsFor(t.priority)}</span>
        <div class="task-main">
          <div class="task-project">${escapeHtml(t.project)}</div>
          <div class="task-name">${escapeHtml(t.task)}</div>
        </div>
        <div class="task-meta">
          <span class="task-owner">${escapeHtml(t.owner)}</span>
          <span class="task-dates">${fmtRange(t.startDate,t.endDate)}</span>
          <span class="task-status">${escapeHtml(t.status)}</span>
        </div>
        <button class="task-edit" data-id="${t.id}">編輯</button>
      </div>`;
    }).join('');
    return `
    <section class="cat-group">
      <h3 class="cat-title" style="border-color:${color}"><i style="background:${color}"></i>${escapeHtml(cat)}<span class="cat-count">${items.length}</span></h3>
      <div class="task-list">${rows}</div>
    </section>`;
  }).join('');

  el.innerHTML = html || `<div class="empty-state">還沒有任務，點右上角「+ 新增任務」開始安排吧。</div>`;
  el.querySelectorAll('.task-edit').forEach(btn=>{
    btn.addEventListener('click', ()=> openTaskModal(store.tasks.find(x=>x.id===btn.dataset.id)));
  });
}

/* ---------------- Calendar view ---------------- */

function renderCalendarView(){
  const el = document.getElementById('view-calendar');
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const cells = buildMonthGrid(year, month);
  const today = todayStr();
  const weekdayHeaders = ['日','一','二','三','四','五','六'].map(w=>`<div class="cal-weekday">${w}</div>`).join('');

  const dayCells = cells.map(d=>{
    if(!d) return `<div class="cal-cell empty"></div>`;
    const ds = dateToStr(d);
    const items = (store.tasks||[]).filter(t => t.startDate<=ds && ds<=t.endDate);
    const chips = items.slice(0,3).map(t=>
      `<span class="cal-chip" style="background:${store.categories[t.category]||DEFAULT_CATEGORY_COLOR}">${escapeHtml(t.task)}</span>`
    ).join('');
    const more = items.length>3 ? `<span class="cal-more">+${items.length-3}</span>` : '';
    return `<div class="cal-cell ${ds===today?'is-today':''}" data-date="${ds}">
      <div class="cal-daynum">${d.getDate()}</div>
      <div class="cal-chips">${chips}${more}</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="cal-nav">
      <button id="cal-prev" class="btn-ghost">‹ 上個月</button>
      <h3>${year}年 ${month+1}月</h3>
      <button id="cal-next" class="btn-ghost">下個月 ›</button>
      <button id="cal-today" class="btn-ghost">回到今天</button>
    </div>
    <div class="cal-grid">${weekdayHeaders}${dayCells}</div>
    <div id="cal-day-detail" class="cal-day-detail"></div>`;

  document.getElementById('cal-prev').addEventListener('click', ()=>{ calendarCursor.setMonth(calendarCursor.getMonth()-1); renderCalendarView(); });
  document.getElementById('cal-next').addEventListener('click', ()=>{ calendarCursor.setMonth(calendarCursor.getMonth()+1); renderCalendarView(); });
  document.getElementById('cal-today').addEventListener('click', ()=>{ calendarCursor = new Date(); renderCalendarView(); });
  el.querySelectorAll('.cal-cell[data-date]').forEach(cell=>{
    cell.addEventListener('click', ()=> showDayDetail(cell.dataset.date));
  });
}

function showDayDetail(ds){
  const items = (store.tasks||[]).filter(t => t.startDate<=ds && ds<=t.endDate);
  const box = document.getElementById('cal-day-detail');
  box.innerHTML = `<h4>${ds.replace(/-/g,'/')}</h4>` + (items.length ? items.map(t=>`
    <div class="task-row">
      <span class="priority-dots">${dotsFor(t.priority)}</span>
      <div class="task-main"><div class="task-project">${escapeHtml(t.project)}</div><div class="task-name">${escapeHtml(t.task)}</div></div>
      <div class="task-meta"><span class="task-status">${escapeHtml(t.status)}</span></div>
      <button class="task-edit" data-id="${t.id}">編輯</button>
    </div>`).join('') : '<p class="empty-state">這天沒有排定任務。</p>');
  box.querySelectorAll('.task-edit').forEach(btn=>{
    btn.addEventListener('click', ()=> openTaskModal(store.tasks.find(x=>x.id===btn.dataset.id)));
  });
}

function buildMonthGrid(year, monthIndex){
  const startWeekday = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex+1, 0).getDate();
  const cells = [];
  for(let i=0;i<startWeekday;i++) cells.push(null);
  for(let d=1; d<=daysInMonth; d++) cells.push(new Date(year, monthIndex, d));
  return cells;
}

/* ---------------- Gantt view ---------------- */

function renderGanttView(){
  const el = document.getElementById('view-gantt');
  const tasks = store.tasks || [];
  if(!tasks.length){
    el.innerHTML = `<div class="empty-state">還沒有任務可以畫時程，先新增幾筆吧。</div>`;
    return;
  }
  const allStarts = tasks.map(t=>parseDate(t.startDate).getTime());
  const allEnds = tasks.map(t=>parseDate(t.endDate).getTime());
  const todayMs = parseDate(todayStr()).getTime();
  let rangeStart = new Date(Math.min(...allStarts, todayMs));
  let rangeEnd = new Date(Math.max(...allEnds, todayMs));
  rangeStart.setDate(rangeStart.getDate()-2);
  rangeEnd.setDate(rangeEnd.getDate()+5);
  const totalDays = daysBetween(rangeStart, rangeEnd)+1;

  const byCategory = {};
  [...tasks].sort((a,b)=>a.startDate.localeCompare(b.startDate)).forEach(t=>{
    (byCategory[t.category] = byCategory[t.category]||[]).push(t);
  });
  const rows = [];
  Object.entries(byCategory).forEach(([cat, items])=>{
    rows.push({type:'header', category:cat});
    items.forEach(t => rows.push({type:'task', task:t, category:cat}));
  });

  const labelsHtml = rows.map(r => r.type==='header'
    ? `<div class="gantt-label gantt-label-header" style="border-color:${store.categories[r.category]||DEFAULT_CATEGORY_COLOR}">${escapeHtml(r.category)}</div>`
    : `<div class="gantt-label"><span class="gantt-label-project">${escapeHtml(r.task.project)}</span><span class="gantt-label-task">${escapeHtml(r.task.task)}</span></div>`
  ).join('');

  let dayHeaderHtml = '', monthMarkers = '';
  for(let i=0;i<totalDays;i++){
    const d = addDays(rangeStart, i);
    const isWeekend = d.getDay()===0 || d.getDay()===6;
    dayHeaderHtml += `<div class="gantt-day ${isWeekend?'weekend':''}" style="left:${i*DAY_WIDTH}px">${d.getDate()}</div>`;
    if(d.getDate()===1 || i===0){
      monthMarkers += `<div class="gantt-month-marker" style="left:${i*DAY_WIDTH}px">${d.getMonth()+1}月</div>`;
    }
  }
  const todayOffset = daysBetween(rangeStart, parseDate(todayStr())) * DAY_WIDTH;

  const rowsHtml = rows.map(r=>{
    if(r.type==='header') return `<div class="gantt-row gantt-row-header"></div>`;
    const t = r.task;
    const startOffset = daysBetween(rangeStart, parseDate(t.startDate)) * DAY_WIDTH;
    const span = (daysBetween(parseDate(t.startDate), parseDate(t.endDate))+1) * DAY_WIDTH;
    const color = store.categories[t.category] || DEFAULT_CATEGORY_COLOR;
    return `<div class="gantt-row">
      <div class="gantt-bar" data-id="${t.id}" style="left:${startOffset}px;width:${Math.max(span-4,10)}px;background:${color}" title="${escapeHtml(t.project)} · ${escapeHtml(t.task)} (${t.startDate} ~ ${t.endDate})">
        <span>${escapeHtml(t.task)}</span>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="gantt-wrap">
      <div class="gantt-labels">
        <div class="gantt-label gantt-label-corner">分類 / 任務</div>
        ${labelsHtml}
      </div>
      <div class="gantt-scroll">
        <div class="gantt-timeline" style="width:${totalDays*DAY_WIDTH}px">
          <div class="gantt-header" style="width:${totalDays*DAY_WIDTH}px">${monthMarkers}${dayHeaderHtml}</div>
          <div class="gantt-today-line" style="left:${todayOffset}px; height:${rows.length*ROW_HEIGHT}px"></div>
          ${rowsHtml}
        </div>
      </div>
    </div>`;

  el.querySelectorAll('.gantt-bar').forEach(bar=>{
    bar.addEventListener('click', ()=> openTaskModal(store.tasks.find(x=>x.id===bar.dataset.id)));
  });
}
