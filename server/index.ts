import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';

const app = express();
const port = Number(process.env.PORT || 4002);
app.use(cors());
app.use(express.json());

const readings = [
  { sensor: 'TMP-01', value: -8.4, unit: '°C' },
  { sensor: 'WND-02', value: 18.6, unit: 'm/s' },
  { sensor: 'SNW-03', value: 142, unit: 'cm' },
  { sensor: 'PWR-04', value: 76, unit: '%' }
];

app.get('/api/health', (_req, res) => res.json({ status: 'ok', project: 'snow-mountain-weather-station', workflow: '采集传感器数据 → 校验质量 → 触发告警 → 同步观测记录' }));
app.get('/api/readings', (_req, res) => res.json(readings));
app.post('/api/sync', (_req, res) => res.json({ status: 'accepted', syncedAt: new Date().toISOString() }));

// ---------- 传感器自检与校准 ----------
type SensorStatus = '正常' | '注意' | '离线';
type CheckItemState = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
type SessionState = 'running' | 'awaiting-confirmation' | 'confirmed' | 'failed' | 'discarded';

interface CheckItem {
  key: string;
  label: string;
  state: CheckItemState;
  detail: string;
}

interface SelfCheckSession {
  id: string;
  sensorCode: string;
  state: SessionState;
  startedAt: number;
  finishedAt: string | null;
  confirmedAt: string | null;
  operator: string;
  items: CheckItem[];
  calibration: { offsetBefore: number; offsetAfter: number; drift: number } | null;
  outcome: { qualityBefore: number; qualityAfter: number; statusBefore: SensorStatus; statusAfter: SensorStatus } | null;
  failReason: string | null;
}

// 设备质量评分与状态以服务端为准，只有自检通过且值守员确认后才会被更新
const sensorState: Record<string, { quality: number; status: SensorStatus }> = {
  'TMP-01': { quality: 98.1, status: '正常' },
  'WND-02': { quality: 87.3, status: '注意' },
  'SNW-03': { quality: 99.2, status: '正常' },
  'PWR-04': { quality: 96.5, status: '正常' }
};

const CHECK_ITEMS = [
  { key: 'power', label: '供电电压检测', passDetail: '电压 12.4 V · 正常' },
  { key: 'link', label: '通信链路检测', passDetail: '链路延迟 2.4 s · 正常' },
  { key: 'probe', label: '探头响应检测', passDetail: '响应 118 ms · 正常' },
  { key: 'storage', label: '存储完整性校验', passDetail: '校验一致 · 正常' }
];
const ITEM_MS = 1200;
const CALIBRATION_MS = 1500;

// 模拟硬件档案：漂移/偏移量与故障点（WND-02 探头响应异常，与读数异常表现一致）
const hardwareProfiles: Record<string, { drift: number; offset: number; qualityAfter?: number; failItem?: string; failDetail?: string }> = {
  'TMP-01': { drift: 0.6, offset: -0.3, qualityAfter: 99.4 },
  'WND-02': { drift: 2.1, offset: 1.8, failItem: 'probe', failDetail: '探头响应超时（> 800 ms），疑似风杯轴承卡滞' },
  'SNW-03': { drift: 0.2, offset: 0.4, qualityAfter: 99.6 },
  'PWR-04': { drift: 0.9, offset: -1.2, qualityAfter: 98.9 }
};

const sessions = new Map<string, SelfCheckSession>();

// 按耗时推进运行中的会话：逐项检测 → 全部通过后计算校准结果，等待值守员确认
function refreshSession(session: SelfCheckSession) {
  if (session.state !== 'running') return;
  const profile = hardwareProfiles[session.sensorCode];
  const elapsed = Date.now() - session.startedAt;
  let failed = false;
  session.items.forEach((item, index) => {
    const start = index * ITEM_MS;
    const end = start + ITEM_MS;
    if (failed) { item.state = 'skipped'; return; }
    if (elapsed < start) { item.state = 'pending'; return; }
    if (elapsed < end) { item.state = 'running'; return; }
    if (profile?.failItem === item.key) {
      item.state = 'failed';
      item.detail = profile.failDetail ?? '检测未通过';
      failed = true;
    } else {
      item.state = 'passed';
      item.detail = CHECK_ITEMS[index].passDetail;
    }
  });
  if (failed) {
    // 自检失败：会话标记失败，质量评分与设备状态保持原样
    session.state = 'failed';
    session.failReason = profile?.failDetail ?? '自检未通过';
    session.finishedAt = new Date().toISOString();
    return;
  }
  if (elapsed >= CHECK_ITEMS.length * ITEM_MS + CALIBRATION_MS) {
    const current = sensorState[session.sensorCode];
    session.state = 'awaiting-confirmation';
    session.finishedAt = new Date().toISOString();
    session.calibration = { offsetBefore: profile?.offset ?? 0, offsetAfter: 0, drift: profile?.drift ?? 0 };
    session.outcome = {
      qualityBefore: current.quality,
      qualityAfter: profile?.qualityAfter ?? current.quality,
      statusBefore: current.status,
      statusAfter: '正常'
    };
  }
}

