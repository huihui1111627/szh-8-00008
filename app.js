'use strict';
/* ============================================================
 * 舞台机械联排控制系统
 * 纯前端、零依赖：运动学模型 / 几何安全冲突检测 / 时间轴重排 /
 * 场记点恢复 / 多版本并排回放
 * ============================================================ */

const STOP_REST = -1;

/* ---------------- 工具 ---------------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round1 = (v) => Math.round(v * 10) / 10;
const deepClone = (o) => JSON.parse(JSON.stringify(o));
const overlap = (a, b, c, d) => a < d && c < b;

function rectInflate(r, m) {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}
function rectsIntersect(a, b) {
  return overlap(a.x, a.x + a.w, b.x, b.x + b.w) &&
         overlap(a.y, a.y + a.h, b.y, b.y + b.h);
}
function rectCenter(r) { return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }
function pointInSector(p, c, radius, a0, a1) {
  const dx = p.x - c.x, dy = p.y - c.y;
  const dist = Math.hypot(dx, dy);
  if (dist > radius) return false;
  let ang = Math.atan2(dy, dx);
  if (ang < 0) ang += Math.PI * 2;
  if (a0 <= a1) return ang >= a0 && ang <= a1;
  return ang >= a0 || ang <= a1;
}
function sectorHitsRect(c, radius, a0, a1, rect) {
  const pts = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x, y: rect.y + rect.h },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    rectCenter(rect),
  ];
  if (pts.some((p) => pointInSector(p, c, radius, a0, a1))) return true;
  const steps = 24;
  for (let i = 0; i < steps; i++) {
    const a = a0 + ((a1 - a0 + Math.PI * 2) % (Math.PI * 2)) * (i / steps);
    if (a0 > a1 && a < a0) continue;
    const p = { x: c.x + Math.cos(a) * radius, y: c.y + Math.sin(a) * radius };
    if (p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) return true;
  }
  return false;
}

/* ---------------- 运动学模型 ---------------- */
const Core = {
  motionLen(unit, cue) {
    const p = cue.params;
    const from = cue._from != null ? cue._from : unit.rest;
    switch (unit.type) {
      case 'lift': return Math.abs(p.to - from);
      case 'turn': return Math.abs((p.toAngle ?? 0) - from) * (Math.PI / 180);
      case 'batten': return Math.abs(p.to - from);
      case 'actor': return Math.hypot(p.to[0] - p.from[0], p.to[1] - p.from[1]);
    }
  },
  baseDur(unit, cue) {
    return Math.max(0.2, this.motionLen(unit, cue) / cue.speed);
  },
  pauseTotal(cue) {
    return (cue.pauses || []).reduce((s, p) => s + p.dur, 0);
  },
  cueEnd(cue) {
    return cue.start + cue._baseDur + this.pauseTotal(cue);
  },
  cueStartOn(cue) {
    return cue.start + (cue._fromOn || 0);
  },
  /* local: 相对 cue 起点的墙上时间 -> 有效运动时长 */
  wallToEff(cue, local) {
    let t = local, acc = 0;
    const sorted = [...(cue.pauses || [])].sort((a, b) => a.at - b.at);
    for (const pz of sorted) {
      if (t <= pz.at + acc) break;
      if (t < pz.at + pz.dur + acc) return pz.at;
      t -= pz.dur; acc += pz.dur;
    }
    return Math.min(t, cue._baseDur);
  },
  evalCueAt(unit, cue, t) {
    const local = t - cue.start;
    const base = this.baseDur(unit, cue);
    const total = base + this.pauseTotal(cue);
    if (local < 0 || local > total + 1e-6) return null;
    const eff = clamp(this.wallToEff(cue, local), 0, base);
    const frac = clamp(eff / base, 0, 1);
    return { frac, eff, base, local, paused: this.isPausedAt(cue, local) };
  },
  isPausedAt(cue, local) {
    let acc = 0;
    for (const pz of [...(cue.pauses || [])].sort((a, b) => a.at - b.at)) {
      if (local >= pz.at + acc && local < pz.at + pz.dur + acc) return true;
      acc += pz.dur;
    }
    return false;
  },
  cueActive(unit, cues, t) {
    for (const cue of cues) {
      if (t < cue.start - 1e-6 || t > this.cueEnd(cue) + 1e-6) continue;
      if (unit.type === 'actor' && cue.params.fromOn != null &&
          t < cue.start + cue.params.fromOn - 1e-6) continue;
      const ev = this.evalCueAt(unit, cue, t);
      if (ev) return { cue, ev };
    }
    return null;
  },
  unitState(units, cuesByUnit, unitId, t) {
    const unit = units.find((u) => u.id === unitId);
    const active = this.cueActive(unit, cuesByUnit[unitId] || [], t);
    if (!active) {
      const list = (cuesByUnit[unitId] || []).filter((c) => Core.cueEnd(c) <= t + 1e-6);
      if (unit.type === 'actor') {
        return { unit, value: { x: unit.rest[0], y: unit.rest[1], offstage: true },
                 active: false, cue: null, paused: false };
      }
      let value = unit.rest;
      if (list.length) {
        const last = list[list.length - 1];
        value = unit.type === 'turn' ? (last.params.toAngle ?? 0) : last.params.to;
      }
      return { unit, value, active: false, cue: null, paused: false };
    }
    const { cue, ev } = active;
    let value;
    if (unit.type === 'actor') {
      const f = cue.params.from, g = cue.params.to;
      value = {
        x: f[0] + (g[0] - f[0]) * ev.frac,
        y: f[1] + (g[1] - f[1]) * ev.frac,
        offstage: false,
      };
    } else if (unit.type === 'turn') {
      value = cue._from + ((cue.params.toAngle ?? 0) - cue._from) * ev.frac;
    } else {
      value = cue._from + (cue.params.to - cue._from) * ev.frac;
    }
    return { unit, value, active: true, cue, paused: ev.paused };
  },
};

/* ---------------- 几何危险区 ---------------- */
const MARGIN = { machine: 0.5, person: 0.4 };
const BATTEN_BUSY_H = 3.5;
const LIFT_BUSY_H = -0.6;

function stateHazard(state) {
  const { unit, value, active, paused } = state;
  if (paused) return null;
  if (unit.type === 'lift') {
    const raised = value > LIFT_BUSY_H;
    if (!raised) return null;
    return {
      kind: 'rect',
      rect: rectInflate(unit.rect, active ? MARGIN.machine : 0.05),
      moving: !!active,
    };
  }
  if (unit.type === 'batten') {
    if (value < BATTEN_BUSY_H) {
      return { kind: 'rect', rect: rectInflate(unit.rect, MARGIN.machine), moving: !!active, h: value };
    }
    return null;
  }
  if (unit.type === 'turn') {
    if (!active) {
      const intr = unit.intrusion || [];
      if (intr.length && unit.rest % 360 !== 0) {
        return { kind: 'polys', polys: intr.map((s) => ({
          c: { x: unit.cx, y: unit.cy }, r: unit.r, a0: s[0], a1: s[1],
        })), moving: false };
      }
      return null;
    }
    const to = state.cue.params.toAngle ?? 0;
    const from = state.cue._from;
    const span = Math.abs(to - from);
    if (span < 0.5) return null;
    const a0 = (Math.min(from, to) * Math.PI) / 180;
    const a1 = (Math.max(from, to) * Math.PI) / 180;
    return {
      kind: 'polys',
      polys: [{ c: { x: unit.cx, y: unit.cy }, r: unit.r, a0, a1 }],
      moving: true, sweep: true,
    };
  }
  if (unit.type === 'actor') {
    if (value.offstage) return null;
    const rect = { x: value.x - unit.size / 2, y: value.y - unit.size / 2, w: unit.size, h: unit.size };
    return { kind: 'person', rect: rectInflate(rect, MARGIN.person) };
  }
  return null;
}

