const STATUS_LABELS = {
  READY: 'Ready',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  REVIEW: 'Review',
  DONE: 'Done',
};

export function renderStandaloneWorkboard(snapshot) {
  const data = JSON.stringify(snapshot).replaceAll('<', '\\u003c');
  const title = escapeHtml(snapshot.title || 'Team Loop Workboard');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${title}</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#eef2ff;background:#090b11}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 12% 0,#1c2842 0,transparent 34rem),#090b11}
    main{max-width:1480px;margin:auto;padding:40px 24px 64px}header{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:28px}
    h1{margin:0;font-size:clamp(28px,4vw,52px);letter-spacing:-.045em}p{color:#929db3;margin:8px 0 0}.stamp{text-align:right;font-size:12px;color:#748098}
    .summary{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 22px}.summary span{padding:8px 12px;border:1px solid #293249;border-radius:999px;background:#111622;color:#b9c3d8;font-size:13px}
    .board{display:grid;grid-template-columns:repeat(5,minmax(220px,1fr));gap:14px;overflow-x:auto;padding-bottom:12px}.column{min-height:420px;background:#0e121b;border:1px solid #20283a;border-radius:16px;padding:14px}
    .column h2{display:flex;justify-content:space-between;margin:2px 2px 14px;font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:#96a1b7}.count{color:#65728b}
    .card{background:#151b28;border:1px solid #293249;border-radius:12px;padding:14px;margin-bottom:10px;box-shadow:0 10px 28px #0003}.card.blocked{border-color:#713c46}.card.done{opacity:.72}
    .priority{font-size:11px;color:#758198}.card h3{font-size:15px;line-height:1.35;margin:7px 0 14px}.meta{display:flex;justify-content:space-between;gap:8px;color:#8995ab;font-size:12px}.artifact{margin-top:9px;font-size:11px;color:#7dd3b0}
    .empty{padding:24px 8px;color:#566177;text-align:center;font-size:13px}@media(max-width:760px){main{padding:24px 16px}header{display:block}.stamp{text-align:left;margin-top:12px}.board{grid-template-columns:repeat(5,260px)}}
  </style>
</head>
<body>
<main>
  <header><div><h1>${title}</h1><p>Portable workboard snapshot</p></div><div class="stamp" id="stamp"></div></header>
  <div class="summary" id="summary"></div>
  <section class="board" id="board" aria-label="Workboard"></section>
</main>
<script type="application/json" id="workboard-data">${data}</script>
<script>
  const snapshot=JSON.parse(document.getElementById('workboard-data').textContent);
  const statuses=${JSON.stringify(STATUS_LABELS)};
  const esc=(value)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  document.getElementById('stamp').textContent='Generated '+new Date(snapshot.generatedAt).toLocaleString();
  document.getElementById('summary').innerHTML=Object.entries(statuses).map(([key,label])=>'<span>'+esc(label)+' · '+(snapshot.summary[key]||0)+'</span>').join('');
  document.getElementById('board').innerHTML=Object.entries(statuses).map(([status,label])=>{
    const tasks=snapshot.tasks.filter(task=>task.status===status);
    const cards=tasks.map(task=>'<article class="card '+status.toLowerCase()+'"><div class="priority">P'+esc(task.priority)+'</div><h3>'+esc(task.title)+'</h3><div class="meta"><span>'+esc(task.assignee||'Unassigned')+'</span><span>'+esc(task.schedule.plannedEnd||'')+'</span></div>'+(task.artifacts.length?'<div class="artifact">'+task.artifacts.length+' artifact'+(task.artifacts.length===1?'':'s')+'</div>':'')+'</article>').join('');
    return '<div class="column"><h2><span>'+esc(label)+'</span><span class="count">'+tasks.length+'</span></h2>'+(cards||'<div class="empty">No tasks</div>')+'</div>';
  }).join('');
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
