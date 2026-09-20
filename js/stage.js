/* 舞台俯视 SVG 渲染：给定场次状态与时间，渲染所有机械与演员 */
(function (global) {
  'use strict';

  const W = 640;
  const PAD_L = 26, PAD_R = 26, PAD_T = 14, PAD_B = 18;
  const STAGE_W = 12;

  function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(k => el.setAttribute(k, attrs[k]));
    return el;
  }

  function laneMap(state) {
    const m = {};
    state.lanes.forEach(l => { m[l.id] = l; });
    return m;
  }

  function snapshotAt(Core, state, t) {
    const defs = laneMap(state);
    const out = { lifts: {}, bars: {}, turntables: {}, actors: {} };
    state.lanes.forEach(def => {
      const clips = Core.sortedLaneClips(state.clips, def.id);
      if (def.kind === 'lift') out.lifts[def.id] = Core.laneStateAt(def, clips, t);
      else if (def.kind === 'bar') out.bars[def.id] = Core.laneStateAt(def, clips, t);
      else if (def.kind === 'turntable') out.turntables[def.id] = Core.laneStateAt(def, clips, t);
      else if (def.kind === 'actor') out.actors[def.id] = Core.actorAt(clips, def.startX, t);
    });
    return out;
  }

  function render(container, Core, state, t, conflicts) {
    container.innerHTML = '';
    const holder = document.createElement('div');
    holder.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;';
    const box = container.getBoundingClientRect();
    const H = Math.max(240, Math.round(W * (box.height > 10 ? box.height / Math.max(box.width, 1) : 0.47)));
    const SX = x => PAD_L + (x / STAGE_W) * (W - PAD_L - PAD_R);
    const SXP = x => (x / STAGE_W) * (W - PAD_L - PAD_R);
    const FLOOR_TOP = PAD_T + 10;
    const FLOOR_BOT = H - PAD_B - 4;
    const FLOOR_H = FLOOR_BOT - FLOOR_TOP;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
    svg.style.cssText = 'width:100%;height:100%;';
    const defs = laneMap(state);
    const snap = snapshotAt(Core, state, t);
    const unsafe = unsafeSet(conflicts, t);
    const barZoneTop = FLOOR_TOP + 8;
    const barZoneH = FLOOR_H * 0.32;
    const diskCy = FLOOR_TOP + FLOOR_H * 0.58;
    const actorCy = FLOOR_BOT - 14;

    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'stage-off' }));
    svg.appendChild(svgEl('rect', {
      x: SX(0), y: FLOOR_TOP, width: SXP(STAGE_W), height: FLOOR_H, class: 'stage-floor'
    }));
    for (let x = 0; x <= 12; x += 2) {
      svg.appendChild(svgEl('line', { x1: SX(x), y1: FLOOR_TOP, x2: SX(x), y2: FLOOR_BOT, class: 'stage-grid' }));
      const t2 = svgEl('text', { x: SX(x), y: H - 6, class: 'machine-label' });
      t2.textContent = x + 'm';
      svg.appendChild(t2);
    }
    // 顶部桁架
    svg.appendChild(svgEl('line', {
      x1: SX(0), y1: FLOOR_TOP + 4, x2: SX(12), y2: FLOOR_TOP + 4, stroke: '#56657e', 'stroke-width': 1
    }));

    const liftH = 20;

    // 升降台：越接近台面越亮越“高”
    Object.keys(snap.lifts).forEach(id => {
      const def = defs[id], st = snap.lifts[id];
      const ratio = (st.value - def.bottom) / (def.top - def.bottom);
      const x = SX(def.x1), w = SXP(def.x2 - def.x1);
      const y = FLOOR_BOT - 6 - ratio * 20;
      svg.appendChild(svgEl('rect', {
        x, y, width: w, height: liftH, rx: 4,
        class: 'lift-rect' + (unsafe.has(id) ? ' unsafe' : ''),
        opacity: 0.4 + ratio * 0.55
      }));
      const lab = svgEl('text', { x: x + w / 2, y: y + 14, class: 'machine-label' });
      lab.textContent = def.name + ' ' + st.value.toFixed(1) + 'm';
      svg.appendChild(lab);
    });

    // 转盘
    Object.keys(snap.turntables).forEach(id => {
      const def = defs[id], st = snap.turntables[id];
      const cx = SX(def.cx), r = SXP(def.radius), cy = diskCy;
      const g = svgEl('g');
      g.appendChild(svgEl('circle', {
        cx, cy, r, class: 'turntable-disc' + (unsafe.has(id) ? ' unsafe' : ''),
        opacity: st.moving ? 0.95 : 0.7
      }));
      const ang = (st.value % 360) * Math.PI / 180;
      g.appendChild(svgEl('line', {
        x1: cx, y1: cy, x2: cx + Math.cos(ang) * r * 0.85,
        y2: cy + Math.sin(ang) * r * 0.85, stroke: '#bfeef2', 'stroke-width': 2
      }));
      g.appendChild(svgEl('circle', { cx, cy, r: 3, fill: '#bfeef2' }));
      const lab = svgEl('text', { x: cx, y: cy + r + 12, class: 'machine-label' });
      lab.textContent = def.name + ' ' + Math.round(st.value) + '°';
      g.appendChild(lab);
      svg.appendChild(g);
    });

    // 吊杆：高位贴近桁架，低位下沉到舞台区
    Object.keys(snap.bars).forEach(id => {
      const def = defs[id], st = snap.bars[id];
      const x1 = SX(def.x1), x2 = SX(def.x2);
      const ratio = st.value / def.top;
      const yBeam = barZoneTop + 6 + (1 - ratio) * (barZoneH - 10);
      const cls = 'bar-line' + (unsafe.has(id) ? ' unsafe' : '');
      [x1 + 2, x2 - 2].forEach(x => {
        svg.appendChild(svgEl('line', { x1: x, y1: FLOOR_TOP + 4, x2: x, y2: yBeam, class: 'bar-dash' }));
      });
      svg.appendChild(svgEl('line', { x1, y1: yBeam, x2, y2: yBeam, class: cls }));
      const lab = svgEl('text', { x: (x1 + x2) / 2, y: yBeam - 3, class: 'machine-label' });
      lab.textContent = def.name + ' ' + st.value.toFixed(1) + 'm';
      svg.appendChild(lab);
    });

    // 演员
    Object.keys(snap.actors).forEach(id => {
      const def = defs[id], st = snap.actors[id];
      if (!st.present) return;
      const cx = SX(st.x), cy = actorCy;
      svg.appendChild(svgEl('circle', {
        cx, cy, r: 7, class: 'actor-dot' + (unsafe.has(id) ? ' unsafe' : '')
      }));
      const lab = svgEl('text', { x: cx, y: cy - 11, class: 'actor-label' });
      lab.textContent = def.name;
      svg.appendChild(lab);
    });

    holder.appendChild(svg);
    container.appendChild(holder);
  }

  function unsafeSet(conflicts, t) {
    const s = new Set();
    (conflicts || []).forEach(c => {
      if (t >= c.start && t < c.end) c.lanes.forEach(l => s.add(l));
    });
    return s;
  }

  global.StageView = { render, snapshotAt };
})(window);