function hazardsHit(h1, h2) {
  const polys = (h) => (h.kind === 'polys' ? h.polys : null);
  if (h1.kind === 'rect' && h2.kind === 'rect') return rectsIntersect(h1.rect, h2.rect);
  if (h1.kind === 'person' && h2.kind === 'rect') return rectsIntersect(h1.rect, h2.rect);
  if (h2.kind === 'person' && h1.kind === 'rect') return rectsIntersect(h2.rect, h1.rect);
  const polySide = polys(h1) ? h1 : polys(h2) ? h2 : null;
  const rectSide = h1.kind === 'rect' || h1.kind === 'person' ? h1
    : (h2.kind === 'rect' || h2.kind === 'person') ? h2 : null;
  if (polySide && rectSide) {
    return polySide.polys.some((s) => sectorHitsRect(s.c, s.r, s.a0, s.a1, rectSide.rect));
  }
  if (polys(h1) && polys(h2)) return false;
  return false;
}

/* ---------------- 冲突检测 ---------------- */
const TYPE_LABEL = { lift: '升降台', turn: '旋转台', batten: '吊杆', actor: '演员' };
const TYPE_COLOR = { lift: 'var(--lift)', turn: 'var(--turn)', batten: 'var(--batten)', actor: 'var(--actor)' };

function describeConflict(a, b) {
  const key = [a.type, b.type].sort().join('-');
  if (key === 'actor-batten') return '吊杆低位运行，演员尚未离场，存在撞击风险';
  if (key === 'actor-lift') return '升降台处于舞台面以上，演员占用该区域';
  if (key === 'actor-turn') return '旋转台扫掠区与演员走位交叉';
  if (key === 'batten-lift') return '吊杆低位与升降台高位空间交叉，安全距离不足';
  if (key === 'lift-lift') return '相邻升降台高差时台面间隙不安全';
  if (key === 'lift-turn') return '升降台与旋转台运动区域重叠';
  if (key === 'batten-turn') return '吊杆低位与旋转台扫掠路径交叉';
  if (key === 'batten-batten') return '吊杆水平投影重叠且同时低位';
  if (key === 'turn-turn') return '旋转台扫掠区相互交叉';
  return '运动路径交叉，安全距离不足';
}

function detectConflicts(units, cues, horizon, opts = {}) {
  const dt = opts.dt || 0.25;
  const cuesByUnit = {};
  for (const c of cues) (cuesByUnit[c.unitId] ||= []).push(c);
  const ids = units.map((u) => u.id);
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]]);
  }
  const byPair = new Map();
  for (let t = 0; t <= horizon + 1e-6; t += dt) {
    const states = {};
    for (const u of units) states[u.id] = Core.unitState(units, cuesByUnit, u.id, t);
    for (const [ia, ib] of pairs) {
      const sa = states[ia], sb = states[ib];
      const ha = stateHazard(sa), hb = stateHazard(sb);
      if (!ha || !hb) continue;
      /* 机械双方：只要处于非复位的占用/低位状态且几何交叉即构成风险；
         演员在场时任意一方运动或静态占用都拦截 */
      if (!hazardsHit(ha, hb)) continue;
      const key = ia + '|' + ib;
      if (!byPair.has(key)) {
        byPair.set(key, { a: sa.unit, b: sb.unit, segs: [] });
      }
      const segs = byPair.get(key).segs;
      if (!segs.length || t - segs[segs.length - 1][1] > dt * 1.6) segs.push([t, t + dt]);
      else segs[segs.length - 1][1] = t + dt;
    }
  }
  const out = [];
  for (const rec of byPair.values()) {
    out.push({
      a: rec.a, b: rec.b,
      type: [rec.a.type, rec.b.type].sort().join('-'),
      desc: describeConflict(rec.a, rec.b),
      segs: rec.segs.map(([s, e]) => [round1(s), round1(Math.min(e, horizon))]),
      start: rec.segs[0][0],
    });
  }
  out.sort((p, q) => p.start - q.start);
  return out;
}

function conflictsAtTime(conflicts, t) {
  return conflicts.filter((c) => c.segs.some(([s, e]) => t >= s - 0.25 && t <= e + 0.25));
}

/* ---------------- 重排（级联） ---------------- */
function recalcCache(unit, cue) {
  if (unit.type === 'actor') {
    cue._fromOn = cue.params.fromOn || 0;
  }
  cue._baseDur = Core.baseDur(unit, cue);
}
function allRecalc(state) {
  for (const cue of state.cues) {
    const unit = state.units.find((u) => u.id === cue.unitId);
    recalcCache(unit, cue);
  }
  /* 链式起点：机械动作的起始位置 = 同机前一动作的终点 */
  const byUnit = {};
  for (const c of state.cues) (byUnit[c.unitId] ||= []).push(c);
  for (const [, list] of Object.entries(byUnit)) {
    list.sort((a, b) => a.start - b.start);
    const unit = state.units.find((u) => u.id === list[0].unitId);
    for (let k = 0; k < list.length; k++) {
      const cue = list[k];
      if (unit.type === 'actor') {
        cue._fromOn = cue.params.fromOn || 0;
      } else {
        const prev = k ? list[k - 1] : null;
        cue._from = prev
          ? (unit.type === 'turn' ? (prev.params.toAngle ?? 0) : prev.params.to)
          : unit.rest;
      }
      recalcCache(unit, cue);
    }
  }
}
function unitEnds(state, unitId) {
  return (state.cuesByUnit()[unitId] || []).map((c) => Core.cueEnd(c));
}
function shiftFollowing(state, unitId, fromCueId, delta) {
  for (const cue of state.cuesByUnit()[unitId] || []) {
    if (cue.id === fromCueId) continue;
    if (cue.start >= state.cueById(fromCueId).start - 1e-6) cue.start = round1(cue.start + delta);
  }
}
/* 拖动起止：start 改变时把同单元后续动作整体平移 */
function moveCue(state, cueId, newStart) {
  const cue = state.cueById(cueId);
  newStart = clamp(round1(newStart), 0, state.horizon - 1);
  const delta = newStart - cue.start;
  if (delta === 0) return;
  cue.start = newStart;
  shiftFollowing(state, cue.unitId, cueId, delta);
}
/* 改速度：右缘拖动改变总时长，后续动作级联平移 */
function resizeCue(state, cueId, newTotalDur) {
  const cue = state.cueById(cueId);
  const unit = state.unitById(cue.unitId);
  const pause = Core.pauseTotal(cue);
  const base = Math.max(0.4, round1(newTotalDur - pause));
  cue.speed = clamp(Core.motionLen(unit, cue) / base, 0.05, 99);
  recalcCache(unit, cue);
  const end = Core.cueEnd(cue);
  const list = state.cuesByUnit()[cue.unitId] || [];
  const idx = list.findIndex((c) => c.id === cueId);
  for (let k = idx + 1; k < list.length; k++) {
    const prevEnd = k === idx + 1 ? end : Core.cueEnd(list[k - 1]);
    list[k].start = round1(Math.max(list[k].start, prevEnd));
  }
}
function insertPause(state, cueId, effAt, dur = 2) {
  const cue = state.cueById(cueId);
  const unit = state.unitById(cue.unitId);
  const at = clamp(round1(effAt), 0, cue._baseDur);
  cue.pauses.push({ at, dur });
  cue.pauses.sort((a, b) => a.at - b.at);
  const delta = dur;
  shiftFollowing(state, cue.unitId, cueId, delta);
  recalcCache(unit, cue);
}
function removePause(state, cueId, index) {
  const cue = state.cueById(cueId);
  const [pz] = cue.pauses.splice(index, 1);
  shiftFollowing(state, cue.unitId, cueId, -pz.dur);
}
function deleteCue(state, cueId) {
  const cue = state.cueById(cueId);
  const i = state.cues.findIndex((c) => c.id === cueId);
  if (i >= 0) state.cues.splice(i, 1);
}
function packUnit(state, unitId) {
  const list = state.cuesByUnit()[unitId] || [];
  for (let k = 1; k < list.length; k++) {
    list[k].start = round1(Core.cueEnd(list[k - 1]));
  }
}

