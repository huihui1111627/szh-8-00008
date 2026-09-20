/* 联排控制台 UI：时间轴编辑 / 实时重排 / 冲突定位 / 预演 / 场记点 / 版本对比 */
(function () {
  'use strict';
  const C = window.StageCore;
  const $ = id => document.getElementById(id);

  const LS_KEY = 'stage-rehearsal-v1';
  const PX_PER_SEC = 26;
  const KIND_COLOR = { lift: 'lift', turntable: 'turntable', bar: 'bar', actor: 'actor' };

  let store = loadStore();
  let versions = store.versions;          // [{name, state, savedAt}]
  let activeIdx = store.activeIdx || 0;
  if (!versions.length) { versions.push({ name: 'v1 · 导演初排', state: C.createState(), savedAt: Date.now() }); activeIdx = 0; }
  let state = versions[activeIdx].state;

  let playT = 0, playing = false, raf = null, lastTs = null;
  let cmpState = null; // {aIdx, bIdx, t, raf, playing}

  // ---------------- 持久化 ----------------
  function loadStore() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return { versions: [], activeIdx: 0 };
  }
  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ versions, activeIdx }));
    } catch (e) { /* ignore */ }
  }

  const evaluation = () => C.evaluate(state);
  const duration = () => Math.max(20, Math.ceil(C.stateEnd(state) + 2));

  // ---------------- 时间轴渲染 ----------------
  function tToX(t) { return t * PX_PER_SEC; }
  function xToT(x) { return C.round(x / PX_PER_SEC); }

  function renderTimeline() {
    const tl = $('timeline');
    tl.innerHTML = '';
    tl.style.width = tToX(duration()) + 'px';
    const res = evaluation();

    // 标尺
    const ruler = el('div', 'ruler');
    for (let s = 0; s <= duration(); s += 2) {
      const tk = el('div', 'tick' + (s % 10 === 0 ? ' major' : ''));
      tk.style.left = tToX(s) + 'px';
      tk.textContent = s % 10 === 0 ? s + 's' : '';
      ruler.appendChild(tk);
    }
    tl.appendChild(ruler);

    const overlay = el('div', 'timeline-overlay');
    tl.appendChild(overlay);

    state.lanes.forEach(def => {
      const track = el('div', 'track');
      const lab = el('div', 'track-label');
      lab.innerHTML = '<span class="k" style="background:var(--' +
        (def.kind === 'turntable' ? 'turn' : def.kind) + ')"></span>' + def.name;
      track.appendChild(lab);

      // 冲突带
      res.conflicts.forEach(cf => {
        if (!cf.lanes.includes(def.id)) return;
        const band = el('div', 'conflict-band' + (cf.severity === 'warn' ? ' warn' : ''));
        band.style.left = tToX(cf.start) + 'px';
        band.style.width = Math.max(4, tToX(cf.end - cf.start)) + 'px';
        band.title = cf.reason;
        band.onclick = (e) => { e.stopPropagation(); focusConflict(cf); };
        track.appendChild(band);
      });

      C.sortedLaneClips(state.clips, def.id).forEach(clip => {
        const d = el('div', 'clip ' + KIND_COLOR[def.kind] +
          (clip.pause ? ' pause-clip' : '') +
          (state.selected === clip.id ? ' selected' : '') +
          (res.conflicts.some(cf => cf.clips.includes(clip.id)) ? ' in-conflict' : ''));
        d.style.left = tToX(clip.start) + 'px';
        d.style.width = Math.max(10, tToX(clip.end - clip.start)) + 'px';
        d.dataset.id = clip.id;
        d.textContent = clipLabel(def, clip);
        if (!clip.pause) {
          const handle = el('div', 'resize-handle');
          d.appendChild(handle);
          attachDrag(d, clip, handle);
        } else {
          attachDrag(d, clip, el('div'));
        }
        d.onclick = (e) => { e.stopPropagation(); selectClip(clip.id); };
        track.appendChild(d);
      });

      // 场记点旗标（只在第一行画，避免重复）—— 统一画在各轨道也可，这里画在每个轨道顶端太乱，集中画在标尺下方浮层
      tl.appendChild(track);
    });

    // 场记点（覆盖层，对齐到轨道区）
    state.cues.forEach(q => {
      const flag = el('div', 'cue-flag');
      flag.textContent = '🚩';
      flag.style.left = tToX(q.t) + 'px';
      flag.style.top = '0';
      flag.title = q.label + ' @' + q.t + 's（点击定位）';
      flag.onclick = () => seek(q.t);
      overlay.appendChild(flag);
    });

    // 播放头
    const ph = el('div', 'playhead');
    ph.id = 'playhead';
    ph.style.left = tToX(playT) + 'px';
    tl.appendChild(ph);

    renderConflicts(res);
    renderSafety(res);
    renderInspector();
    renderCues();
    $('duration').textContent = duration().toFixed(0);
    $('clock').textContent = playT.toFixed(1);
  }

  function clipLabel(def, clip) {
    if (clip.pause) return '⏸ 停顿 ' + (clip.end - clip.start).toFixed(1) + 's';
    let val = '';
    if (def.kind === 'turntable') val = '→' + clip.level + '°';
    else if (def.kind === 'actor') val = '→' + (clip.level < 0 || clip.level > C.STAGE.W ? '离场' : clip.level + 'm');
    else val = '→' + clip.level + 'm';
    return (clip.end - clip.start).toFixed(1) + 's ' + val;
  }

  function el(tag, cls) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    return d;
  }

  // ---------------- 拖拽 ----------------
  function attachDrag(node, clip, handle) {
    let mode = null, startX = 0, origStart = 0, origEnd = 0;

    const down = (m, isResize) => {
      m.preventDefault();
      mode = isResize ? 'resize' : 'move';
      startX = m.clientX;
      origStart = clip.start; origEnd = clip.end;
      document.body.style.cursor = 'ew-resize';
      const mv = (ev) => {
        const dx = ev.clientX - startX;
        const dt = C.round(Math.round(dx / PX_PER_SEC * 10) / 10);
        if (mode === 'move') {
          C.moveClip(state, clip.id, Math.max(0, origStart + dt));
        } else {
          C.resizeEnd(state, clip.id, origEnd + dt);
        }
        playT = Math.min(playT, duration());
        renderTimeline();
        renderStage();
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        persist();
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    };
    node.addEventListener('mousedown', e => { if (e.target !== handle) down(e, false); });
    handle.addEventListener('mousedown', e => { e.stopPropagation(); down(e, true); });
  }

  function selectClip(id) {
    state.selected = id;
    renderTimeline();
  }

  // ---------------- 检视面板 ----------------
  function renderInspector() {
    const box = $('inspector');
    const clip = state.clips.find(c => c.id === state.selected);
    if (!clip) {
      box.className = 'inspector';
      box.textContent = '未选中动作。在时间轴上点击任意片段；拖动片段改起止，拖右缘改速度（时长）。';
      return;
    }
    const def = state.lanes.find(l => l.id === clip.laneId);
    const dur = clip.end - clip.start;
    const speed = def.kind === 'actor'
      ? Math.abs(clip.level - prevLevel(clip)) / dur
      : Math.abs(clip.level - prevLevel(clip)) / dur;
    const unit = def.kind === 'turntable' ? '°' : (def.kind === 'actor' ? 'm' : 'm');
    box.className = 'inspector';
    box.innerHTML = '';
    box.appendChild(fld('资源', text(def.name)));
    box.appendChild(fld('起点 s', numInput(clip.start, v => updateFields(clip, { start: v }))));
    box.appendChild(fld('终点 s', numInput(clip.end, v => updateFields(clip, { end: v }))));
    box.appendChild(fld('时长 s（改速度）', numInput(C.round(dur), v =>
      updateFields(clip, { end: C.round(clip.start + Math.max(C.MIN_DUR, v)) }))));
    box.appendChild(fld('目标' + unit, numInput(clip.level, v => updateFields(clip, { level: v }))));
    const wrap = document.createElement('div');
    wrap.className = 'btns';
    wrap.appendChild(btn('⏸ 在此动作中点插入 2s 停顿', () => {
      const mid = C.round((clip.start + clip.end) / 2);
      const hold = C.insertPause(state, clip.id, mid, C.PAUSE_DUR);
      if (hold) { state.selected = hold.id; }
      afterEdit();
    }));
    wrap.appendChild(btn('🗑 删除动作', () => {
      C.deleteClip(state, clip.id);
      state.selected = null;
      afterEdit();
    }));
    wrap.appendChild(span('速度 ' + speed.toFixed(2) + ' ' + unit + '/s'));
    box.appendChild(wrap);
  }

  function prevLevel(clip) {
    const cs = C.sortedLaneClips(state.clips, clip.laneId);
    const i = cs.indexOf(clip);
    if (i > 0) return cs[i - 1].level;
    const def = state.lanes.find(l => l.id === clip.laneId);
    return def.kind === 'actor' ? def.startX : def.home;
  }

  function updateFields(clip, fields) {
    C.setClipFields(state, clip.id, fields);
    afterEdit();
  }
  function afterEdit() { renderTimeline(); renderStage(); persist(); }

  function fld(label, input) {
    const f = document.createElement('div');
    f.className = 'fld';
    const l = document.createElement('label');
    l.textContent = label;
    f.appendChild(l); f.appendChild(input);
    return f;
  }
  function numInput(val, oninput) {
    const i = document.createElement('input');
    i.type = 'number'; i.step = '0.1'; i.value = val;
    i.oninput = () => oninput(parseFloat(i.value));
    return i;
  }
  function text(val) { const s = document.createElement('span'); s.textContent = val; return s; }
  function span(val) { const s = document.createElement('span'); s.style.color = 'var(--muted)'; s.textContent = val; return s; }
  function btn(label, onclick) {
    const b = document.createElement('button');
    b.textContent = label; b.onclick = onclick; return b;
  }

  // ---------------- 冲突清单 / 安全状态 ----------------
  function renderConflicts(res) {
    const ul = $('conflict-list');
    ul.innerHTML = '';
    if (!res.conflicts.length) {
      ul.innerHTML = '<li class="conflict-item" style="border-left-color:var(--ok)">✅ 无冲突，可以执行</li>';
    }
    res.conflicts.forEach(cf => {
      const li = document.createElement('li');
      li.className = 'conflict-item' + (cf.severity === 'warn' ? ' warn' : '');
      const names = cf.lanes.map(id => laneName(id)).join(' × ');
      li.innerHTML = '<div class="when">' + cf.start.toFixed(1) + '–' + cf.end.toFixed(1) +
        's · ' + (cf.severity === 'block' ? '⛔ 阻止' : '⚠ 警告') + '</div><div>' +
        esc(cf.reason) + '</div><div class="when">' + esc(names) + '</div>';
      li.onclick = () => focusConflict(cf);
      ul.appendChild(li);
    });

    const bar = $('conflict-bar');
    const m = C.riskMetrics(res.conflicts);
    bar.innerHTML = m.blocked
      ? '⛔ 存在 ' + m.blockCount + ' 处阻止级冲突（风险时长 ' + m.riskSeconds + 's），执行已锁定。点击红色片段定位。'
      : (m.warnCount ? '⚠ ' + m.warnCount + ' 处警告，可预演但需人工确认。' : '✅ 安全检查通过。');
    bar.style.color = m.blocked ? 'var(--block)' : (m.warnCount ? 'var(--warn)' : 'var(--ok)');
  }

  function renderSafety(res) {
    const box = $('safety-stat'), txt = $('safety-text');
    const m = C.riskMetrics(res.conflicts);
    box.classList.remove('ok', 'block', 'warn');
    if (m.blocked) { box.classList.add('block'); txt.textContent = '阻止执行 · ' + m.blockCount + ' 处冲突'; }
    else if (m.warnCount) { box.classList.add('warn'); txt.textContent = m.warnCount + ' 处警告'; }
    else { box.classList.add('ok'); txt.textContent = '安全 · 可以执行'; }
  }

  function laneName(id) {
    const l = state.lanes.find(x => x.id === id);
    return l ? l.name : id;
  }
  function esc(s) { return String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch])); }

  function focusConflict(cf) {
    seek(cf.start);
    const id = cf.clips[0];
    if (id) { state.selected = id; renderTimeline(); }
    const node = document.querySelector('[data-id="' + id + '"]');
    if (node) node.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }

  // ---------------- 舞台 ----------------
  function renderStage() {
    StageView.render($('stage-wrap'), C, state, playT, evaluation().conflicts);
  }
  function seek(t) {
    playT = Math.max(0, Math.min(t, duration()));
    renderStage();
    const ph = $('playhead');
    if (ph) ph.style.left = tToX(playT) + 'px';
    $('clock').textContent = playT.toFixed(1);
    renderCues();
  }

  // ---------------- 预演 ----------------
  function setPlaying(v) {
    playing = v;
    $('btn-play').textContent = playing ? '⏸ 暂停' : '▶ 预演';
    if (playing) {
      lastTs = null;
      raf = requestAnimationFrame(tick);
    } else if (raf) { cancelAnimationFrame(raf); raf = null; }
  }
  function tick(ts) {
    if (!playing) return;
    if (lastTs == null) lastTs = ts;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    const rate = parseFloat($('speed-select').value);
    playT = playT + dt * rate;
    if (playT >= duration()) { playT = duration(); setPlaying(false); }
    seek(playT);
    if (playing) raf = requestAnimationFrame(tick);
  }

  // 执行：有阻止级冲突则拒绝并定位到第一个冲突
  function execRun() {
    const res = evaluation();
    const m = C.riskMetrics(res.conflicts);
    if (m.blocked) {
      const first = res.conflicts.find(c => c.severity === 'block');
      focusConflict(first);
      flashSafety();
      return;
    }
    playT = 0;
    setPlaying(true);
  }
  function flashSafety() {
    const box = $('safety-stat');
    box.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }],
      { duration: 400, iterations: 3 }
    );
  }

  // ---------------- 场记点 ----------------
  function renderCues() {
    const ul = $('cue-list');
    ul.innerHTML = '';
    const last = C.lastCueAtOrBefore(state, playT);
    if (!state.cues.length) {
      ul.innerHTML = '<div class="hint">尚无场记点。预演到关键位置后点“标记场记点”，中断后可从最近确认点恢复。</div>';
      return;
    }
    state.cues.forEach(q => {
      const li = document.createElement('div');
      li.className = 'cue-item' + (last && last.id === q.id ? ' current' : '');
      li.innerHTML = '<span class="t">' + q.t.toFixed(1) + 's</span><span>' + esc(q.label) + '</span>';
      const go = document.createElement('button');
      go.textContent = '定位';
      go.onclick = () => seek(q.t);
      const del = document.createElement('button');
      del.textContent = '删除';
      del.onclick = () => { C.removeCue(state, q.id); persist(); renderTimeline(); };
      li.appendChild(go); li.appendChild(del);
      ul.appendChild(li);
    });
  }

  // ---------------- 版本 ----------------
  function renderVersions() {
    const ul = $('version-list');
    ul.innerHTML = '';
    versions.forEach((v, i) => {
      const res = C.evaluate(v.state);
      const m = C.riskMetrics(res.conflicts);
      const li = document.createElement('li');
      li.className = 'version-item' + (i === activeIdx ? ' active' : '');
      li.innerHTML = '<span class="name">' + esc(v.name) + '</span>' +
        '<span class="meta">' + C.stateEnd(v.state).toFixed(0) + 's · ' +
        (m.blocked ? '⛔' + m.blockCount : (m.warnCount ? '⚠' + m.warnCount : '✅')) + '</span>';
      li.onclick = () => {
        setPlaying(false);
        activeIdx = i; state = versions[i].state; playT = 0; persist();
        renderAll();
      };
      ul.appendChild(li);
    });
  }

  function saveVersion() {
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const copy = C.cloneState(state, state.name + ' 副本 ' + stamp);
    versions.push({ name: copy.name, state: copy, savedAt: Date.now() });
    activeIdx = versions.length - 1;
    state = versions[activeIdx].state;
    persist();
    renderAll();
  }

  function renderDiff(aState, bState, container) {
    const d = C.diffStates(aState, bState);
    if (!d.length) { container.innerHTML = '<div class="hint">两个版本编排一致。</div>'; return; }
    let html = '<table><tr><th>资源</th><th>A 结束</th><th>B 结束</th><th>差异</th></tr>';
    d.forEach(r => {
      html += '<tr><td>' + esc(r.name) + '</td><td>' + r.endA.toFixed(1) + 's</td><td>' +
        r.endB.toFixed(1) + 's</td><td style="color:' + (r.delta > 0 ? 'var(--block)' : 'var(--ok)') +
        '">' + (r.delta > 0 ? '+' : '') + r.delta.toFixed(1) + 's</td></tr>';
    });
    html += '</table>';
    container.innerHTML = html;
  }

  // ---------------- 并排对比 ----------------
  function openCompare() {
    if (versions.length < 2) {
      alert('至少需要两个版本。先点“存为新版本”，再调整节奏生成差异。');
      return;
    }
    const bIdx = activeIdx;
    const aIdx = versions.findIndex((_, i) => i !== bIdx);
    cmpState = { aIdx, bIdx, t: 0, playing: false };
    $('compare-overlay').classList.remove('hidden');
    $('cmp-name-a').textContent = versions[aIdx].name;
    $('cmp-name-b').textContent = versions[bIdx].name;
    renderCompare();
  }
  function renderCompare() {
    if (!cmpState) return;
    const a = versions[cmpState.aIdx].state, b = versions[cmpState.bIdx].state;
    StageView.render($('cmp-stage-a'), C, a, cmpState.t, C.evaluate(a).conflicts);
    StageView.render($('cmp-stage-b'), C, b, cmpState.t, C.evaluate(b).conflicts);
    const ma = C.riskMetrics(C.evaluate(a).conflicts);
    const mb = C.riskMetrics(C.evaluate(b).conflicts);
    $('cmp-meta-a').innerHTML = metaHtml(a, ma);
    $('cmp-meta-b').innerHTML = metaHtml(b, mb);
    $('cmp-clock').textContent = cmpState.t.toFixed(1);
    renderDiff(a, b, $('cmp-diff'));
  }
  function metaHtml(s, m) {
    return '时长 ' + C.stateEnd(s).toFixed(1) + 's · 场记点 ' + s.cues.length +
      ' · 风险 <b style="color:' + (m.blocked ? 'var(--block)' : m.warnCount ? 'var(--warn)' : 'var(--ok)') +
      '">' + (m.blocked ? m.blockCount + ' 冲突' : m.warnCount ? m.warnCount + ' 警告' : '无') +
      '</b>（' + m.riskSeconds + 's）';
  }
  function cmpTick(ts) {
    if (!cmpState || !cmpState.playing) return;
    if (cmpTick.last == null) cmpTick.last = ts;
    const dt = (ts - cmpTick.last) / 1000;
    cmpTick.last = ts;
    const a = versions[cmpState.aIdx].state, b = versions[cmpState.bIdx].state;
    const end = Math.max(C.stateEnd(a), C.stateEnd(b));
    cmpState.t = cmpState.t + dt;
    if (cmpState.t >= end) { cmpState.t = end; cmpState.playing = false; cmpTick.last = null; }
    renderCompare();
    if (cmpState.playing) requestAnimationFrame(cmpTick);
  }
  function closeCompare() {
    cmpState = null;
    $('compare-overlay').classList.add('hidden');
  }

  // ---------------- 总装 ----------------
  function renderAll() {
    renderTimeline();
    renderStage();
    renderVersions();
    renderDiff(versions[Math.max(0, activeIdx - 1)] ? versions[Math.max(0, activeIdx - 1)].state : state,
      state, $('diff-view'));
  }

  function bind() {
    $('btn-play').onclick = () => { if (playing) setPlaying(false); else { if (playT >= duration()) playT = 0; setPlaying(true); } };
    $('btn-stop').onclick = () => { setPlaying(false); playT = 0; seek(0); };
    $('btn-exec').onclick = execRun;
    $('btn-cue').onclick = () => {
      C.addCue(state, playT);
      persist(); renderTimeline();
    };
    $('btn-resume').onclick = () => {
      const q = C.lastCueAtOrBefore(state, playT);
      if (!q) { alert('当前时间之前还没有已确认的场记点。'); return; }
      setPlaying(false);
      seek(q.t);
    };
    $('btn-version').onclick = saveVersion;
    $('btn-compare').onclick = openCompare;
    $('btn-reset').onclick = () => {
      if (!confirm('恢复到带初始冲突的导演初排场次？当前版本将被覆盖。')) return;
      versions[activeIdx].state = C.createState(versions[activeIdx].name);
      state = versions[activeIdx].state;
      playT = 0; persist(); renderAll();
    };
    $('cmp-play').onclick = () => {
      if (!cmpState) return;
      cmpState.playing = !cmpState.playing;
      cmpTick.last = null;
      if (cmpState.playing) requestAnimationFrame(cmpTick);
    };
    $('cmp-stop').onclick = () => { if (cmpState) { cmpState.playing = false; cmpState.t = 0; renderCompare(); } };
    $('cmp-close').onclick = closeCompare;

    // 点击标尺/轨道空白处定位
    $('timeline').addEventListener('click', e => {
      if (e.target.classList.contains('tick') || e.target.classList.contains('ruler') ||
          e.target.classList.contains('track')) {
        const x = e.clientX - $('timeline').getBoundingClientRect().left - 92;
        if (x >= 0) seek(xToT(x));
      }
    });
    window.addEventListener('beforeunload', persist);
  }

  bind();
  renderAll();
  seek(0);

  // 调试/自动化钩子
  window.__app = { getState: () => state, rerender: renderAll, seek, setPlaying, get playT() { return playT; } };
})();
