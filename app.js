/* =========================================================
   頻道控制室 · YT 營運儀表板
   資料來源:你自己 GitHub 上的一份私密 repo 裡的 schedule.json
   這支檔案本身不含任何個資或商業資料 —— 資料永遠留在你的私密 repo,
   Token / API Key 只會存在你目前這台裝置的瀏覽器 localStorage。
   ========================================================= */

const GH_API = 'https://api.github.com';
const SETTINGS_KEY = 'ytops_settings_v1';
const DEFAULT_CATEGORY_COLOR = '#8B8F97';
const PRIORITY_LABEL = { high: '高', medium: '中', low: '低' };
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const URGENCY_LABEL = { overdue: '已逾期', soon: '即將到期', warn: '接近死線', normal: '', done: '已完成' };
const VIEW_TITLES = { todo: '代辦事項', cards: '專案卡片', calendar: '行事曆', gantt: '時程總覽', report: '今日日報', ailog: 'AI 日誌' };
const DAY_WIDTH = 26;
const ROW_HEIGHT = 32;

let settings = null;           // {owner, repo, branch, path, token, anthropicKey}
let store = { categories: {}, tasks: [] };
let fileSha = null;
let currentView = 'todo';
let calendarCursor = new Date();
let todoFilters = { project: 'all', when: 'all', search: '' };

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
      document.getElementById('view-title').textContent = VIEW_TITLES[currentView];
      document.getElementById('btn-add-task').style.display = (currentView==='report'||currentView==='ailog') ? 'none' : '';
      if(currentView==='report') renderReportView();
      if(currentView==='ailog') renderAiLogView();
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
        <p class="modal-hint">這些資訊只存在這台裝置的瀏覽器裡,不會上傳到任何地方(除了你自己的 GitHub / Anthropic 帳號)。</p>
        <label>GitHub 帳號 (owner)<input id="set-owner" value="${escapeHtml(s.owner||'')}" placeholder="例如 yourname"></label>
        <label>私密資料 repo 名稱<input id="set-repo" value="${escapeHtml(s.repo||'')}" placeholder="例如 yt-ops-data"></label>
        <label>分支 (branch)<input id="set-branch" value="${escapeHtml(s.branch||'main')}"></label>
        <label>資料檔案路徑<input id="set-path" value="${escapeHtml(s.path||'schedule.json')}"></label>
        <label>GitHub Personal Access Token<input id="set-token" type="password" value="${escapeHtml(s.token||'')}" placeholder="github_pat_..."></label>
        <label>Anthropic API Key(選填,用於「AI 日誌」功能)<input id="set-anthropic" type="password" value="${escapeHtml(s.anthropicKey||'')}" placeholder="sk-ant-..."></label>
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
      token: val('set-token'),
      anthropicKey: val('set-anthropic')
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
  renderCardsView();
  renderCalendarView();
  renderGanttView();
  renderReportView();
  renderTodayWidget();
  // AI 日誌畫面有自己的輸入狀態,只在切換到該分頁時才重繪,避免蓋掉使用者正在打的字
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
function currentWeekRange(){
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = (day===0 ? -6 : 1-day);
  const monday = addDays(now, diffToMonday);
  const sunday = addDays(monday, 6);
  return { start: dateToStr(monday), end: dateToStr(sunday) };
}
function urgencyOf(task, today){
  today = today || todayStr();
  if(task.status === '已完成') return 'done';
  if(task.endDate < today) return 'overdue';
  const daysLeft = daysBetween(parseDate(today), parseDate(task.endDate));
  if(daysLeft <= 2) return 'soon';
  if(daysLeft <= 6) return 'warn';
  return 'normal';
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

/* ---------------- Todo view (with filters) ---------------- */

function renderTodoView(){
  const el = document.getElementById('view-todo');
  const allTasks = store.tasks || [];
  const projects = [...new Set(allTasks.map(t=>t.project))].sort();
  const today = todayStr();
  const weekRange = currentWeekRange();

  let tasks = allTasks.filter(t=>{
    if(todoFilters.project!=='all' && t.project !== todoFilters.project) return false;
    if(todoFilters.when==='today' && !(t.startDate<=today && today<=t.endDate)) return false;
    if(todoFilters.when==='week' && !(t.startDate<=weekRange.end && t.endDate>=weekRange.start)) return false;
    if(todoFilters.when==='overdue' && !(t.endDate<today && t.status!=='已完成')) return false;
    if(todoFilters.when==='open' && t.status==='已完成') return false;
    if(todoFilters.search){
      const hay = (t.project+' '+t.task+' '+(t.note||'')).toLowerCase();
      if(!hay.includes(todoFilters.search.toLowerCase())) return false;
    }
    return true;
  });
  tasks = [...tasks].sort((a,b)=> (PRIORITY_ORDER[a.priority]-PRIORITY_ORDER[b.priority]) || a.startDate.localeCompare(b.startDate));

  const whenOptions = [['all','全部'],['today','今天'],['week','本週'],['overdue','已逾期'],['open','未完成']];
  const filterBarHtml = `
    <div class="filter-bar">
      <select id="filter-project" class="filter-select">
        <option value="all">全部專案</option>
        ${projects.map(p=>`<option value="${escapeHtml(p)}" ${todoFilters.project===p?'selected':''}>${escapeHtml(p)}</option>`).join('')}
      </select>
      <div class="filter-btns">
        ${whenOptions.map(([key,label])=>`<button class="filter-btn ${todoFilters.when===key?'active':''}" data-when="${key}">${label}</button>`).join('')}
      </div>
      <input type="text" id="filter-search" class="filter-search" placeholder="搜尋任務、專案、備註…" value="${escapeHtml(todoFilters.search)}">
    </div>`;

  const byCategory = {};
  tasks.forEach(t => (byCategory[t.category] = byCategory[t.category]||[]).push(t));

  const groupsHtml = Object.entries(byCategory).map(([cat, items])=>{
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

  el.innerHTML = filterBarHtml + (groupsHtml || `<div class="empty-state">沒有符合條件的任務。</div>`);

  document.getElementById('filter-project').addEventListener('change', e=>{ todoFilters.project = e.target.value; renderTodoView(); });
  const searchInput = document.getElementById('filter-search');
  searchInput.addEventListener('input', e=>{
    todoFilters.search = e.target.value;
    const cursor = e.target.selectionStart;
    renderTodoView();
    const fresh = document.getElementById('filter-search');
    fresh.focus();
    fresh.setSelectionRange(cursor, cursor);
  });
  el.querySelectorAll('.filter-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{ todoFilters.when = btn.dataset.when; renderTodoView(); });
  });
  el.querySelectorAll('.task-edit').forEach(btn=>{
    btn.addEventListener('click', ()=> openTaskModal(store.tasks.find(x=>x.id===btn.dataset.id)));
  });
}

/* ---------------- Project cards view ---------------- */

function renderCardsView(){
  const el = document.getElementById('view-cards');
  const tasks = store.tasks || [];
  if(!tasks.length){
    el.innerHTML = `<div class="empty-state">還沒有任務，先新增幾筆吧。</div>`;
    return;
  }
  const today = todayStr();
  const byProject = {};
  tasks.forEach(t=>{
    (byProject[t.project] = byProject[t.project] || {category:t.category, items:[]}).items.push(t);
  });
  const rank = {overdue:0, soon:1, warn:2, normal:3, done:4};

  const cardsHtml = Object.entries(byProject).map(([project, group])=>{
    const color = store.categories[group.category] || DEFAULT_CATEGORY_COLOR;
    const items = [...group.items].sort((a,b)=>a.endDate.localeCompare(b.endDate));
    const doneCount = items.filter(t=>t.status==='已完成').length;
    const total = items.length;
    let cardUrgency = 'done';
    items.forEach(t=>{
      const u = urgencyOf(t, today);
      if(rank[u] < rank[cardUrgency]) cardUrgency = u;
    });
    const flag = (cardUrgency==='overdue'||cardUrgency==='soon'||cardUrgency==='warn')
      ? `<span class="card-urgency-flag urgency-badge-${cardUrgency}">${URGENCY_LABEL[cardUrgency]}</span>` : '';

    const itemsHtml = items.map(t=>{
      const u = urgencyOf(t, today);
      const done = t.status==='已完成';
      const badge = (u==='overdue'||u==='soon'||u==='warn') ? `<span class="urgency-badge urgency-badge-${u}">${URGENCY_LABEL[u]}</span>` : '';
      return `
      <div class="card-task-item urgency-${u}">
        <input type="checkbox" class="card-task-checkbox" data-id="${t.id}" ${done?'checked':''}>
        <span class="card-task-label ${done?'is-done':''}" data-id="${t.id}">${escapeHtml(t.task)}</span>
        <span class="card-task-dates">${fmtRange(t.startDate,t.endDate)}</span>
        ${badge}
      </div>`;
    }).join('');

    return `
    <div class="project-card" style="border-top-color:${color}">
      <div class="project-card-header">
        <div>
          <div class="project-card-cat" style="color:${color}">${escapeHtml(group.category)}</div>
          <h3 class="project-card-title">${escapeHtml(project)}${flag}</h3>
        </div>
        <div class="project-progress-wrap">
          <div class="project-progress-bar"><div class="project-progress-fill" style="width:${total? (doneCount/total*100):0}%; background:${color}"></div></div>
          <span class="project-progress-text">${doneCount}/${total}</span>
        </div>
      </div>
      <div class="project-card-body">${itemsHtml}</div>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="cards-grid">${cardsHtml}</div>`;

  el.querySelectorAll('.card-task-checkbox').forEach(cb=>{
    cb.addEventListener('change', async (e)=>{
      const t = store.tasks.find(x=>x.id===e.target.dataset.id);
      t.status = e.target.checked ? '已完成' : '待處理';
      await persist(`${e.target.checked?'完成':'重啟'}任務: ${t.task}`);
    });
  });
  el.querySelectorAll('.card-task-label').forEach(lbl=>{
    lbl.addEventListener('click', ()=> openTaskModal(store.tasks.find(x=>x.id===lbl.dataset.id)));
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

/* ---------------- Daily report view ---------------- */

function renderReportView(){
  const el = document.getElementById('view-report');
  const today = todayStr();
  const tasks = store.tasks || [];
  const activeToday = tasks.filter(t=> t.startDate<=today && today<=t.endDate);
  const overdue = tasks.filter(t=> t.endDate<today && t.status!=='已完成');
  const upcoming = tasks.filter(t=>{
    const days = daysBetween(parseDate(today), parseDate(t.startDate));
    return days>0 && days<=3;
  });
  const weekdayNames = ['日','一','二','三','四','五','六'];
  const dateLabel = `${today.replace(/-/g,'/')}（週${weekdayNames[new Date().getDay()]}）`;

  function block(title, icon, items, emptyText, dateField){
    const rows = items.length ? items.map(t=>`
      <div class="report-line">
        <span class="report-tag" style="background:${store.categories[t.category]||DEFAULT_CATEGORY_COLOR}">${escapeHtml(t.category)}</span>
        <span class="report-text"><b>${escapeHtml(t.project)}</b> — ${escapeHtml(t.task)}</span>
        <span class="report-date">${t[dateField]}</span>
      </div>`).join('') : `<div class="report-empty">${emptyText}</div>`;
    return `<section class="report-section"><h4>${icon} ${title}（${items.length}）</h4>${rows}</section>`;
  }

  el.innerHTML = `
    <div class="report-box">
      <div class="report-date-line">${dateLabel} · YT 頻道營運日報</div>
      ${block('今日任務','🔥', activeToday, '今天沒有排定任務。', 'endDate')}
      ${block('已逾期','⚠️', overdue, '沒有逾期任務，很好。', 'endDate')}
      ${block('未來 3 天','⏰', upcoming, '暫無。', 'startDate')}
    </div>
    <button id="btn-copy-report" class="btn-ghost" style="margin-top:14px;">複製成文字</button>
    <p class="report-hint">想要每天早上自動收到這份日報寄到信箱？在私密 repo 裡加上 .github/workflows/daily_report.yml，細節看 README。</p>
  `;

  document.getElementById('btn-copy-report').addEventListener('click', ()=>{
    const text = reportAsPlainText(dateLabel, activeToday, overdue, upcoming);
    navigator.clipboard.writeText(text).then(()=> showToast('已複製到剪貼簿','ok')).catch(()=> showToast('複製失敗，請手動選取','error'));
  });
}

function reportAsPlainText(dateLabel, activeToday, overdue, upcoming){
  const lines = [`📅 ${dateLabel} YT 頻道營運日報`, ''];
  const section = (title, items, dateField) => {
    lines.push(`${title}（${items.length}）`);
    if(items.length){
      items.forEach(t=> lines.push(`・[${t.category}] ${t.project} — ${t.task}（${t[dateField]}）`));
    }else{
      lines.push('　無');
    }
    lines.push('');
  };
  section('🔥 今日任務', activeToday, 'endDate');
  section('⚠️ 已逾期', overdue, 'endDate');
  section('⏰ 未來 3 天', upcoming, 'startDate');
  return lines.join('\n');
}

/* ---------------- AI 日誌 view ---------------- */

function renderAiLogView(){
  const el = document.getElementById('view-ailog');
  const hasKey = !!(settings && settings.anthropicKey);
  el.innerHTML = `
    <div class="ailog-wrap">
      <p class="ailog-hint">
        把今天完成了什麼、進度到哪、下一步要做什麼直接打字丟給它，它會讀取你目前的任務清單，
        整理出「要更新哪些任務、要新增哪些任務」，給你確認過一遍之後，才會真的存回 GitHub。
      </p>
      ${hasKey ? '' : `<p class="ailog-warn">⚠️ 還沒設定 Anthropic API Key，去左下角「⚙ 連線設定」裡加一個（跟 GitHub Token 一樣，只存在你的瀏覽器，去 console.anthropic.com 建立）。</p>`}
      <textarea id="ailog-input" class="ailog-textarea" placeholder="例如：今天樂金文化那邊回信說願意掛名了，稀土書摘的內容也生出來了；線上課程課綱會議延到明天，拍攝週應該不受影響。"></textarea>
      <div class="ailog-actions">
        <button id="btn-ailog-submit" class="btn-primary" ${hasKey?'':'disabled'}>分析並產生建議</button>
      </div>
      <div id="ailog-result"></div>
    </div>`;

  const btn = document.getElementById('btn-ailog-submit');
  if(btn) btn.addEventListener('click', submitAiLog);
}

async function submitAiLog(){
  const input = document.getElementById('ailog-input').value.trim();
  if(!input){ showToast('先打幾句今天做了什麼吧','error'); return; }
  const resultBox = document.getElementById('ailog-result');
  resultBox.innerHTML = `<p class="ailog-loading">分析中…</p>`;

  const todayTasks = (store.tasks||[]).map(t=>({
    id:t.id, category:t.category, project:t.project, task:t.task,
    status:t.status, startDate:t.startDate, endDate:t.endDate, priority:t.priority
  }));
  const categories = Object.keys(store.categories);

  const systemPrompt = `你是一個 YouTube 頻道營運助理。使用者會用自然語言描述今天完成的事、進度、下一步。
你的工作是比對「目前任務清單」，判斷：
1. 哪些現有任務應該更新（例如標記已完成、調整日期、更新備註）— 用任務的 id 對應
2. 有沒有使用者提到、但清單裡完全沒有的新任務，需要新增

現有分類：${JSON.stringify(categories)}
目前任務清單：${JSON.stringify(todayTasks)}

只能輸出一個 JSON 物件，格式如下，不要有任何其他文字、不要用 markdown code fence：
{
  "updates": [ { "id": "任務id", "status": "已完成", "note": "選填" } ],
  "newTasks": [ { "category": "分類", "project": "專案名稱", "task": "任務內容", "owner": "我", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "priority": "medium", "status": "待處理" } ]
}
如果沒有需要更新或新增的，對應陣列給空陣列即可。日期請用今天(${todayStr()})推算。`;

  try{
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role:'user', content: input }]
      })
    });
    if(!res.ok){
      const errBody = await res.text().catch(()=> '');
      throw new Error(`API ${res.status} ${errBody.slice(0,200)}`);
    }
    const data = await res.json();
    const raw = (data.content||[]).map(b=>b.text||'').join('').trim();
    const cleaned = raw.replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
    const parsed = JSON.parse(cleaned);
    renderAiLogPreview(parsed);
  }catch(err){
    console.error(err);
    resultBox.innerHTML = `<p class="ailog-error">分析失敗：${escapeHtml(err.message)}</p>`;
  }
}

function renderAiLogPreview(parsed){
  const resultBox = document.getElementById('ailog-result');
  const updates = parsed.updates || [];
  const newTasks = parsed.newTasks || [];
  if(!updates.length && !newTasks.length){
    resultBox.innerHTML = `<p class="ailog-empty">沒有偵測到需要更新或新增的任務，你可以再描述具體一點。</p>`;
    return;
  }
  const updateRows = updates.map(u=>{
    const t = store.tasks.find(x=>x.id===u.id);
    if(!t) return '';
    const changesText = Object.entries(u).filter(([k])=>k!=='id').map(([k,v])=>`${k}: ${t[k]||'—'} → ${v}`).join('，');
    return `<div class="ailog-item"><b>${escapeHtml(t.project)} — ${escapeHtml(t.task)}</b><div class="ailog-item-detail">${escapeHtml(changesText)}</div></div>`;
  }).join('');
  const newRows = newTasks.map(t=>`
    <div class="ailog-item"><b>[新增] ${escapeHtml(t.project)} — ${escapeHtml(t.task)}</b>
    <div class="ailog-item-detail">${escapeHtml(t.category)} · ${t.startDate}~${t.endDate} · ${escapeHtml(t.status||'')}</div></div>`).join('');

  resultBox.innerHTML = `
    <div class="ailog-preview">
      <h4>建議更新</h4>
      ${updateRows || '<p class="ailog-empty">無</p>'}
      <h4>建議新增</h4>
      ${newRows || '<p class="ailog-empty">無</p>'}
      <div class="ailog-preview-actions">
        <button id="ailog-cancel" class="btn-ghost">取消</button>
        <button id="ailog-apply" class="btn-primary">套用並存回 GitHub</button>
      </div>
    </div>`;

  document.getElementById('ailog-cancel').addEventListener('click', ()=>{ resultBox.innerHTML=''; });
  document.getElementById('ailog-apply').addEventListener('click', async ()=>{
    updates.forEach(u=>{
      const t = store.tasks.find(x=>x.id===u.id);
      if(t) Object.assign(t, Object.fromEntries(Object.entries(u).filter(([k])=>k!=='id')));
    });
    newTasks.forEach(t=>{
      store.tasks.push({ ...t, id: 't'+Date.now()+Math.floor(Math.random()*1000) });
    });
    document.getElementById('ailog-input').value = '';
    resultBox.innerHTML = '';
    await persist('AI 日誌更新：' + new Date().toLocaleString('zh-TW'));
  });
}
