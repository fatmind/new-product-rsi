// report_client.js —— 报告前端渲染（被 report.js 内联进 report.html）
// 数据来自 window.__DATA__ = { rounds, evolution }；节点明细按轮组织，切轮时整体刷新。
/* global window, document */

const D = window.__DATA__;
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/* ===== 04 逐轮：轮 tab + 节点按钮 + 明细 panel（数据按轮） ===== */

function panelHTML(node) {
  const rows = node.table.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  const head = node.table.head.map((h) => `<th>${esc(h)}</th>`).join('');
  const rules = node.rules.length
    ? node.rules.map(([s, t]) =>
      `<li><span class="chip ${s === 'ok' ? 'chip-ok' : 'chip-warn'}">${s === 'ok' ? '通过' : '未通过'}</span><span>${esc(t)}</span></li>`).join('')
    : '<li><span class="chip">—</span><span>本节点无强规则项</span></li>';
  // a3 纯代码传导无 LLM 分析；其余节点按固定角度逐条展示：每条一行「小标题：分析」，自然换行
  const llmItems = Array.isArray(node.llm) ? node.llm : [];
  const llmCard = llmItems.length
    ? `<div class="check-card">
          <h4>校验方法 2 · LLM 分析<span>这个环节模拟得像不像真实</span></h4>
          ${llmItems.map((x) => `<p style="font-size:var(--fs-micro);color:var(--fg-2);margin:calc(var(--u)*0.9) 0;line-height:1.7"><b style="color:var(--fg)">${esc(x.title ?? '')}：</b>${esc(x.text ?? (typeof x === 'string' ? x : ''))}</p>`).join('')}
        </div>`
    : `<div class="check-card">
          <h4>校验方法 2 · LLM 分析<span>不适用</span></h4>
          <p>本节点是纯代码打包传导，没有判断成分，左侧强规则校验即可保障正确性。</p>
        </div>`;
  return `
    <div class="panel" role="tabpanel" aria-label="${esc(node.name)} 明细">
      <p class="panel-lead">${esc(node.lead)}</p>
      <div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      <div class="check-grid">
        <div class="check-card">
          <h4>校验方法 1 · 强规则<span>代码判定，结果确定</span></h4>
          <ul>${rules}</ul>
        </div>
        ${llmCard}
      </div>
      <details class="raw">
        <summary>本节点原始输出</summary>
        <pre><code>${esc(node.raw)}</code></pre>
      </details>
    </div>`;
}