function sessionResult(session: SelfCheckSession) {
  switch (session.state) {
    case 'confirmed': return 'passed';
    case 'failed': return 'failed';
    case 'running': return 'running';
    case 'awaiting-confirmation': return 'awaiting';
    default: return 'discarded';
  }
}

function sensorSessions(code: string) {
  return [...sessions.values()].filter(s => s.sensorCode === code).sort((a, b) => b.startedAt - a.startedAt);
}

function serializeSensor(code: string) {
  const state = sensorState[code];
  const list = sensorSessions(code);
  const active = list.find(s => s.state === 'running' || s.state === 'awaiting-confirmation');
  const last = list[0] ?? null;
  return {
    code,
    quality: state.quality,
    status: state.status,
    activeSelfCheck: Boolean(active),
    lastSelfCheck: last ? { id: last.id, state: last.state, result: sessionResult(last), finishedAt: last.finishedAt } : null
  };
}

app.get('/api/sensors', (_req, res) => {
  sessions.forEach(refreshSession);
  res.json({ sensors: Object.keys(sensorState).map(serializeSensor) });
});

// 发起自检：同一传感器已有进行中或待确认的会话时拒绝，避免重复自检
app.post('/api/sensors/:code/self-checks', (req, res) => {
  const code = req.params.code;
  if (!sensorState[code]) return res.status(404).json({ error: 'SENSOR_NOT_FOUND', message: '未知传感器' });
  sessions.forEach(refreshSession);
  const active = sensorSessions(code).find(s => s.state === 'running' || s.state === 'awaiting-confirmation');
  if (active) {
    return res.status(409).json({
      error: 'SELF_CHECK_ACTIVE',
      message: active.state === 'running' ? '该传感器自检正在进行中，不能重复发起' : '该传感器有待确认的自检结果，请先确认或放弃',
      session: active
    });
  }
  const session: SelfCheckSession = {
    id: randomUUID(),
    sensorCode: code,
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    confirmedAt: null,
    operator: typeof req.body?.operator === 'string' && req.body.operator ? req.body.operator : '陈（值守员）',
    items: CHECK_ITEMS.map(item => ({ key: item.key, label: item.label, state: 'pending' as CheckItemState, detail: '' })),
    calibration: null,
    outcome: null,
    failReason: null
  };
  sessions.set(session.id, session);
  res.status(201).json({ session });
});

// 该传感器最近一次自检会话（切换传感器后仍可查看，会话保存在服务端）
app.get('/api/sensors/:code/self-checks/latest', (req, res) => {
  const code = req.params.code;
  if (!sensorState[code]) return res.status(404).json({ error: 'SENSOR_NOT_FOUND', message: '未知传感器' });
  sessions.forEach(refreshSession);
  res.json({ session: sensorSessions(code)[0] ?? null });
});

app.get('/api/self-checks/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: '会话不存在' });
  refreshSession(session);
  res.json({ session });
});

// 值守员确认：仅自检通过（待确认）时才更新质量评分与设备状态
app.post('/api/self-checks/:id/confirm', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: '会话不存在' });
  refreshSession(session);
  if (session.state === 'failed') {
    return res.status(409).json({ error: 'SELF_CHECK_FAILED', message: '自检未通过，已保留原始数据', session });
  }
  if (session.state !== 'awaiting-confirmation') {
    return res.status(409).json({ error: 'NOT_AWAITING_CONFIRMATION', message: '当前会话不在待确认状态', session });
  }
  const target = sensorState[session.sensorCode];
  if (session.outcome) {
    target.quality = session.outcome.qualityAfter;
    target.status = session.outcome.statusAfter;
  }
  session.state = 'confirmed';
  session.confirmedAt = new Date().toISOString();
  if (typeof req.body?.operator === 'string' && req.body.operator) session.operator = req.body.operator;
  res.json({ session, sensor: serializeSensor(session.sensorCode) });
});

// 放弃校准结果：保留原始数据，不做任何修改
app.post('/api/self-checks/:id/discard', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: '会话不存在' });
  refreshSession(session);
  if (session.state !== 'awaiting-confirmation') {
    return res.status(409).json({ error: 'NOT_AWAITING_CONFIRMATION', message: '仅待确认的会话可以放弃', session });
  }
  session.state = 'discarded';
  res.json({ session, sensor: serializeSensor(session.sensorCode) });
});

app.listen(port, () => console.log(`Weather station API running at http://localhost:${port}`));
