import { useCallback, useEffect, useState } from 'react';

type DeviceStatus = '正常' | '注意' | '离线';
type Sensor = { id: string; name: string; code: string; value: string; unit: string; trend: string; status: DeviceStatus; color: string; points: number[] };
type ServerSensor = { id: string; code: string; name: string; quality: number; status: DeviceStatus; calibratedAt: string | null };
type CheckStep = { key: string; label: string; status: 'pending' | 'running' | 'pass' | 'fail'; detail: string | null };
type SelfCheckSession = {
  id: string; sensorId: string; sensorCode: string;
  state: 'running' | 'passed' | 'failed' | 'confirmed';
  steps: CheckStep[]; startedAt: string; finishedAt: string | null; confirmedAt: string | null;
  result: { qualityBefore: number; qualityAfter: number; statusBefore: DeviceStatus; statusAfter: DeviceStatus; drift: number; failedStep: string | null } | null;
};
type AlertEntry = { time: string; title: string; desc: string; kind: string };

const sensors: Sensor[] = [
  { id: 'temp', name: '山脊温度', code: 'TMP-01', value: '-8.4', unit: '°C', trend: '↓ 1.2°', status: '正常', color: '#78d7ef', points: [20, 24, 21, 31, 28, 34, 42, 38, 47, 50] },
  { id: 'wind', name: '风速 / 风向', code: 'WND-02', value: '18.6', unit: 'm/s', trend: '↑ 3.8', status: '注意', color: '#f2bc71', points: [31, 28, 38, 40, 34, 47, 45, 56, 54, 62] },
  { id: 'snow', name: '积雪深度', code: 'SNW-03', value: '142', unit: 'cm', trend: '↑ 4 cm', status: '正常', color: '#bba4ff', points: [58, 53, 52, 50, 45, 42, 38, 35, 30, 28] },
  { id: 'power', name: '电池组电量', code: 'PWR-04', value: '76', unit: '%', trend: '↓ 2%', status: '正常', color: '#94df9a', points: [72, 70, 76, 72, 70, 76, 80, 79, 78, 76] }
];
const fallbackQuality: Record<string, number> = { temp: 98.6, wind: 91.3, snow: 99.2, power: 96.8 };
const initialAlerts: AlertEntry[] = [{ time: '09:42', title: '风速超过巡检阈值', desc: '当前 18.6 m/s · 建议延后无人机巡检', kind: 'warning' }, { time: '08:15', title: '雪深传感器完成自检', desc: 'SNW-03 数据质量 99.2%', kind: 'good' }, { time: '06:30', title: '卫星链路已同步', desc: '上行延迟 2.4 秒 · 下一次同步 12:30', kind: 'good' }];

const sessionStateLabel: Record<SelfCheckSession['state'], string> = { running: '运行中', passed: '待确认', failed: '未通过', confirmed: '已应用' };
const stepIcon: Record<CheckStep['status'], string> = { pending: '○', running: '◌', pass: '✓', fail: '✕' };
const fmtTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

class ApiError extends Error { constructor(public status: number, public data: any, message: string) { super(message); } }
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data, data.error || `请求失败 (${res.status})`);
  return data as T;
}