/* ---------------- 初始场景数据（米，舞台 16m×10m） ---------------- */
function initialData() {
  const units = [
    { id: 'L1', type: 'lift', name: '升降台 1', rest: -3, rect: { x: 2.0, y: 2.7, w: 3.2, h: 2.4 } },
    { id: 'L2', type: 'lift', name: '升降台 2', rest: -3, rect: { x: 10.8, y: 3.2, w: 3.2, h: 2.4 } },
    { id: 'T1', type: 'turn', name: '旋转台 中', rest: 0, cx: 8, cy: 5.6, r: 2.2,
      intrusion: [[Math.PI * 0.85, Math.PI * 1.15]] },
    { id: 'B1', type: 'batten', name: '吊杆 A（景片）', rest: 9, rect: { x: 3.0, y: 2.1, w: 3.4, h: 0.7 } },
    { id: 'B2', type: 'batten', name: '吊杆 B（灯杆）', rest: 9, rect: { x: 9.2, y: 1.7, w: 3.6, h: 0.5 } },
    { id: 'A1', type: 'actor', name: '演员 甲', rest: [0, 7.5], size: 0.55 },
    { id: 'A2', type: 'actor', name: '演员 乙', rest: [16, 4], size: 0.55 },
  ];
  const mk = (o) => Object.assign({ pauses: [] }, o);
  const cues = [
    mk({ id: 'c1', unitId: 'B1', start: 4, speed: 1.4, params: { to: 1.5 } }),
    mk({ id: 'c2', unitId: 'B1', start: 22, speed: 1.0, params: { to: 9 } }),
    mk({ id: 'c3', unitId: 'B2', start: 12, speed: 1.95, params: { to: 1.2 } }),
    mk({ id: 'c4', unitId: 'B2', start: 36, speed: 1.2, params: { to: 9 } }),
    mk({ id: 'c5', unitId: 'L1', start: 8, speed: 0.6, params: { to: 0 } }),
    mk({ id: 'c6', unitId: 'L1', start: 30, speed: 0.6, params: { to: -3 } }),
    mk({ id: 'c7', unitId: 'L2', start: 26, speed: 0.6, params: { to: 0 } }),
    mk({ id: 'c8', unitId: 'T1', start: 16, speed: 30, params: { toAngle: 120 } }),
    mk({ id: 'c9', unitId: 'A1', start: 2, speed: 1.1,
      params: { from: [0, 7.5], to: [7, 3.0], fromOn: 0 } }),
    mk({ id: 'c10', unitId: 'A2', start: 10, speed: 1.0,
      params: { from: [16, 4], to: [10.5, 2.0], fromOn: 0 } }),
  ];
  return { units, cues };
}

/* ============================================================
 * 应用状态
 * ============================================================ */
const App = {
  units: [], cues: [],
  marks: [], versions: [],
  currentTime: 0, playing: false, playRate: 1,
  pxPerSec: 14, selectedCueId: null,
  horizon: 60,
  compare: null, // { aId, bId }

  unitById(id) { return this.units.find((u) => u.id === id); },
  cueById(id) { return this.cues.find((c) => c.id === id); },
  cuesByUnit() {
    const m = {};
    for (const c of this.cues) (m[c.unitId] ||= []).push(c);
    for (const k of Object.keys(m)) m[k].sort((a, b) => a.start - b.start);
    return m;
  },
  recompute() {
    allRecalc(this);
    let end = 40;
    for (const c of this.cues) end = Math.max(end, Core.cueEnd(c) + 4);
    this.horizon = Math.ceil(end);
    this.conflicts = detectConflicts(this.units, this.cues, this.horizon);
    this.save();
    ui.renderAll();
  },
  hasLiveConflict() {
    return conflictsAtTime(this.conflicts || [], this.currentTime).length > 0;
  },
  save() {
    try {
      localStorage.setItem('stage_rehearsal', JSON.stringify({
        units: this.units, cues: this.cues, marks: this.marks,
        versions: this.versions, time: this.currentTime,
      }));
    } catch (e) { /* 忽略存储异常 */ }
  },
  load() {
    try {
      const raw = localStorage.getItem('stage_rehearsal');
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!Array.isArray(data.units) || !Array.isArray(data.cues) ||
          !data.units.length || !data.cues.length) return false;
      this.units = data.units || [];
      this.cues = data.cues || [];
      this.marks = data.marks || [];
      this.versions = data.versions || [];
      this.currentTime = data.time || 0;
      return true;
    } catch (e) { return false; }
  },
};

/* ============================================================
 * 舞台俯视渲染
 * ============================================================ */
