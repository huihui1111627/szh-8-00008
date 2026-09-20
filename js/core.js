/* 舞台联排控制 —— 纯逻辑核心：模型 / 重排 / 冲突检测 / 版本 / 场记点 */
(function (global) {
  'use strict';

  const STAGE = { W: 12, FRONT: 12, BACK: 0 };
  const STEP = 0.1;            // 冲突检测采样步长（秒）
  const MIN_DUR = 0.4;         // 最短动作时长
  const GAP = 0.5;             // 同轨道重排时动作间最小间隔
  const PAUSE_DUR = 2;         // 默认临时停顿时长

  // 安全参数（单位：米）
  const SAFE = {
    liftLift: 2.0,     // 两升降台运动时净距
    liftTurntable: 1.5,// 升降台运动时与转盘外缘净距
    barHeight: 2.5,    // 吊杆在有人区域运行时的最低安全高度
    barLift: 2.5,      // 吊杆在运动中升降台上方的净高
    barTurntable: 2.5, // 吊杆与旋转台面的净高
    barBarV: 0.8,      // 吊杆上下高差
    actorMargin: 0.6   // 演员与机械危险区域的侧向余量
  };

  // 固定资源定义。x1/x2 为水平占地区间；转盘额外用半径表达扫掠。
  function laneDefs() {
    return [
      { id: 'liftA', kind: 'lift', name: '升降台 A', x1: 1.5, x2: 3.5,
        top: 0, bottom: -1.5, home: -1.5 },
      { id: 'liftB', kind: 'lift', name: '升降台 B', x1: 8.5, x2: 10.5,
        top: 0, bottom: -1.5, home: 0 },
      { id: 'turntable', kind: 'turntable', name: '旋转舞台', x1: 4.2, x2: 7.8,
        cx: 6, radius: 1.8, home: 0 },
      { id: 'bar1', kind: 'bar', name: '吊杆 1', x1: 1.5, x2: 3.5,
        top: 5, bottom: 1, home: 5 },
      { id: 'bar2', kind: 'bar', name: '吊杆 2', x1: 8.5, x2: 10.5,
        top: 5, bottom: 1, home: 5 },
      { id: 'actorA', kind: 'actor', name: '演员 A', home: -1, startX: -1 },
      { id: 'actorB', kind: 'actor', name: '演员 B', home: 13, startX: 13 }
    ];
  }

  let seq = 0;
  function cid(prefix) { return prefix + '_' + (++seq) + '_' + Math.floor(Math.random() * 1e4); }

  function mkClip(laneId, start, end, level) {
    return { id: cid(laneId), laneId, start: round(start), end: round(end), level };
  }
  function round(t) { return Math.round(t * 10) / 10; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // 初始演示场次（故意保留若干冲突，供导演排查）
  function seedClips() {
    const out = [];
    const add = (laneId, s, e, level) => out.push(mkClip(laneId, s, e, level));
    // 吊杆1：下降挂景（10–14），升起（20–24）
    add('bar1', 10, 14, 1);
    add('bar1', 20, 24, 5);
    // 升降台A：升起到台面（14–20）
    add('liftA', 14, 20, 0);
    // 转盘：180° 旋转（16–28）
    add('turntable', 16, 28, 180);
    // 升降台B：下沉（30–36），升起（40–46）
    add('liftB', 30, 36, -1.5);
    add('liftB', 40, 46, 0);
    // 吊杆2：下降（30–34），升起（38–42）
    add('bar2', 30, 34, 1);
    add('bar2', 38, 42, 5);
    // 演员A：上场 → 走到吊杆1区 → 穿过转盘 → 下场
    add('actorA', 0, 6, 1.5);
    add('actorA', 6, 12, 2.5);
    add('actorA', 12, 24, 7.8);
    add('actorA', 24, 30, 13);
    // 演员B：从上场 → 穿过转盘 → 进入吊杆2/升降台B区 → 下场
    add('actorB', 14, 24, 6);
    add('actorB', 24, 32, 8.5);
    add('actorB', 32, 40, 9.5);
    add('actorB', 40, 47, 13);
    return out;
  }

  // ---------- 状态推演 ----------
  function laneClips(state, laneId) {
    return state.clips.filter(c => c.laneId === laneId)
      .sort((a, b) => a.start - b.start);
  }

  function activeClip(clips, t) {
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      if (t >= c.start && t < c.end) return { clip: c, index: i };
      if (t < c.start) return { clip: null, index: i };
    }
    return { clip: null, index: clips.length };
  }

  // 某轨道在 t 时刻的层级/位置（迭代求值，保证与前序动作连续）
  function laneStateAt(def, clips, t) {
    let value = def.home;
    let moving = false;
    let active = null;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      if (t < c.start) break;
      const from = value;
      if (t >= c.end) {
        value = c.level;
        continue;
      }
      active = c;
      moving = !c.pause;
      const p = (t - c.start) / Math.max(c.end - c.start, 1e-6);
      value = from + (c.level - from) * p;
    }
    return { value, moving, active };
  }

  // 演员在 t 时刻的位置（带前后上下文，便于判断离场）
  function actorAt(clips, home, t) {
    let x = home;
    let present = x >= 0 && x <= STAGE.W;
    let moving = false;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      if (t < c.start) break;
      if (t >= c.end) { x = c.level; continue; }
      moving = true;
      const p = (t - c.start) / Math.max(c.end - c.start, 1e-6);
      x = x + (c.level - x) * p;
    }
    present = x > 0 && x < STAGE.W;
    // 已走到台外（含最后一段离场）即视为离场
    const last = clips[clips.length - 1];
    if (last && t >= last.end) present = last.level > 0 && last.level < STAGE.W;
    return { x, present, moving };
  }

  // 转盘在 t 时刻角度与扫掠区间
  function turntableState(def, clips, t) {
    const s = laneStateAt(def, clips, t);
    const ang = (s.value % 360) * Math.PI / 180;
    return { angle: s.value, moving: s.moving, active: s.active, ang };
  }

  // 转盘旋转时，固定区域 [x1,x2] 是否被盘面（含余量 m）覆盖
  function turntableCovers(def, x1, x2, m) {
    const lo = x1 - m, hi = x2 + m, r = def.radius;
    return !(lo > def.cx + r || hi < def.cx - r);
  }

  // 危险区间与演员点的侧向重叠判定
  function actorInZone(x, def, margin) {
    const a = def.x1 - margin, b = def.x2 + margin;
    return x >= a && x <= b;
  }

  // ---------- 冲突检测 ----------
  // 返回 {conflicts:[{id,severity,kind,lanes,start,end,reason,clips}], overlaps:[{laneId,start,end}]}
  function evaluate(state) {
    const defs = {};
    state.lanes.forEach(l => { defs[l.id] = l; });
    const byLane = {};
    state.lanes.forEach(l => { byLane[l.id] = laneClips(state, l.id); });
    const end = stateEnd(state);
    const hits = [];   // 每个采样点的冲突：{t, severity, kind, lanes, reason, clipIds}
    const overlapSamples = {};

    // 同轨道动作重叠（硬错误）
    state.lanes.forEach(l => {
      const cs = byLane[l.id];
      for (let i = 1; i < cs.length; i++) {
        if (cs[i].start < cs[i - 1].end - 1e-6) {
          const s = cs[i].start, e = Math.min(cs[i].end, cs[i - 1].end);
          for (let t = s; t < e - 1e-6; t += STEP) {
            overlapSamples[l.id] = overlapSamples[l.id] || [];
            overlapSamples[l.id].push(t);
            hits.push({ t: round(t), severity: 'block', kind: 'overlap',
              lanes: [l.id], reason: l.name + '存在动作时间重叠',
              clipIds: [cs[i - 1].id, cs[i].id] });
          }
        }
      }
    });

    const S = (t) => snapshot(defs, byLane, t);

    for (let t = 0; t <= end + 1e-6; t += STEP) {
      const snap = S(round(t));
      checkMachines(snap, defs, hits);
      checkActors(snap, defs, hits);
    }

    // 按类型+涉及轨道+片段归并连续采样点
    const groups = new Map();
    hits.forEach(h => {
      const key = h.kind + '|' + h.lanes.slice().sort().join(',') + '|' +
        h.clipIds.slice().sort().join(',');
      if (!groups.has(key)) groups.set(key, { ...h, times: [] });
      groups.get(key).times.push(h.t);
    });

    const conflicts = [];
    groups.forEach(g => {
      const times = g.times.sort((a, b) => a - b);
      let s = times[0], prev = times[0];
      const runs = [];
      for (let i = 1; i < times.length; i++) {
        if (times[i] - prev > STEP + 1e-6) { runs.push([s, prev]); s = times[i]; }
        prev = times[i];
      }
      runs.push([s, prev]);
      runs.forEach(r => {
        conflicts.push({
          id: cid('cf'), kind: g.kind, severity: g.severity, lanes: g.lanes,
          start: round(r[0]), end: round(r[1] + STEP), reason: g.reason,
          clips: g.clipIds
        });
      });
    });
    conflicts.sort((a, b) => a.start - b.start);

    const overlaps = Object.keys(overlapSamples).map(laneId => {
      const ts = overlapSamples[laneId].sort((a, b) => a - b);
      return { laneId, start: ts[0], end: round(ts[ts.length - 1] + STEP) };
    });

    return { conflicts, overlaps };
  }

  // 某时刻全部资源快照
  function snapshot(defs, byLane, t) {
    const s = { t, lifts: {}, bars: {}, turntables: {}, actors: {} };
    Object.keys(defs).forEach(id => {
      const def = defs[id], clips = byLane[id];
      if (def.kind === 'lift') s.lifts[id] = { def, ...laneStateAt(def, clips, t) };
      else if (def.kind === 'bar') s.bars[id] = { def, ...laneStateAt(def, clips, t) };
      else if (def.kind === 'turntable') {
        const ts = turntableState(def, clips, t);
        s.turntables[id] = { def, ...ts };
      } else if (def.kind === 'actor') {
        s.actors[id] = { def, ...actorAt(clips, def.startX, t) };
      }
    });
    return s;
  }

  const PROX = 0.8; // 旋转台与其他固定设施的几何接近余量

  function nearTurntable(tt, def) {
    const r = tt.def.radius + PROX;
    return def.x2 >= tt.def.cx - r && def.x1 <= tt.def.cx + r;
  }

  function checkMachines(snap, defs, hits) {
    const push = (sev, kind, lanes, reason, ids) =>
      hits.push({ t: snap.t, severity: sev, kind, lanes, reason, clipIds: ids });
    const activeId = o => (o.active ? o.active.id : null);

    const lifts = Object.values(snap.lifts);
    const bars = Object.values(snap.bars);
    const tts = Object.values(snap.turntables);

    // 升降台 × 升降台
    for (let i = 0; i < lifts.length; i++) {
      for (let j = i + 1; j < lifts.length; j++) {
        const a = lifts[i], b = lifts[j];
        if (a.moving && b.moving) {
          const gap = Math.max(b.def.x1 - a.def.x2, a.def.x1 - b.def.x2);
          if (gap < SAFE.liftLift)
            push('block', 'lift-lift', [a.def.id, b.def.id],
              a.def.name + '与' + b.def.name + '同时运动且净距不足 ' + SAFE.liftLift + 'm',
              [activeId(a), activeId(b)]);
        }
      }
    }
    // 升降台 × 转盘
    lifts.forEach(l => {
      tts.forEach(tt => {
        if (l.moving && tt.moving && nearTurntable(tt, l.def))
          push('block', 'lift-turntable', [l.def.id, tt.def.id],
            l.def.name + '运动时与旋转台面净距不足 ' + SAFE.liftTurntable + 'm',
            [activeId(l), activeId(tt)]);
      });
    });
    // 升降台 × 吊杆
    lifts.forEach(l => {
      bars.forEach(b => {
        const overlap = !(b.def.x2 < l.def.x1 || b.def.x1 > l.def.x2);
        if (l.moving && b.moving && overlap && b.value < SAFE.barLift)
          push('block', 'lift-bar', [l.def.id, b.def.id],
            b.def.name + '低位时' + l.def.name + '仍在运动，净高不足 ' + SAFE.barLift + 'm',
            [activeId(l), activeId(b)]);
      });
    });
    // 转盘 × 吊杆
    tts.forEach(tt => {
      bars.forEach(b => {
        if (tt.moving && b.moving && nearTurntable(tt, b.def) && b.value < SAFE.barTurntable)
          push('block', 'turntable-bar', [tt.def.id, b.def.id],
            b.def.name + '低位时旋转舞台仍在转动，净高不足 ' + SAFE.barTurntable + 'm',
            [activeId(tt), activeId(b)]);
      });
    });
    // 吊杆 × 吊杆
    for (let i = 0; i < bars.length; i++) {
      for (let j = i + 1; j < bars.length; j++) {
        const a = bars[i], b = bars[j];
        const overlap = !(b.def.x2 < a.def.x1 || b.def.x1 > a.def.x2);
        if (overlap && a.moving && b.moving && Math.abs(a.value - b.value) < SAFE.barBarV)
          push('warn', 'bar-bar', [a.def.id, b.def.id],
            a.def.name + '与' + b.def.name + '水平投影重叠且高差不足 ' + SAFE.barBarV + 'm',
            [activeId(a), activeId(b)]);
      }
    }
  }

  function checkActors(snap, defs, hits) {
    const push = (sev, kind, lanes, reason, ids) =>
      hits.push({ t: snap.t, severity: sev, kind, lanes, reason, clipIds: ids });
    Object.values(snap.actors).forEach(ac => {
      if (!ac.present) return;
      Object.values(snap.lifts).forEach(l => {
        if (l.moving && actorInZone(ac.x, l.def, SAFE.actorMargin))
          push('block', 'actor-lift', [ac.def.id, l.def.id],
            ac.def.name + '尚未离开' + l.def.name + '区域，升降台已在运动',
            [l.active.id]);
      });
      Object.values(snap.bars).forEach(b => {
        if (b.moving && b.value < SAFE.barHeight && actorInZone(ac.x, b.def, SAFE.actorMargin))
          push('block', 'actor-bar', [ac.def.id, b.def.id],
            ac.def.name + '位于' + b.def.name + '下方时吊杆仍在低位运行',
            [b.active.id]);
      });
      Object.values(snap.turntables).forEach(tt => {
        const dist = Math.abs(ac.x - tt.def.cx);
        if (tt.moving && dist < tt.def.radius + SAFE.actorMargin)
          push('block', 'actor-turntable', [ac.def.id, tt.def.id],
            ac.def.name + '尚未离开旋转台面，转盘已开始转动',
            [tt.active.id]);
      });
    });
  }

  // ---------- 时间轴工具 ----------
  function stateEnd(state) {
    return state.clips.reduce((m, c) => Math.max(m, c.end), 0);
  }

  function sortedLaneClips(clips, laneId) {
    return clips.filter(c => c.laneId === laneId).sort((a, b) => a.start - b.start);
  }

  // 把 clips[index] 之后的片段整体平移 delta（严格保持各片段时长与相对节奏）
  function shiftFollowers(clips, index, delta) {
    for (let j = index + 1; j < clips.length; j++) {
      clips[j].start = round(Math.max(0, clips[j].start + delta));
      clips[j].end = round(Math.max(MIN_DUR, clips[j].end + delta));
    }
  }

  // 拖动片段整体移动；起点不得早于 0，不与前一片段重叠（保留 GAP），后续整体平移
  function moveClip(state, clipId, newStart) {
    const c = state.clips.find(x => x.id === clipId);
    if (!c) return;
    const laneId = c.laneId;
    const cs = sortedLaneClips(state.clips, laneId);
    const index = cs.indexOf(c);
    const dur = c.end - c.start;
    let s = round(clamp(newStart, 0, 600));
    if (index > 0) s = Math.max(s, round(cs[index - 1].end + GAP));
    const delta = round(s - c.start);
    c.start = s;
    c.end = round(s + dur);
    if (index + 1 < cs.length && delta !== 0) {
      cs[index + 1].start = round(cs[index + 1].start + delta);
      cs[index + 1].end = round(cs[index + 1].end + delta);
      shiftFollowers(cs, index + 1, delta);
      const need = round(c.end + GAP - cs[index + 1].start);
      if (need > 0) {
        cs[index + 1].start = round(cs[index + 1].start + need);
        cs[index + 1].end = round(cs[index + 1].end + need);
        shiftFollowers(cs, index + 1, need);
      }
    }
  }

  // 拖动右边缘改时长（等价于改速度）；后续片段整体平移
  function resizeEnd(state, clipId, newEnd) {
    const c = state.clips.find(x => x.id === clipId);
    if (!c) return;
    const cs = sortedLaneClips(state.clips, c.laneId);
    const index = cs.indexOf(c);
    const e = round(clamp(newEnd, c.start + MIN_DUR, 600));
    c.end = e;
    if (index + 1 < cs.length) {
      const need = round(c.end + GAP - cs[index + 1].start);
      if (need > 0) {
        cs[index + 1].start = round(cs[index + 1].start + need);
        cs[index + 1].end = round(cs[index + 1].end + need);
        shiftFollowers(cs, index + 1, need);
      }
    }
  }

  // 检视面板直接设置起止/层级（自动排序并尽量保持不重叠）
  function setClipFields(state, clipId, fields) {
    const c = state.clips.find(x => x.id === clipId);
    if (!c) return;
    if (typeof fields.level === 'number') c.level = fields.level;
    if (typeof fields.start === 'number' || typeof fields.end === 'number') {
      const dur = Math.max(MIN_DUR, (fields.end != null ? fields.end : c.end) -
        (fields.start != null ? fields.start : c.start));
      if (fields.start != null) c.start = round(Math.max(0, fields.start));
      c.end = round(c.start + dur);
    }
    normalizeLane(state, c.laneId);
  }

  // 把一条轨道上的片段重新排开（按起点排序，消除重叠，保持各片段时长）
  function normalizeLane(state, laneId) {
    const cs = sortedLaneClips(state.clips, laneId);
    let cursor = 0;
    cs.forEach((c, i) => {
      if (c.start < cursor) c.start = cursor;
      c.end = Math.max(round(c.start + MIN_DUR), c.end);
      cursor = round(c.end + GAP);
    });
  }

  // 在片段 t 时刻插入临时停顿：把该片段切成两段，中间插入停顿片段
  function insertPause(state, clipId, t, pauseDur) {
    const c = state.clips.find(x => x.id === clipId);
    if (!c || t <= c.start + 0.2 || t >= c.end - 0.2) return null;
    pauseDur = pauseDur || PAUSE_DUR;
    const def = state.lanes.find(l => l.id === c.laneId);
    const at = laneStateAt(def, sortedLaneClips(state.clips, c.laneId), t).value;
    const mid = round(at);
    const first = mkClip(c.laneId, c.start, round(t), mid);
    const hold = mkClip(c.laneId, round(t), round(t + pauseDur), mid);
    hold.pause = true;
    const rest = mkClip(c.laneId, round(t + pauseDur), round(c.end + pauseDur), c.level);
    state.clips.splice(state.clips.indexOf(c), 1, first, hold, rest);
    const cs = sortedLaneClips(state.clips, c.laneId);
    shiftFollowers(cs, cs.indexOf(rest), pauseDur);
    return hold;
  }

  function deleteClip(state, clipId) {
    const i = state.clips.findIndex(x => x.id === clipId);
    if (i >= 0) state.clips.splice(i, 1);
  }

  function addClip(state, laneId, start, end, level) {
    const def = state.lanes.find(l => l.id === laneId);
    if (typeof level !== 'number') level = def.home;
    const c = mkClip(laneId, start, end);
    c.level = level;
    state.clips.push(c);
    normalizeLane(state, laneId);
    return c;
  }

  // ---------- 场次 / 版本 / 场记点 ----------
  function createState(name) {
    const lanes = laneDefs();
    const clips = seedClips();
    return {
      name: name || 'v1 · 导演初排',
      lanes,
      clips,
      cues: [],
      selected: null
    };
  }

  function cloneState(state, name) {
    return {
      name: name || state.name + ' 副本',
      lanes: state.lanes.map(l => ({ ...l })),
      clips: state.clips.map(c => ({ ...c })),
      cues: state.cues.map(q => ({ ...q })),
      selected: null
    };
  }

  function addCue(state, t, label) {
    const n = state.cues.length + 1;
    const cue = { id: cid('cue'), t: round(t), label: label || ('场记点 ' + n) };
    state.cues.push(cue);
    state.cues.sort((a, b) => a.t - b.t);
    return cue;
  }
  function removeCue(state, id) {
    const i = state.cues.findIndex(q => q.id === id);
    if (i >= 0) state.cues.splice(i, 1);
  }
  // 最近的“已确认”场记点（t <= current）
  function lastCueAtOrBefore(state, t) {
    let best = null;
    state.cues.forEach(q => { if (q.t <= t + 1e-6 && (!best || q.t > best.t)) best = q; });
    return best;
  }

  function riskMetrics(conflicts) {
    const block = conflicts.filter(c => c.severity === 'block');
    const warn = conflicts.filter(c => c.severity === 'warn');
    const span = block.reduce((m, c) => m + (c.end - c.start), 0) +
      warn.reduce((m, c) => m + (c.end - c.start) * 0.5, 0);
    return {
      blocked: block.length > 0,
      blockCount: block.length,
      warnCount: warn.length,
      riskSeconds: round(Math.round(span * 10) / 10)
    };
  }

  // 两版本片段差异（按轨道对齐层级序列做近似比较）
  function diffStates(a, b) {
    const out = [];
    a.lanes.forEach(def => {
      const ca = sortedLaneClips(a.clips, def.id);
      const cb = sortedLaneClips(b.clips, def.id);
      const sa = ca.reduce((m, c) => m + c.start, 0);
      const sb = cb.reduce((m, c) => m + c.start, 0);
      const ea = ca.length ? ca[ca.length - 1].end : 0;
      const eb = cb.length ? cb[cb.length - 1].end : 0;
      if (Math.abs(sa - sb) > 0.05 || Math.abs(ea - eb) > 0.05 || ca.length !== cb.length) {
        out.push({ laneId: def.id, name: def.name,
          endA: round(ea), endB: round(eb),
          delta: round(Math.round((eb - ea) * 10) / 10) });
      }
    });
    return out;
  }

  const api = {
    STAGE, STEP, MIN_DUR, GAP, PAUSE_DUR, SAFE,
    laneDefs, seedClips, mkClip, round,
    laneClips, laneStateAt, actorAt, turntableState, stateEnd,
    evaluate, riskMetrics,
    moveClip, resizeEnd, setClipFields, insertPause, deleteClip, addClip, normalizeLane,
    createState, cloneState, addCue, removeCue, lastCueAtOrBefore, diffStates,
    sortedLaneClips
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.StageCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