function MiniChart({ points, color }: { points: number[]; color: string }) { const coords = points.map((p, index) => `${(index / (points.length - 1)) * 100},${70 - p}`).join(' '); return <svg className="mini-chart" viewBox="0 0 100 70" preserveAspectRatio="none"><defs><linearGradient id={`fill-${color.replace('#','')}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".28"/><stop offset="1" stopColor={color} stopOpacity="0"/></linearGradient></defs><polygon points={`0,70 ${coords} 100,70`} fill={`url(#fill-${color.replace('#','')})`} /><polyline points={coords} fill="none" stroke={color} strokeWidth="1.7" vectorEffect="non-scaling-stroke" /></svg>; }
function MountainScene() { return <div className="mountain-scene"><div className="stars"/><div className="sun-glow"/><div className="mountain back"/><div className="mountain mid"/><div className="mountain front"/><div className="station"><span className="mast"/><span className="station-box"/><span className="antenna"/></div><div className="scene-caption"><span>海拔 4,820 m</span><span>自动观测站 · M-07</span></div></div>; }

export default function App() {
  const [selectedId, setSelectedId] = useState('wind');
  const [range, setRange] = useState('24 小时');
  const [notice, setNotice] = useState('');
  const [serverSensors, setServerSensors] = useState<Record<string, ServerSensor>>({});
  const [sessions, setSessions] = useState<SelfCheckSession[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [alertLog, setAlertLog] = useState<AlertEntry[]>(initialAlerts);

  const merged = sensors.map(s => ({ ...s, status: serverSensors[s.id]?.status ?? s.status, quality: serverSensors[s.id]?.quality ?? fallbackQuality[s.id], calibratedAt: serverSensors[s.id]?.calibratedAt ?? null }));
  const selected = merged.find(sensor => sensor.id === selectedId) ?? merged[0];
  const summary = { normal: merged.filter(s => s.status === '正常').length, attention: merged.filter(s => s.status === '注意').length };
  const runningSession = sessions.find(s => s.state === 'running');
  const activeSession = sessions.find(s => s.id === focusId) ?? runningSession ?? sessions.find(s => s.state === 'passed') ?? null;

  const pushLog = useCallback((entry: Omit<AlertEntry, 'time'>) => setAlertLog(prev => [{ time: nowTime(), ...entry }, ...prev].slice(0, 6)), []);

  useEffect(() => {
    api<ServerSensor[]>('/api/sensors').then(list => setServerSensors(Object.fromEntries(list.map(s => [s.id, s])))).catch(() => {});
  }, []);

  useEffect(() => {
    setSessions([]);
    setFocusId(null);
    api<SelfCheckSession[]>(`/api/sensors/${selectedId}/self-checks`).then(setSessions).catch(() => {});
  }, [selectedId]);

  // 自检运行期间轮询会话进度，结束后提示结果
  useEffect(() => {
    if (!runningSession) return;
    const timer = setInterval(() => {
      api<SelfCheckSession>(`/api/self-checks/${runningSession.id}`).then(fresh => {
        setSessions(prev => prev.some(s => s.id === fresh.id) ? prev.map(s => s.id === fresh.id ? fresh : s) : [fresh, ...prev]);
        if (fresh.state === 'passed') setNotice(`${fresh.sensorCode} 自检通过，待值守员确认应用校准结果`);
        if (fresh.state === 'failed') {
          setNotice(`${fresh.sensorCode} 自检未通过，已保留原始质量与设备状态`);
          pushLog({ title: '传感器自检未通过', desc: `${fresh.sensorCode} ${fresh.result?.failedStep ?? ''} · 原始数据已保留`, kind: 'warning' });
        }
      }).catch(() => {});
    }, 900);
    return () => clearInterval(timer);
  }, [runningSession?.id, pushLog]);

  const startCheck = async () => {
    if (starting || runningSession) return;
    setStarting(true);
    try {
      const session = await api<SelfCheckSession>(`/api/sensors/${selectedId}/self-checks`, { method: 'POST' });
      setSessions(prev => [session, ...prev]);
      setFocusId(session.id);
      setNotice(`已启动 ${selected.code} 自检与校准`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data?.session) {
        setSessions(prev => prev.some(s => s.id === err.data.session.id) ? prev : [err.data.session, ...prev]);
        setFocusId(err.data.session.id);
      }
      setNotice(err instanceof Error ? err.message : '自检启动失败');
    } finally {
      setStarting(false);
    }
  };

  const confirmSession = async (id: string) => {
    try {
      const { session, sensor } = await api<{ session: SelfCheckSession; sensor: ServerSensor }>(`/api/self-checks/${id}/confirm`, { method: 'POST' });
      setSessions(prev => prev.map(s => s.id === session.id ? session : s));
      setServerSensors(prev => ({ ...prev, [sensor.id]: sensor }));
      setFocusId(session.id);
      setNotice(`${session.sensorCode} 校准结果已应用 · 质量评分 ${session.result?.qualityBefore} → ${session.result?.qualityAfter}`);
      pushLog({ title: '校准结果已应用', desc: `${session.sensorCode} 质量评分 ${session.result?.qualityBefore} → ${session.result?.qualityAfter} · 设备状态 ${session.result?.statusAfter}`, kind: 'good' });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '确认失败');
    }
  };

  return <div className="dashboard"><header className="topbar"><div className="brand"><div className="brand-icon">✦</div><div><span className="eyebrow">ALPINE OBSERVATORY / M-07</span><h1>雪线气象站 · 运行总览</h1></div></div><div className="top-meta"><span className="sync"><i/>数据已同步 · 2026.09.25 10:04</span><button onClick={() => setNotice('已请求最新卫星数据同步')}>↻ 刷新数据</button><div className="profile">陈 <span>值守员</span></div></div></header><main className="main"><section className="status-strip"><div><span className="eyebrow">STATION STATUS</span><h2>高海拔自动气象观测站</h2><p>北麓冰川保护区 · 当前气象窗口良好</p></div><div className="status-numbers"><div><strong className="cyan">{summary.normal}</strong><span>传感器正常</span></div><div><strong className="amber">{summary.attention}</strong><span>需要关注</span></div><div><strong>2.4s</strong><span>链路延迟</span></div></div></section><section className="overview-grid"><div className="mountain-card"><div className="card-title"><div><span className="eyebrow">LIVE TERRAIN</span><h3>站点环境</h3></div><span className="live"><i/> LIVE</span></div><MountainScene/><div className="terrain-footer"><div><span>体感温度</span><b>-14.2°C</b></div><div><span>能见度</span><b>16.8 km</b></div><div><span>气压</span><b>582 hPa</b></div><div><span>降雪</span><b>0.8 mm/h</b></div></div></div><div className="alert-card"><div className="card-title"><div><span className="eyebrow">OPERATION LOG</span><h3>观测动态</h3></div><button className="more" onClick={() => setNotice('已打开全部运行日志')}>全部 →</button></div><div className="alerts">{alertLog.map(alert => <div className="alert" key={`${alert.time}-${alert.title}`}><span className={`alert-mark ${alert.kind}`}>{alert.kind === 'warning' ? '!' : '✓'}</span><div><div className="alert-line"><b>{alert.title}</b><time>{alert.time}</time></div><p>{alert.desc}</p></div></div>)}</div><button className="log-btn" onClick={() => setNotice('已创建巡检任务草稿')}>＋ 创建巡检任务</button></div></section><section className="sensor-section"><div className="section-title"><div><span className="eyebrow">SENSOR ARRAY / 04</span><h3>传感器阵列</h3></div><div className="range-switch">{['6 小时','24 小时','7 天'].map(item => <button key={item} className={range === item ? 'active' : ''} onClick={() => setRange(item)}>{item}</button>)}</div></div><div className="sensor-grid">{merged.map(sensor => <button key={sensor.id} className={selectedId === sensor.id ? 'sensor-card selected' : 'sensor-card'} onClick={() => setSelectedId(sensor.id)}><div className="sensor-top"><div><span className="sensor-code">{sensor.code}</span><h4>{sensor.name}</h4></div><span className={`sensor-status ${sensor.status === '注意' ? 'warn' : ''}`}><i/>{sensor.status}</span></div><div className="sensor-reading"><strong>{sensor.value}</strong><span>{sensor.unit}</span><em className={sensor.trend.startsWith('↓') ? 'down' : ''}>{sensor.trend}</em></div><MiniChart points={sensor.points} color={sensor.color}/><div className="sensor-time">过去 {range} <span>质量 {sensor.quality.toFixed(1)} · 详情</span></div></button>)}</div></section><section className="detail-section"><div className="detail-copy"><span className="eyebrow">SELECTED SENSOR / {selected.code}</span><h3>{selected.name}历史曲线</h3><p>基于自动校准后的连续观测数据，当前设备状态为 <b>{selected.status}</b>。</p><div className="detail-tags"><span>采样间隔 10 min</span><span>质量评分 {selected.quality.toFixed(1)}</span><span>海拔 4,820 m</span>{selected.calibratedAt && <span>校准于 {fmtTime(selected.calibratedAt)}</span>}</div></div><div className="big-chart"><div className="chart-y"><span>20</span><span>10</span><span>0</span><span>-10</span></div><svg viewBox="0 0 520 150" preserveAspectRatio="none"><path d="M0 92 L58 78 L110 83 L168 58 L220 66 L274 44 L330 57 L381 33 L438 45 L520 20" fill="none" stroke={selected.color} strokeWidth="3"/><path d="M0 92 L58 78 L110 83 L168 58 L220 66 L274 44 L330 57 L381 33 L438 45 L520 20 L520 150 L0 150 Z" fill={selected.color} opacity=".09"/></svg><div className="chart-x"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>现在</span></div></div><div className="check-panel"><div className="check-head"><div><span className="eyebrow">SELF-CHECK &amp; CALIBRATION</span><h4>自检与校准</h4></div><button className="check-start" disabled={starting || !!runningSession} onClick={startCheck}>{runningSession ? '自检运行中…' : '▶ 开始自检与校准'}</button></div>{activeSession ? <div className="check-body"><ol className="check-steps">{activeSession.steps.map(step => <li key={step.key} className={`step ${step.status}`}><span className="step-icon">{stepIcon[step.status]}</span><div><b>{step.label}</b><p>{step.detail ?? (step.status === 'running' ? '检测中…' : '等待检测')}</p></div></li>)}</ol>{activeSession.state === 'running' && <div className="check-progress">正在执行 {activeSession.steps.find(s => s.status === 'running')?.label ?? '准备中'} · 会话 {activeSession.id}</div>}{activeSession.state === 'passed' && activeSession.result && <div className="check-result pass"><div>自检通过 · 质量评分 <b>{activeSession.result.qualityBefore.toFixed(1)} → {activeSession.result.qualityAfter.toFixed(1)}</b> · 设备状态 {activeSession.result.statusBefore} → {activeSession.result.statusAfter} · 漂移修正 {activeSession.result.drift.toFixed(1)}</div><div className="check-actions"><span>确认后才会更新质量与设备状态</span><button onClick={() => confirmSession(activeSession.id)}>✓ 确认应用校准结果</button></div></div>}{activeSession.state === 'failed' && activeSession.result && <div className="check-result fail"><div>✕ {activeSession.result.failedStep} 未通过 · 已保留原始质量评分 {activeSession.result.qualityBefore.toFixed(1)} 与设备状态 {activeSession.result.statusBefore}</div><button className="check-retry" onClick={startCheck}>↻ 重新自检</button></div>}{activeSession.state === 'confirmed' && <div className="check-result done"><div>✓ 校准结果已应用 · 质量评分 {activeSession.result?.qualityAfter.toFixed(1)} · {activeSession.confirmedAt ? fmtTime(activeSession.confirmedAt) : ''}</div></div>}</div> : <p className="check-empty">发现读数异常时可发起设备自检与校准，校准结果需值守员确认后才会更新质量评分与设备状态。</p>}{sessions.length > 0 && <div className="check-history"><span className="eyebrow">CHECK SESSIONS / {selected.code}</span>{sessions.slice(0, 4).map(s => <div className="history-row" key={s.id}><span className={`badge ${s.state}`}>{sessionStateLabel[s.state]}</span><span>{fmtTime(s.startedAt)}</span><span className="h-desc">{s.id} · {s.state === 'failed' ? `${s.result?.failedStep} 失败` : s.result ? `质量 ${s.result.qualityBefore.toFixed(1)} → ${s.result.qualityAfter.toFixed(1)}` : '检测中…'}</span>{s.state === 'passed' && <button onClick={() => confirmSession(s.id)}>确认应用</button>}</div>)}</div>}</div></section>{notice && <div className="toast" onClick={() => setNotice('')}>{notice}<span>×</span></div>}</main></div>;
}