class StageView {
  constructor(canvas, getScene, compact = false) {
    this.canvas = canvas;
    this.getScene = getScene;
    this.compact = compact;
    this.ro = null;
    window.addEventListener('resize', () => this.draw());
  }
  geometry() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = this.compact ? 10 : 26;
    const sw = 16, sh = 10;
    let scale = Math.min((w - pad * 2) / sw, (h - pad * 2) / sh);
    let ox = (w - sw * scale) / 2, oy = (h - sh * scale) / 2;
    if (this.compact) {
      scale = (w - 8) / sw;
      ox = (w - sw * scale) / 2; oy = 2;
    }
    return { ctx, w, h, scale, ox, oy };
  }
  map(x, y) {
    const g = this.lastG;
    return { x: g.ox + x * g.scale, y: g.oy + y * g.scale };
  }
  rect(r, fill, stroke) {
    const { ctx, scale, ox, oy } = this.lastG;
    ctx.beginPath();
    ctx.rect(ox + r.x * scale, oy + r.y * scale, r.w * scale, r.h * scale);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  draw() {
    const g = this.geometry();
    this.lastG = g;
    const { ctx, w, h, scale, ox, oy } = g;
    const fs = this.compact ? 9 : 11;
    const smallFs = this.compact ? 8 : 10;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b0f15';
    ctx.fillRect(0, 0, w, h);

    // 舞台地面
    this.rect({ x: 0, y: 0, w: 16, h: 10 }, '#111926', '#2a3547');
    ctx.strokeStyle = '#1a2433';
    ctx.lineWidth = 1;
    for (let x = 2; x < 16; x += 2) {
      const p = this.map(x, 0), q = this.map(x, 10);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    for (let y = 2; y < 10; y += 2) {
      const p = this.map(0, y), q = this.map(16, y);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    // 台口方向
    ctx.fillStyle = '#3a475c'; ctx.font = `${fs}px sans-serif`; ctx.textAlign = 'center';
    ctx.fillText('台 口', ox + 8 * scale,
      this.compact ? oy + 10 * scale - 3 : oy + 10 * scale - 5);

    const scene = this.getScene();
    const states = {};
    const byUnit = {};
    for (const c of scene.cues) (byUnit[c.unitId] ||= []).push(c);
    for (const u of scene.units) states[u.id] = Core.unitState(scene.units, byUnit, u.id, scene.time);

    const liveConflicts = conflictsAtTime(scene.conflicts, scene.time);
    const dangerIds = new Set();
    for (const cf of liveConflicts) { dangerIds.add(cf.a.id); dangerIds.add(cf.b.id); }

    // 旋转台
    for (const u of scene.units) {
      if (u.type !== 'turn') continue;
      const st = states[u.id];
      const c = this.map(u.cx, u.cy);
      const r = u.r * scale;
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(176,124,255,.12)'; ctx.fill();
      ctx.strokeStyle = dangerIds.has(u.id) ? '#ff5d5d' : '#b07cff';
      ctx.lineWidth = 2; ctx.stroke();
      // 方向标
      const ang = ((st.value % 360) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + Math.cos(ang) * r * 0.85, c.y + Math.sin(ang) * r * 0.85);
      ctx.strokeStyle = '#d9c2ff'; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = '#cdb4ff'; ctx.font = `${smallFs}px sans-serif`; ctx.textAlign = 'center';
      const tName = this.compact ? u.name.replace(/^(升降台|旋转台|吊杆|演员)\s*/, '') : u.name;
      ctx.fillText(`${tName} ${Math.round(st.value)}°`, c.x, c.y - r - 5);
      // 危险扇区
      const hz = stateHazard(st);
      if (hz && hz.kind === 'polys') {
        for (const s of hz.polys) {
          ctx.beginPath();
          ctx.moveTo(c.x, c.y);
          ctx.arc(c.x, c.y, s.r * scale, s.a0, s.a1);
          ctx.closePath();
          ctx.fillStyle = 'rgba(255,93,93,.14)';
          ctx.strokeStyle = 'rgba(255,93,93,.6)';
          ctx.fill(); ctx.lineWidth = 1.2; ctx.stroke();
        }
      }
    }

    // 升降台
    for (const u of scene.units) {
      if (u.type !== 'lift') continue;
      const st = states[u.id];
      const h = st.value;
      const t = clamp((h + 3) / 3, 0, 1);
      const danger = dangerIds.has(u.id);
      const color = danger ? '#ff5d5d' : (h > -0.6 ? `rgba(77,163,255,${0.35 + 0.55 * t})` : 'rgba(77,163,255,.18)');
      this.rect(u.rect, color, danger ? '#ff5d5d' : '#4da3ff');
      const c = this.map(u.rect.x + u.rect.w / 2, u.rect.y + u.rect.h / 2);
      ctx.fillStyle = '#dbe9ff'; ctx.font = `${smallFs}px sans-serif`; ctx.textAlign = 'center';
      const lName = this.compact ? u.name.replace('升降台 ', 'L') : u.name;
      ctx.fillText(`${lName} ${h.toFixed(1)}m`, c.x, c.y + 3);
    }

    // 吊杆（平面投影 + 高度信息）
    for (const u of scene.units) {
      if (u.type !== 'batten') continue;
      const st = states[u.id];
      const danger = dangerIds.has(u.id);
      const busy = st.value < BATTEN_BUSY_H;
      this.rect(u.rect,
        danger ? 'rgba(255,93,93,.55)' : busy ? 'rgba(245,166,35,.5)' : 'rgba(245,166,35,.14)',
        danger ? '#ff5d5d' : '#f5a623');
      const c = this.map(u.rect.x + u.rect.w / 2, u.rect.y + u.rect.h / 2);
      ctx.fillStyle = '#ffe8c2'; ctx.font = `${smallFs}px sans-serif`; ctx.textAlign = 'center';
      const bName = this.compact ? u.name.replace('吊杆 ', '').replace('（景片）', '').replace('（灯杆）', '') : u.name;
      ctx.fillText(`${bName} ${st.value.toFixed(1)}m`, c.x, c.y + 3);
    }

    // 演员
    for (const u of scene.units) {
      if (u.type !== 'actor') continue;
      const st = states[u.id];
      if (st.value.offstage) continue;
      const c = this.map(st.value.x, st.value.y);
      const rr = (u.size / 2) * scale;
      ctx.beginPath(); ctx.arc(c.x, c.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = dangerIds.has(u.id) ? '#ff5d5d' : '#35c48d';
      ctx.fill(); ctx.strokeStyle = '#06281d'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#d7fff0'; ctx.font = `${smallFs}px sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(u.name.replace('演员 ', ''), c.x, c.y - rr - 3);
    }

    // 场记点标记
    for (const mk of scene.marks) {
      const p = this.map(mk.x ?? 8, 0.3);
      ctx.fillStyle = '#f5d061'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('🚩', p.x, p.y);
    }

    this._states = states;
    return states;
  }
}

/* ============================================================
 * 时间轴
 * ============================================================ */
const LANE_TYPES = ['lift', 'turn', 'batten', 'actor'];

function fmtCue(unit, cue) {
  if (unit.type === 'turn') return `→ ${cue.params.toAngle}° @${cue.speed}°/s`;
  if (unit.type === 'actor') return '走位';
  return `→ ${cue.params.to}m @${cue.speed}m/s`;
}
function valueText(unit, state) {
  if (unit.type === 'actor') return state.value.offstage ? '场外' : '台上';
  if (unit.type === 'turn') return `${Math.round(state.value)}°`;
  return `${state.value.toFixed(1)}m`;
}

const Timeline = {
  el: null,
  init(el) {
    this.el = el;
    this.bind();
  },
  widthFor(t) { return t * App.pxPerSec; },
  render() {
    const totalW = Math.max(this.el.clientWidth - 118, this.widthFor(App.horizon + 4));
    document.getElementById('timeline').style.width = `${118 + totalW}px`;

    // 标尺
    const ruler = document.getElementById('tlRuler');
    ruler.innerHTML = '';
    const step = App.pxPerSec < 10 ? 5 : 2;
    for (let t = 0; t <= App.horizon + 2; t += step) {
      const tick = document.createElement('div');
      tick.className = 'tl-tick';
      tick.style.left = `${this.widthFor(t)}px`;
      tick.textContent = `${t}s`;
      ruler.appendChild(tick);
    }

    const tracks = document.getElementById('tlTracks');
    tracks.innerHTML = '';
    const byUnit = App.cuesByUnit();
    for (const type of LANE_TYPES) {
      for (const unit of App.units.filter((u) => u.type === type)) {
        const lane = document.createElement('div');
        lane.className = 'tl-lane';
        const label = document.createElement('div');
        label.className = 'tl-lane-label';
        label.innerHTML = `<i style="background:${TYPE_COLOR[type]}"></i>${unit.name}` +
          `<span class="pos" data-pos="${unit.id}"></span>`;
        lane.appendChild(label);

        for (const cue of byUnit[unit.id] || []) {
          const block = document.createElement('div');
          block.className = 'cue-block';
          block.dataset.cueId = cue.id;
          if (cue.id === App.selectedCueId) block.classList.add('selected');
          block.style.left = `${this.widthFor(Core.cueStartOn(cue))}px`;
          block.style.width = `${this.widthFor(Core.cueEnd(cue) - Core.cueStartOn(cue))}px`;
          block.style.background = TYPE_COLOR[type];
          block.title = `${unit.name} · ${fmtCue(unit, cue)}`;
          block.innerHTML =
            `<span class="cue-txt">${fmtCue(unit, cue)}` +
            (cue.pauses.length ? ` ⏸×${cue.pauses.length}` : '') + `</span>` +
            `<span class="handle"></span>`;
          // 停顿段叠加
          let acc = 0;
          for (const pz of [...cue.pauses].sort((a, b) => a.at - b.at)) {
            const seg = document.createElement('span');
            seg.className = 'pause-seg';
            seg.style.left = `${this.widthFor(pz.at + acc)}px`;
            seg.style.width = `${this.widthFor(pz.dur)}px`;
            block.appendChild(seg);
            acc += pz.dur;
          }
          lane.appendChild(block);
        }
        tracks.appendChild(lane);
      }
    }

    // 冲突泳道
    const laneC = document.getElementById('tlConflictLane');
    laneC.innerHTML = '';
    for (const cf of App.conflicts) {
      for (const [s, e] of cf.segs) {
        const seg = document.createElement('div');
        seg.className = 'tl-conflict-seg';
        seg.style.left = `${this.widthFor(s)}px`;
        seg.style.width = `${this.widthFor(Math.max(0.3, e - s))}px`;
        seg.title = `${cf.a.name} × ${cf.b.name}：${cf.desc}（${s}s–${e}s）`;
        seg.dataset.t = s;
        seg.addEventListener('click', () => { App.currentTime = s; ui.syncPlayhead(); ui.renderStage(); });
        laneC.appendChild(seg);
      }
    }
    this.updatePlayhead();
  },
  updatePlayhead() {
    document.getElementById('playhead').style.left =
      `${118 + this.widthFor(App.currentTime)}px`;
  },
  bind() {
    const tracks = document.getElementById('tlTracks');
    let drag = null;
    tracks.addEventListener('pointerdown', (e) => {
      const block = e.target.closest('.cue-block');
      if (!block) {
        this.seekFromEvent(e);
        drag = { seek: true };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', endDrag);
        return;
      }
      e.preventDefault();
      const cueId = block.dataset.cueId;
      App.selectedCueId = cueId;
      const resize = e.target.classList.contains('handle');
      drag = { cueId, resize, startX: e.clientX };
      this.render();
      ui.renderInspector();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', endDrag);
    });
    const onMove = (e) => {
      if (!drag) return;
      if (drag.seek) { this.seekFromEvent(e); return; }
      const dx = e.clientX - drag.startX;
      const dt = round1(dx / App.pxPerSec);
      if (!('base' in drag)) {
        const cue = App.cueById(drag.cueId);
        drag.base = { start: cue.start, total: Core.cueEnd(cue) - Core.cueStartOn(cue) };
      }
      if (dt === drag.lastDt) return;
      drag.lastDt = dt;
      if (drag.resize) {
        resizeCue(App, drag.cueId, drag.base.total + dt);
      } else {
        moveCue(App, drag.cueId, drag.base.start + dt);
      }
      App.recompute();
    };
    const endDrag = () => {
      if (drag && drag.cueId) ui.renderInspector();
      drag = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', endDrag);
    };
  },
  seekFromEvent(e) {
    const rect = document.getElementById('tlRuler').getBoundingClientRect();
    const t = clamp(round1((e.clientX - rect.left) / App.pxPerSec), 0, App.horizon);
    App.currentTime = t;
    ui.syncPlayhead(); ui.renderStage(); ui.updateLivePositions();
  },
};

/* ============================================================
 * 回放 / 执行 / 场记
 * ============================================================ */
const Playback = {
  raf: 0, lastTs: 0,
  start() {
    if (App.playing) return;
    App.playing = true;
    this.lastTs = performance.now();
    ui.setPlayLabel('⏸ 暂停预演');
    const tick = (ts) => {
      if (!App.playing) return;
      const dt = (ts - this.lastTs) / 1000 * App.playRate;
      this.lastTs = ts;
      App.currentTime = round1(App.currentTime + dt);
      if (App.currentTime >= App.horizon) {
        App.currentTime = App.horizon;
        this.stop(true);
        toast('转场预演结束', 'ok');
      }
      ui.syncPlayhead(); ui.renderStage(); ui.updateLivePositions();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },
  toggle() { App.playing ? this.stop(false) : this.start(); },
  stop(finished) {
    App.playing = false;
    cancelAnimationFrame(this.raf);
    ui.setPlayLabel('▶ 预演');
    if (!finished) {
      toast(`排练已中断，播放头停在 ${App.currentTime.toFixed(1)}s，可从最近场记点恢复`, '');
    }
    App.save();
  },
  /* 执行：存在任意冲突片段则阻止 */
  execute() {
    if (App.conflicts.length) {
      const c0 = App.conflicts[0];
      ui.showBanner(
        `⛔ 已阻止执行：检测到 ${App.conflicts.length} 组冲突，最早片段 ${c0.segs[0][0].toFixed(1)}s ` +
        `（${c0.a.name} × ${c0.b.name}）。已定位到冲突泳道。`, 'blocked');
      App.currentTime = c0.segs[0][0];
      ui.syncPlayhead(); ui.renderStage();
      ui.switchTab('conflicts');
      const seg = document.querySelector('.tl-conflict-seg');
      if (seg) seg.scrollIntoView({ block: 'nearest', inline: 'center' });
      toast('安全联锁：冲突未解除前禁止执行', 'err');
      return;
    }
    ui.showBanner('✅ 安全检查通过，已下发执行指令（演示模式：等同预演）', 'ready');
    App.currentTime = 0;
    this.start();
  },
};

function addMark(label) {
  const existing = App.marks.find((m) => Math.abs(m.time - App.currentTime) < 0.3);
  if (existing) { toast('该时刻附近已有场记点', 'err'); return; }
  const cueNames = App.cues
    .filter((c) => App.currentTime >= c.start && App.currentTime <= Core.cueEnd(c))
    .map((c) => App.unitById(c.unitId).name);
  App.marks.push({
    id: 'm' + Date.now(), time: round1(App.currentTime),
    label: label || `场记 ${App.marks.length + 1}`,
    cues: cueNames, confirmedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  });
  App.marks.sort((a, b) => a.time - b.time);
  App.save();
  ui.renderMarks();
  toast(`已确认场记点 @${App.currentTime.toFixed(1)}s`, 'ok');
}
function resumeLatestMark() {
  let m = [...App.marks].reverse().find((x) => x.time <= App.currentTime + 0.01) || App.marks[0];
  if (!m) { toast('尚无场记点，无法恢复', 'err'); return; }
  Playback.stop(false);
  App.currentTime = m.time;
  ui.syncPlayhead(); ui.renderStage();
  toast(`已恢复到场记点「${m.label}」@${m.time.toFixed(1)}s`, 'ok');
  Playback.start();
}

/* ============================================================
 * 版本快照
 * ============================================================ */
function snapshotVersion(name) {
  const tmp = detectConflicts(App.units, App.cues, App.horizon);
  return {
    id: 'v' + Date.now(),
    name: name || `版本 ${App.versions.length + 1}`,
    savedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    units: deepClone(App.units), cues: deepClone(App.cues),
    horizon: App.horizon,
    riskCount: tmp.length,
    riskTime: round1(tmp.reduce((s, c) => s + c.segs.reduce((a, [x, y]) => a + y - x, 0), 0)),
  };
}
function saveVersion(name) {
  App.versions.push(snapshotVersion(name));
  App.save();
  ui.renderVersions();
  toast(`已保存「${App.versions[App.versions.length - 1].name}」`, 'ok');
}

/* ============================================================
 * UI 控制器
 * ============================================================ */
function toast(msg, kind) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + (kind || '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

const ui = {
  stage: null, cmpA: null, cmpB: null,
  init() {
    this.stage = new StageView(document.getElementById('stageCanvas'), () => ({
      units: App.units, cues: App.cues, time: App.currentTime,
      conflicts: App.conflicts, marks: App.marks,
    }));
    Timeline.init(document.getElementById('timeline'));
    this.bind();
    this.renderLegend();
  },
  renderLegend() {
    const items = [
      ['var(--lift)', '升降台'], ['var(--turn)', '旋转台'],
      ['var(--batten)', '吊杆'], ['var(--actor)', '演员'],
      ['var(--danger)', '冲突/危险区'],
    ];
    document.getElementById('stageLegend').innerHTML =
      items.map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('');
  },
  bind() {
    document.getElementById('btnPlay').addEventListener('click', () => Playback.toggle());
    document.getElementById('btnStop').addEventListener('click', () => Playback.stop(false));
    document.getElementById('btnExecute').addEventListener('click', () => Playback.execute());
    document.getElementById('btnMark').addEventListener('click', () => addMark());
    document.getElementById('btnResume').addEventListener('click', resumeLatestMark);
    document.getElementById('btnPause').addEventListener('click', () => {
      const cue = this.cueForPause();
      if (!cue) { toast('请先在时间轴选择一个动作，或将播放头移到动作区间内', 'err'); return; }
      const unit = App.unitById(cue.unitId);
      const ev = Core.evalCueAt(unit, cue, App.currentTime);
      const at = ev ? ev.eff : 0;
      insertPause(App, cue.id, at, 2);
      App.recompute();
      toast(`已在「${unit.name}」插入 2s 停顿，后续动作自动顺延`, 'ok');
    });
    document.getElementById('playRate').addEventListener('change', (e) => {
      App.playRate = parseFloat(e.target.value);
    });
    document.getElementById('btnZoomIn').addEventListener('click', () => this.setZoom(App.pxPerSec * 1.3));
    document.getElementById('btnZoomOut').addEventListener('click', () => this.setZoom(App.pxPerSec / 1.3));
    document.getElementById('btnZoomFit').addEventListener('click', () => this.setZoom(14));

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });
    document.getElementById('btnCloseCompare').addEventListener('click', () => this.closeCompare());

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); Playback.toggle(); }
      if (e.code === 'KeyM') addMark();
      if (e.code === 'Delete' && App.selectedCueId) {
        deleteCue(App, App.selectedCueId);
        App.selectedCueId = null;
        App.recompute();
      }
    });
  },
  cueForPause() {
    if (App.selectedCueId) return App.cueById(App.selectedCueId);
    const byUnit = App.cuesByUnit();
    for (const u of App.units) {
      const hit = Core.cueActive(u, byUnit[u.id] || [], App.currentTime);
      if (hit) return hit.cue;
    }
    return null;
  },
  setZoom(v) {
    App.pxPerSec = clamp(v, 4, 60);
    Timeline.render();
  },
  switchTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-pane').forEach((p) =>
      p.classList.toggle('active', p.id === 'tab-' + name));
  },
  showBanner(msg, kind) {
    const b = document.getElementById('banner');
    b.textContent = msg;
    b.className = 'banner ' + kind;
  },
  setPlayLabel(txt) { document.getElementById('btnPlay').textContent = txt; },
  syncPlayhead() {
    Timeline.updatePlayhead();
    document.getElementById('clockNow').textContent = App.currentTime.toFixed(1);
    document.getElementById('clockEnd').textContent = App.horizon;
  },
  renderStage() {
    this.stage.draw();
    this.updateLivePositions();
    const live = conflictsAtTime(App.conflicts, App.currentTime);
    const box = document.getElementById('liveStatus');
    const chips = [];
    const states = this.stage._states || {};
    for (const u of App.units) {
      const st = states[u.id];
      if (!st) continue;
      const busy = st.active || (u.type !== 'actor' && Math.abs(st.value - u.rest) > 0.05);
      if (busy) chips.push(`<span class="chip">${u.name} <b>${valueText(u, st)}</b>${st.paused ? ' ⏸' : ''}</span>`);
    }
    box.innerHTML = chips.join('');
    if (live.length && !this._liveWarned) {
      this._liveWarned = true;
      toast(`当前时刻存在 ${live.length} 组实时冲突`, 'err');
    }
    if (!live.length) this._liveWarned = false;
  },
  updateLivePositions() {
    document.querySelectorAll('[data-pos]').forEach((el) => {
      const id = el.dataset.pos;
      const byUnit = App.cuesByUnit();
      const st = Core.unitState(App.units, byUnit, id, App.currentTime);
      el.textContent = valueText(st.unit, st);
    });
  },
  renderAll() {
    Timeline.render();
    this.syncPlayhead();
    this.renderStage();
    this.renderConflicts();
    this.renderMarks();
    this.renderVersions();
    this.renderInspector();
    if (!App.conflicts.length) {
      this.showBanner('✅ 全部转场动作通过安全校验，可以执行', 'ready');
    } else {
      this.showBanner(`⛔ 检测到 ${App.conflicts.length} 组冲突，执行已被安全联锁阻止`, 'blocked');
    }
  },
};

