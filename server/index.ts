import express from 'express';
import cors from 'cors';
const app = express();
const port = Number(process.env.PORT || 4002);
app.use(cors()); app.use(express.json());
const readings = [{ sensor: 'TMP-01', value: -8.4, unit: '°C' }, { sensor: 'WND-02', value: 18.6, unit: 'm/s' }, { sensor: 'SNW-03', value: 142, unit: 'cm' }, { sensor: 'PWR-04', value: 76, unit: '%' }];

type DeviceStatus = '正常' | '注意' | '离线';
type SensorState = { id: string; code: string; name: string; quality: number; status: DeviceStatus; calibratedAt: string | null };
// 质量评分与设备状态由服务端持有，校准确认后才会被更新
const sensors: SensorState[] = [
  { id: 'temp', code: 'TMP-01', name: '山脊温度', quality: 98.6, status: '正常', calibratedAt: null },
  { id: 'wind', code: 'WND-02', name: '风速 / 风向', quality: 91.3, status: '注意', calibratedAt: null },
  { id: 'snow', code: 'SNW-03', name: '积雪深度', quality: 99.2, status: '正常', calibratedAt: null },
  { id: 'power', code: 'PWR-04', name: '电池组电量', quality: 96.8, status: '正常', calibratedAt: null }
];

type StepStatus = 'pending' | 'running' | 'pass' | 'fail';
type CheckStep = { key: string; label: string; status: StepStatus; detail: string | null };
type SessionState = 'running' | 'passed' | 'failed' | 'confirmed';
type SelfCheckResult = { qualityBefore: number; qualityAfter: number; statusBefore: DeviceStatus; statusAfter: DeviceStatus; drift: number; failedStep: string | null };
type SelfCheckSession = { id: string; sensorId: string; sensorCode: string; state: SessionState; steps: CheckStep[]; startedAt: string; finishedAt: string | null; confirmedAt: string | null; result: SelfCheckResult | null };

const STEP_DEFS = [
  { key: 'power', label: '供电与功耗检测' },
  { key: 'link', label: '通信链路检测' },
  { key: 'drift', label: '零点漂移检测' },
  { key: 'calibration', label: '校准写入与回读' }
];
const STEP_DURATION_MS = 1200;
const sessions = new Map<string, SelfCheckSession>();
let sessionSeq = 0;
const round1 = (n: number) => Math.round(n * 10) / 10;

function stepDetail(key: string, passed: boolean) {
  const details: Record<string, [string, string]> = {
    power: ['电压 12.4V · 功耗正常', '供电电压低于阈值'],
    link: ['链路延迟 2.4s · 丢包 0%', '链路超时 · 丢包率过高'],
    drift: ['零点漂移在容差内', '零点漂移超出容差'],
    calibration: ['校准系数写入并回读一致', '校准回读校验不一致']
  };
  return details[key][passed ? 0 : 1];
}

function runSession(session: SelfCheckSession, sensor: SensorState) {
  let index = 0;
  const advance = () => {
    const step = session.steps[index];
    if (!step) {
      session.state = 'passed';
      session.finishedAt = new Date().toISOString();
      session.result = {
        qualityBefore: sensor.quality,
        qualityAfter: Math.min(99.9, round1(sensor.quality + 3 + Math.random() * 4)),
        statusBefore: sensor.status,
        statusAfter: '正常',
        drift: round1(0.1 + Math.random() * 0.8),
        failedStep: null
      };
      return;
    }
    step.status = 'running';
    setTimeout(() => {
      const passed = Math.random() < 0.9;
      step.status = passed ? 'pass' : 'fail';
      step.detail = stepDetail(step.key, passed);
      if (!passed) {
        // 自检失败：只记录会话，质量评分与设备状态保持原值
        session.state = 'failed';
        session.finishedAt = new Date().toISOString();
        session.result = { qualityBefore: sensor.quality, qualityAfter: sensor.quality, statusBefore: sensor.status, statusAfter: sensor.status, drift: 0, failedStep: step.label };
        return;
      }
      index += 1;
      advance();
    }, STEP_DURATION_MS);
  };
  advance();
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok', project: 'snow-mountain-weather-station', workflow: '采集传感器数据 → 校验质量 → 自检校准 → 触发告警 → 同步观测记录' }));
app.get('/api/readings', (_req, res) => res.json(readings));
app.get('/api/sensors', (_req, res) => res.json(sensors));

app.post('/api/sensors/:id/self-checks', (req, res) => {
  const sensor = sensors.find(s => s.id === req.params.id);
  if (!sensor) return res.status(404).json({ error: '传感器不存在' });
  const running = [...sessions.values()].find(s => s.sensorId === sensor.id && s.state === 'running');
  if (running) return res.status(409).json({ error: '该传感器已有运行中的自检，请等待完成', session: running });
  sessionSeq += 1;
  const session: SelfCheckSession = {
    id: `SC-${String(sessionSeq).padStart(4, '0')}`,
    sensorId: sensor.id,
    sensorCode: sensor.code,
    state: 'running',
    steps: STEP_DEFS.map(def => ({ ...def, status: 'pending' as StepStatus, detail: null })),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    confirmedAt: null,
    result: null
  };
  sessions.set(session.id, session);
  runSession(session, sensor);
  res.status(201).json(session);
});

app.get('/api/sensors/:id/self-checks', (req, res) => {
  const list = [...sessions.values()].filter(s => s.sensorId === req.params.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  res.json(list);
});

app.get('/api/self-checks/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: '自检会话不存在' });
  res.json(session);
});

app.post('/api/self-checks/:id/confirm', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: '自检会话不存在' });
  if (session.state === 'running') return res.status(409).json({ error: '自检仍在运行，无法确认' });
  if (session.state === 'failed') return res.status(409).json({ error: '自检未通过，已保留原始质量与设备状态' });
  if (session.state === 'confirmed') return res.status(409).json({ error: '该校准结果已确认过' });
  const sensor = sensors.find(s => s.id === session.sensorId);
  if (!sensor || !session.result) return res.status(500).json({ error: '会话数据异常' });
  // 值守员确认后才更新质量评分与设备状态
  sensor.quality = session.result.qualityAfter;
  sensor.status = session.result.statusAfter;
  sensor.calibratedAt = new Date().toISOString();
  session.state = 'confirmed';
  session.confirmedAt = sensor.calibratedAt;
  res.json({ session, sensor });
});

app.post('/api/sync', (_req, res) => res.json({ status: 'accepted', syncedAt: new Date().toISOString() }));
app.listen(port, () => console.log(`Weather station API running at http://localhost:${port}`));