function outcomesTable(outcomes) {
  const rows = outcomes.map((o) => `<tr>
      <td>${esc(o.cluster)}</td>
      <td>${esc(o.selection)}</td>
      <td>${esc(o.incentive)}</td>
      <td>${esc(o.merchant)}</td>
      <td>${o.broke === '—' ? '—' : `<span class="chip ${o.brokeOk ? 'chip-ok' : 'chip-warn'}">${esc(o.broke)}</span>`}</td>
    </tr>`).join('');
  return `<div class="table-scroll"><table>
    <thead><tr><th>配件簇</th><th>选品结果</th><th>激励结果</th><th>商家决策结果</th><th>破零结果</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function render() {
  const mount = document.getElementById('roundMount');
  mount.innerHTML = `
    <div class="tabs" role="tablist" aria-label="轮次">
      ${D.rounds.map((r, i) => `<button class="tab" type="button" role="tab" data-round="${i}" aria-selected="${i === 0}">${r.id}</button>`).join('')}
    </div>
    <div class="card pad">
      <p class="label">本轮提醒 <span>模拟过程中不像真实的地方</span><span class="hint" data-pack></span></p>
      <ul class="alerts" data-alerts style="margin-top:calc(var(--u)*1.2)"></ul>
      <p class="label" style="margin-top:calc(var(--u)*2.4)">全链路结局 <span>一行一簇：选品 → 激励 → 商家 → 破零（选品对错以真值评，只进报告）</span></p>
      <div data-outcomes style="margin-top:calc(var(--u)*1.2)"></div>
      <div class="rail-nodes" role="tablist" aria-label="链路节点" data-nodebar></div>
      <div data-panel></div>
    </div>`;

  const tabs = Array.from(mount.querySelectorAll('.tab'));
  const alertBox = mount.querySelector('[data-alerts]');
  const packBox = mount.querySelector('[data-pack]');
  const outcomesBox = mount.querySelector('[data-outcomes]');
  const nodeBar = mount.querySelector('[data-nodebar]');
  const panelBox = mount.querySelector('[data-panel]');
  let curRound = 0;

  const showNode = (ni) => {
    Array.from(nodeBar.querySelectorAll('.nbtn')).forEach((b, bi) => b.setAttribute('aria-selected', String(bi === ni)));
    panelBox.innerHTML = panelHTML(D.rounds[curRound].nodes[ni]);
  };

  const showRound = (i) => {
    curRound = i;
    tabs.forEach((t, ti) => t.setAttribute('aria-selected', String(ti === i)));
    const r = D.rounds[i];
    alertBox.innerHTML = r.alerts.map((a) => `<li>${esc(a)}</li>`).join('') || '<li>本轮模拟过程没有发现明显失真</li>';
    packBox.textContent = `· ${r.id} 使用 ${r.pack}${r.candidates?.length ? ` · 本期从 ${r.poolSize} 簇池圈选 ${r.candidates.length} 个候选` : ''}`;
    outcomesBox.innerHTML = outcomesTable(r.outcomes);
    nodeBar.innerHTML = r.nodes.map((n, ni) =>
      `<button class="nbtn" type="button" role="tab" data-node="${ni}" aria-selected="${ni === 0}"><span class="bn">${esc(n.name)}</span><span class="bk">${esc(n.kind)}</span></button>`).join('');
    Array.from(nodeBar.querySelectorAll('.nbtn')).forEach((b, ni) => b.addEventListener('click', () => showNode(ni)));
    showNode(0);
  };

  tabs.forEach((b, i) => {
    b.addEventListener('click', () => showRound(i));
    b.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      ev.preventDefault();
      const next = (i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      tabs[next].focus();
      showRound(next);
    });
  });
  showRound(0);
}

/* ===== 03 自迭代：时间线 + 完整条目原文抽屉 ===== */

const MD_DOCS = D.evolution.docs;
const verLabel = (v) => (v === 'init' ? '原始 (init)' : v.toUpperCase());
const DOC_LABEL = { judgment: '选品研判 · 研判经验', incentive: '价格激励 · 口径' };

function mdToHtml(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  let html = '', i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^\s*$/.test(ln)) { i++; continue; }
    const h = ln.match(/^(#{1,3})\s+(.*)$/);
    if (h) { html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }
    if (/^\s*>\s?/.test(ln)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(inline(lines[i].replace(/^\s*>\s?/, ''))); i++; }
      html += `<blockquote>${buf.join('<br>')}</blockquote>`; continue;
    }
    if (/^\s*\|/.test(ln) && i + 1 < lines.length && /-/.test(lines[i + 1]) && /^\s*\|?[\s:|-]+$/.test(lines[i + 1])) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(ln); i += 2; let body = '';
      while (i < lines.length && /^\s*\|/.test(lines[i])) { body += '<tr>' + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>'; i++; }
      html += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`; continue;
    }
    if (/^\s*[-*]\s+/.test(ln)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(inline(lines[i].replace(/^\s*[-*]\s+/, ''))); i++; }
      html += `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>`; continue;
    }
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^#{1,3}\s/.test(lines[i]) && !/^\s*>/.test(lines[i]) && !/^\s*\|/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) { buf.push(inline(lines[i])); i++; }
    html += `<p>${buf.join('<br>')}</p>`;
  }
  return html;
}

const mdMask = document.getElementById('mdMask');
const mdTabsEl = document.getElementById('mdTabs');
const mdBodyEl = document.getElementById('mdBody');
const mdTitleEl = document.getElementById('mdTitle');
const mdSubEl = document.getElementById('mdSub');
let curDoc = { ver: 'init', doc: 'judgment' };