/* ---------------- 侧栏面板 ---------------- */
Object.assign(ui, {
  renderConflicts() {
    const pane = document.getElementById('tab-conflicts');
    const badge = document.getElementById('badgeConf');
    const n = App.conflicts.length;
    badge.textContent = n;
    badge.classList.toggle('hidden', n === 0);
    if (!n) {
      pane.innerHTML = '<div class="empty-hint ok">✓ 机械路径无交叉，安全距离与演员离场条件全部满足。</div>';
      return;
    }
    pane.innerHTML = App.conflicts.map((cf, i) => {
      const segTxt = cf.segs.map(([s, e]) => `${s.toFixed(1)}–${e.toFixed(1)}s`).join('，');
      return `<div class="conf-item" data-go="${cf.segs[0][0]}">
        <div class="ci-head">
          <span class="ci-type">${cf.a.name} × ${cf.b.name}</span>
          <span class="ci-time">${segTxt}</span>
        </div>
        <div class="ci-desc">${cf.desc}</div>
        <div class="ci-go">点击定位到冲突片段 →</div>
      </div>`;
    }).join('');
    pane.querySelectorAll('.conf-item').forEach((el) => {
      el.addEventListener('click', () => {
        App.currentTime = parseFloat(el.dataset.go);
        ui.syncPlayhead(); ui.renderStage();
        document.getElementById('timelineScroll').scrollLeft =
          App.pxPerSec * App.currentTime - 120;
      });
    });
  },
  renderMarks() {
    const pane = document.getElementById('tab-marks');
    if (!App.marks.length) {
      pane.innerHTML = '<div class="empty-hint">暂无场记点。播放到关键时刻点击「🚩 确认场记点」（快捷键 M）。</div>';
      return;
    }
    pane.innerHTML = App.marks.map((m) => `
      <div class="mark-item">
        <div class="mi-top"><span class="mi-time">🚩 ${m.label} · ${m.time.toFixed(1)}s</span></div>
        <div class="mi-meta">${m.confirmedAt} 确认${m.cues.length ? '｜进行中：' + m.cues.join('、') : ''}</div>
        <div class="mark-actions">
          <button data-act="go" data-id="${m.id}">定位</button>
          <button data-act="resume" data-id="${m.id}">从此恢复预演</button>
          <button data-act="del" data-id="${m.id}">删除</button>
        </div>
      </div>`).join('');
    pane.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        const m = App.marks.find((x) => x.id === b.dataset.id);
        if (b.dataset.act === 'go') { App.currentTime = m.time; ui.syncPlayhead(); ui.renderStage(); }
        if (b.dataset.act === 'resume') {
          Playback.stop(false); App.currentTime = m.time;
          ui.syncPlayhead(); ui.renderStage(); Playback.start();
        }
        if (b.dataset.act === 'del') {
          App.marks = App.marks.filter((x) => x.id !== m.id);
          App.save(); ui.renderMarks();
        }
      });
    });
  },
  renderVersions() {
    const pane = document.getElementById('tab-versions');
    let html = `<div style="margin-bottom:8px"><button id="btnSaveVer" class="primary">📸 保存当前为新版本</button></div>`;
    const cur = { riskCount: App.conflicts.length,
      riskTime: round1(App.conflicts.reduce((s, c) => s + c.segs.reduce((a, [x, y]) => a + y - x, 0), 0)) };
    html += `<div class="ver-item current">
      <div class="vi-top"><span class="vi-name">● 当前工作版</span></div>
      <div class="vi-meta">时长 ${App.horizon}s</div>
      <div class="ver-risk ${cur.riskCount ? 'bad' : 'good'}">
        ${cur.riskCount ? `⚠ ${cur.riskCount} 组冲突 / 累计 ${cur.riskTime}s 风险窗口` : '✓ 零冲突'}</div>
    </div>`;
    html += App.versions.map((v) => `
      <div class="ver-item">
        <div class="vi-top"><span class="vi-name">${v.name}</span></div>
        <div class="vi-meta">${v.savedAt} ｜ 时长 ${v.horizon}s</div>
        <div class="ver-risk ${v.riskCount ? 'bad' : 'good'}">
          ${v.riskCount ? `⚠ ${v.riskCount} 组冲突 / 累计 ${v.riskTime}s 风险窗口` : '✓ 零冲突'}</div>
        <div class="ver-actions">
          <button data-act="cmp-cur" data-id="${v.id}">与当前并排</button>
          <button data-act="cmp2" data-id="${v.id}">选两版对比</button>
          <button data-act="load" data-id="${v.id}">载入编辑</button>
          <button data-act="del" data-id="${v.id}">删除</button>
        </div>
      </div>`).join('');
    pane.innerHTML = html || '<div class="empty-hint">尚未保存任何版本。</div>';
    document.getElementById('btnSaveVer').addEventListener('click', () => saveVersion());
    pane.querySelectorAll('.ver-actions button').forEach((b) => {
      b.addEventListener('click', () => {
        const v = App.versions.find((x) => x.id === b.dataset.id);
        if (b.dataset.act === 'cmp-cur') this.openCompare(null, v.id);
        if (b.dataset.act === 'cmp2') this.pickTwo(v.id);
        if (b.dataset.act === 'load') {
          if (confirm(`载入「${v.name}」？当前未保存的改动将被覆盖（可先保存版本）。`)) {
            App.units = deepClone(v.units); App.cues = deepClone(v.cues);
            App.currentTime = 0; App.recompute();
            toast(`已载入「${v.name}」`, 'ok');
          }
        }
        if (b.dataset.act === 'del') {
          App.versions = App.versions.filter((x) => x.id !== v.id);
          App.save(); ui.renderVersions();
        }
      });
    });
  },
  pickTwo(firstId) {
    if (this._pick === firstId) { this._pick = null; return; }
    if (this._pick) {
      const a = App.versions.find((x) => x.id === this._pick);
      const b = App.versions.find((x) => x.id === firstId);
      this._pick = null;
      this.openCompare(a.id, b.id);
    } else {
      this._pick = firstId;
      toast('已选第一版，请再点另一版的「选两版对比」', '');
    }
  },
});

