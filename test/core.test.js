const test = require('node:test');
const assert = require('node:assert');
const C = require('../js/core.js');

function fresh() { return C.createState(); }
function clipsOf(s, laneId) { return C.sortedLaneClips(s.clips, laneId); }
function risk(s) { return C.riskMetrics(C.evaluate(s).conflicts); }

test('初始场次能检出演员未离场与机械交叉冲突', () => {
  const r = C.evaluate(fresh());
  assert.ok(r.conflicts.some(c => c.kind === 'actor-lift'));
  assert.ok(r.conflicts.some(c => c.kind === 'lift-turntable'));
  assert.ok(risk(fresh()).blocked);
});

test('拖动片段后同轨道后续动作整体重排（保持节奏与间隔）', () => {
  const s = fresh();
  const before = clipsOf(s, 'liftB');
  const first = before[0];
  const gapBefore = before[1].start - first.end;
  const firstBefore = first.start;
  C.moveClip(s, first.id, first.start + 4);(s, first.id, first.start + 4);
  const after = clipsOf(s, 'liftB');
  assert.strictEqual(after[0].start, firstBefore + 4);
  assert.strictEqual(after[0].end - after[0].start, first.end - first.start);
  assert.strictEqual(after[1].start - after[0].end, gapBefore);
});

test('拖动不能越过前一片段（保留安全间隔）', () => {
  const s = fresh();
  const cs = clipsOf(s, 'actorA');
  C.moveClip(s, cs[1].id, 0);
  const after = clipsOf(s, 'actorA');
  assert.ok(after[1].start >= after[0].end + C.GAP - 1e-6);
});

test('改右边缘等价改速度，紧邻动作被推到安全间隔，其后跟随', () => {
  const s = fresh();
  const cs = clipsOf(s, 'liftB');
  C.resizeEnd(s, cs[0].id, cs[0].end + 2);
  let after = clipsOf(s, 'liftB');
  assert.strictEqual(after[0].end, 38);
  assert.strictEqual(after[1].start, 40); // 原有 2s 间隔被保留，不压缩
  // 继续拉长到与后续动作相撞，则后续被整体顶开
  C.resizeEnd(s, after[0].id, 44);
  after = clipsOf(s, 'liftB');
  assert.strictEqual(after[0].end, 44);
  assert.strictEqual(after[1].start, 44.5);
  assert.strictEqual(after[1].end, 50.5);
});

test('插入临时停顿：切分片段、中间保持、后续顺延', () => {
  const s = fresh();
  const c = clipsOf(s, 'turntable')[0];
  const oldEnd = c.end;
  const hold = C.insertPause(s, c.id, c.start + 3, 2);
  assert.ok(hold);
  const after = clipsOf(s, 'turntable');
  assert.strictEqual(after.length, 3);
  assert.strictEqual(after[0].end, after[1].start);
  assert.strictEqual(after[1].end, after[2].start);
  assert.strictEqual(after[1].end - after[1].start, 2);
  assert.strictEqual(after[2].end, oldEnd + 2);
  assert.strictEqual(after[2].level, 180);
  const def = s.lanes.find(l => l.id === 'turntable');
  const v1 = C.laneStateAt(def, after, c.start + 3.2).value;
  const v2 = C.laneStateAt(def, after, c.start + 4.8).value;
  assert.ok(Math.abs(v1 - v2) < 1e-9);
});

test('把冲突动作推迟到演员离场后，冲突消失', () => {
  const s = fresh();
  const first = clipsOf(s, 'liftB')[0];
  C.moveClip(s, first.id, 44);
  const r = C.evaluate(s);
  assert.ok(!r.conflicts.some(c => c.lanes.includes('liftB') && c.kind === 'actor-lift'));
});

test('场记点：新增排序，恢复时取最近确认点', () => {
  const s = fresh();
  C.addCue(s, 10, '灯光就位');
  C.addCue(s, 25, '二幕准备');
  C.addCue(s, 5, '开场');
  assert.deepStrictEqual(s.cues.map(q => q.t), [5, 10, 25]);
  assert.strictEqual(C.lastCueAtOrBefore(s, 22).t, 10);
  assert.strictEqual(C.lastCueAtOrBefore(s, 4), null);
  assert.strictEqual(C.lastCueAtOrBefore(s, 100).t, 25);
});

test('版本克隆互不影响，diff 能发现时长变化', () => {
  const a = fresh();
  const b = C.cloneState(a, 'v2');
  const c = clipsOf(b, 'liftB')[0];
  C.moveClip(b, c.id, c.start + 5);
  const d = C.diffStates(a, b);
  assert.ok(d.some(x => x.laneId === 'liftB' && x.delta === 5));
  assert.strictEqual(clipsOf(a, 'liftB')[0].start, 30);
});