function paintDrawer() {
  mdTitleEl.textContent = `${verLabel(curDoc.ver)} · 完整条目`;
  mdSubEl.textContent = `${DOC_LABEL[curDoc.doc]}（Markdown 原文渲染）`;
  mdTabsEl.innerHTML = ['judgment', 'incentive'].map((d) =>
    `<button class="tab" type="button" data-doc="${d}" aria-selected="${d === curDoc.doc}">${d === 'judgment' ? '选品研判' : '价格激励'}</button>`).join('');
  const doc = MD_DOCS[curDoc.ver];
  mdBodyEl.innerHTML = doc ? mdToHtml(doc[curDoc.doc]) : '<p>该版本原文缺失</p>';
  mdTabsEl.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { curDoc.doc = b.dataset.doc; paintDrawer(); }));
  mdBodyEl.parentElement.scrollTop = 0;
}
function openDrawer(ver, doc) {
  curDoc = { ver, doc: doc || 'judgment' };
  paintDrawer();
  mdMask.hidden = false;
  requestAnimationFrame(() => mdMask.classList.add('open'));
  document.getElementById('mdClose').focus();
}
function closeDrawer() { mdMask.classList.remove('open'); setTimeout(() => { mdMask.hidden = true; }, 200); }
document.getElementById('mdClose').addEventListener('click', closeDrawer);
mdMask.addEventListener('click', (e) => { if (e.target === mdMask) closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mdMask.hidden) closeDrawer(); });

function renderEvo() {
  const tabsEl = document.getElementById('evoTabs');
  const mount = document.getElementById('evoMount');
  const points = {
    judgment: { label: '选品研判', hops: D.evolution.selection },
    incentive: { label: '价格激励', hops: D.evolution.incentive },
  };
  const keys = Object.keys(points);
  tabsEl.innerHTML = keys.map((k, i) =>
    `<button class="tab" type="button" role="tab" data-point="${k}" aria-selected="${i === 0}">${points[k].label}</button>`).join('');

  const paint = (key) => {
    const hops = points[key].hops;
    // 起点 + 每跳（跳的版本 = to；to 无原文时链到该版本存在的最近一版）
    const items = [
      `<div class="tl-item"><span class="tl-dot"></span><div class="tl-head"><span class="tl-jump">起点 · init</span><span class="hint">初始参数包（人工写的第一版）</span></div>` +
      `<div class="docs-bar"><button class="docs-link" type="button" data-ver="init" data-doc="${key}">查看 原始 (init) 这一版完整原文 →</button></div></div>`,
      ...hops.map((h, i) => {
        const ver = MD_DOCS[h.to] ? h.to : h.from;
        const changes = Array.isArray(h.changes) ? h.changes : (h.why ? [h.why] : []);
        const changesHtml = changes.length > 1
          ? `<p style="font-size:var(--fs-small);color:var(--fg-2);margin-top:calc(var(--u)*1)">改了 ${changes.length} 条：</p>` +
            changes.map((c, ci) => `<p style="font-size:var(--fs-small);color:var(--fg-2);margin-top:calc(var(--u)*0.5);padding-left:calc(var(--u)*1.5)">${ci + 1}、${esc(c)}</p>`).join('')
          : `<p style="font-size:var(--fs-small);color:var(--fg-2);margin-top:calc(var(--u)*1)">${esc(changes[0] ?? '')}</p>`;
        return `<div class="tl-item"><span class="tl-dot"></span>` +
          `<div class="tl-head"><span class="tl-jump">第 ${i + 1} 次改（${esc(h.from)} → ${esc(h.to)}）</span></div>` +
          changesHtml +
          `<p style="font-size:var(--fs-micro);color:var(--fg-3);margin-top:calc(var(--u)*0.8)">典型触发情况：${esc(h.case)}</p>` +
          `<div class="docs-bar"><button class="docs-link" type="button" data-ver="${esc(ver)}" data-doc="${key}">查看 ${verLabel(ver)} 这一版完整原文 →</button></div></div>`;
      }),
    ];
    mount.innerHTML = items.join('');
    mount.querySelectorAll('.docs-link').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.ver, b.dataset.doc)));
  };

  const tabs = Array.from(tabsEl.querySelectorAll('.tab'));
  const show = (i) => { tabs.forEach((t, ti) => t.setAttribute('aria-selected', String(ti === i))); paint(keys[i]); };
  tabs.forEach((b, i) => {
    b.addEventListener('click', () => show(i));
    b.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      ev.preventDefault();
      const next = (i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      tabs[next].focus(); show(next);
    });
  });
  show(0);
}

render();
renderEvo();