/* ---------------- 检查器 ---------------- */
Object.assign(ui, {
  renderInspector() {
    const box = document.getElementById('inspector');
    const cue = App.selectedCueId ? App.cueById(App.selectedCueId) : null;
    if (!cue) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const unit = App.unitById(cue.unitId);
    const total = Core.cueEnd(cue) - Core.cueStartOn(cue);
    const fromTxt = unit.type === 'actor'
      ? `(${cue.params.from[0]},${cue.params.from[1]})`
      : unit.type === 'turn' ? `${cue._from}°` : `${cue._from.toFixed(1)}m`;
    const toTxt = unit.type === 'actor'
      ? `(${cue.params.to[0]},${cue.params.to[1]})`
      : unit.type === 'turn' ? `${cue.params.toAngle}°` : `${cue.params.to}m`;
    box.innerHTML = `
      <div class="insp-field"><span>${unit.name} · 起始时间(s)</span>
        <input id="inspStart" type="number" step="0.5" value="${cue.start}"></div>
      <div class="insp-field"><span>行程</span>
        <input value="${fromTxt} → ${toTxt}" disabled></div>
      <div class="insp-field"><span>速度 (${unit.type === 'turn' ? '°/s' : unit.type === 'actor' ? 'm/s' : 'm/s'})</span>
        <input id="inspSpeed" type="number" step="0.05" min="0.05" value="${cue.speed}"></div>
      <div class="insp-field"><span>时长(s)</span>
        <input id="inspDur" type="number" step="0.1" min="0.4" value="${round1(total)}"></div>
      <div class="insp-field"><span>临时停顿</span>
        <div class="pause-list">${cue.pauses.length ? cue.pauses.map((p, i) =>
          `<span class="pause-tag">${p.at.toFixed(1)}s +${p.dur}s<button data-i="${i}" title="删除">✕</button></span>`
        ).join('') : '<span style="color:var(--muted)">无</span>'}</div></div>
      <button id="inspPauseNow">在播放头处停顿 2s</button>
      <button id="inspPack">同机动作紧凑重排</button>
      <button id="inspDelete" class="danger">删除动作</button>`;
    document.getElementById('inspStart').addEventListener('change', (e) => {
      moveCue(App, cue.id, parseFloat(e.target.value)); App.recompute();
    });
    document.getElementById('inspSpeed').addEventListener('change', (e) => {
      cue.speed = clamp(parseFloat(e.target.value), 0.05, 99); App.recompute();
    });
    document.getElementById('inspDur').addEventListener('change', (e) => {
      resizeCue(App, cue.id, parseFloat(e.target.value)); App.recompute();
    });
    box.querySelectorAll('.pause-tag button').forEach((btn) => {
      btn.addEventListener('click', () => { removePause(App, cue.id, +btn.dataset.i); App.recompute(); });
    });
    document.getElementById('inspPauseNow').addEventListener('click', () => {
      const ev = Core.evalCueAt(unit, cue, App.currentTime);
      insertPause(App, cue.id, ev ? ev.eff : 0, 2); App.recompute();
    });
    document.getElementById('inspPack').addEventListener('click', () => { packUnit(App, cue.unitId); App.recompute(); });
    document.getElementById('inspDelete').addEventListener('click', () => {
      deleteCue(App, cue.id); App.selectedCueId = null; App.recompute();
    });
  },
});

/* ============================================================
 * 版本并排回放
 * ============================================================ */
const Compare = {
  dataA: null, dataB: null, raf: 0, lastTs: 0, time: 0, playing: false,
  open(aVer, bVer) {
    this.dataA = aVer ? this.sceneOf(aVer) : this.sceneOfCurrent('当前工作版');
    this.dataB = this.sceneOf(bVer);
    document.getElementById('comparePanel').classList.remove('hidden');
    document.getElementById('cmpNameA').textContent = this.dataA.name;
    document.getElementById('cmpNameB').textContent = this.dataB.name;
    this.viewA = new StageView(document.getElementById('cmpCanvasA'), () => ({
      units: this.dataA.units, cues: this.dataA.cues, time: this.time,
      conflicts: this.dataA.conflicts, marks: [],
    }), true);
    this.viewB = new StageView(document.getElementById('cmpCanvasB'), () => ({
      units: this.dataB.units, cues: this.dataB.cues, time: this.time,
      conflicts: this.dataB.conflicts, marks: [],
    }), true);
    this.time = 0;
    this.maxT = Math.max(this.dataA.horizon, this.dataB.horizon);
    document.getElementById('cmpStatA').innerHTML = this.riskTxt(this.dataA);
    document.getElementById('cmpStatB').innerHTML = this.riskTxt(this.dataB);
    this.renderMini();
    const dT = this.dataA.horizon - this.dataB.horizon;
    const dR = this.dataA.riskTime - this.dataB.riskTime;
    document.getElementById('compareDelta').innerHTML =
      `节奏差 <b>${dT > 0 ? '+' : ''}${dT.toFixed(1)}s</b> ｜ ` +
      `风险窗口差 <b>${dR > 0 ? '+' : ''}${dR.toFixed(1)}s</b>` +
      ` ｜ <button id="cmpPlay" class="ghost">▶ 同步回放</button> <span id="cmpClock"></span>`;
    document.getElementById('cmpPlay').addEventListener('click', () => this.toggle());
    requestAnimationFrame(() => { this.viewA.draw(); this.viewB.draw(); });
  },
  sceneOf(ver) {
    allRecalc({ units: ver.units, cues: ver.cues,
      cuesByUnit: function () { const m = {}; for (const c of this.cues) (m[c.unitId] ||= []).push(c); return m; },
      unitById(id) { return this.units.find((u) => u.id === id); } });
    return {
      name: ver.name, units: ver.units, cues: ver.cues, horizon: ver.horizon,
      conflicts: detectConflicts(ver.units, ver.cues, ver.horizon),
      riskCount: ver.riskCount, riskTime: ver.riskTime,
    };
  },
  sceneOfCurrent(name) {
    return {
      name, units: App.units, cues: App.cues, horizon: App.horizon,
      conflicts: App.conflicts,
      riskCount: App.conflicts.length,
      riskTime: round1(App.conflicts.reduce((s, c) => s + c.segs.reduce((a, [x, y]) => a + y - x, 0), 0)),
    };
  },
  riskTxt(d) {
    return d.riskCount
      ? `<span style="color:var(--danger)">⚠ ${d.riskCount} 组冲突 · ${d.riskTime}s 风险窗口 · 时长 ${d.horizon}s</span>`
      : `<span style="color:var(--ok)">✓ 零冲突 · 时长 ${d.horizon}s</span>`;
  },
  renderMini() {
    for (const [side, data] of [['A', this.dataA], ['B', this.dataB]]) {
      const host = document.getElementById('cmpTl' + side);
      host.innerHTML = '';
      const scale = host.clientWidth / (this.maxT + 2);
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;height:34px;background:#0b0f15;border:1px solid var(--line);border-radius:5px';
      for (const cue of data.cues) {
        const u = data.units.find((x) => x.id === cue.unitId);
        const s = document.createElement('div');
        s.style.cssText = `position:absolute;top:4px;height:8px;border-radius:2px;background:${TYPE_COLOR[u.type]};opacity:.85`;
        s.style.left = `${Core.cueStartOn(cue) * scale}px`;
        s.style.width = `${Math.max(2, (Core.cueEnd(cue) - Core.cueStartOn(cue)) * scale)}px`;
        wrap.appendChild(s);
      }
      for (const cf of data.conflicts) {
        for (const [s, e] of cf.segs) {
          const z = document.createElement('div');
          z.style.cssText = 'position:absolute;top:16px;height:8px;background:var(--danger);border-radius:2px';
          z.style.left = `${s * scale}px`;
          z.style.width = `${Math.max(2, (e - s) * scale)}px`;
          wrap.appendChild(z);
        }
      }
      const ph = document.createElement('div');
      ph.id = 'cmpPh' + side;
      ph.style.cssText = 'position:absolute;top:0;bottom:0;width:2px;background:#fff';
      wrap.appendChild(ph);
      host.appendChild(wrap);
      host.addEventListener('pointerdown', (e) => {
        const r = wrap.getBoundingClientRect();
        this.time = clamp((e.clientX - r.left) / scale, 0, this.maxT);
        this.pause(); this.tickView();
      });
    }
  },
  tickView() {
    this.viewA.draw(); this.viewB.draw();
    document.getElementById('cmpPhA').style.left =
      `${(this.time / (this.maxT + 2)) * document.getElementById('cmpTlA').clientWidth}px`;
    document.getElementById('cmpPhB').style.left =
      `${(this.time / (this.maxT + 2)) * document.getElementById('cmpTlB').clientWidth}px`;
    document.getElementById('cmpClock').textContent = `${this.time.toFixed(1)}s`;
  },
  toggle() { this.playing ? this.pause() : this.play(); },
  play() {
    this.playing = true;
    document.getElementById('cmpPlay').textContent = '⏸ 暂停';
    this.lastTs = performance.now();
    const step = (ts) => {
      if (!this.playing) return;
      this.time = round1(this.time + ((ts - this.lastTs) / 1000) * App.playRate);
      this.lastTs = ts;
      if (this.time >= this.maxT) { this.time = this.maxT; this.pause(); }
      this.tickView();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  },
  pause() {
    this.playing = false; cancelAnimationFrame(this.raf);
    const b = document.getElementById('cmpPlay');
    if (b) b.textContent = '▶ 同步回放';
  },
};
Object.assign(ui, {
  openCompare(aId, bId) {
    document.querySelector('.compare-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    Compare.open(aId ? App.versions.find((v) => v.id === aId) : null,
      App.versions.find((v) => v.id === bId));
  },
  closeCompare() {
    Compare.pause();
    document.getElementById('comparePanel').classList.add('hidden');
  },
});

/* ============================================================
 * 启动
 * ============================================================ */
(function boot() {
  if (typeof document === 'undefined') return;
  let loaded = false;
  if (App.load() && App.units.length) {
    loaded = true;
  } else {
    const data = initialData();
    App.units = data.units; App.cues = data.cues;
  }
  ui.init();
  App.recompute();
  if (!loaded) {
    App.marks = [{ id: 'm0', time: 0, label: '开场确认点', cues: [],
      confirmedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }) }];
    App.versions = [snapshotVersion('V1 初始编排')];
    App.currentTime = 0;
    App.save();
    ui.renderMarks(); ui.renderVersions();
  }
  ui.renderAll();
  setTimeout(() => toast('提示：红纹片段为冲突；拖动动作块改时间，拖右缘改速度，空格预演', ''), 400);
})();

if (typeof module !== 'undefined') module.exports = { Core, detectConflicts, initialData };
