import { useCallback, useEffect, useMemo, useState } from 'react';

type SensorStatus = '正常' | '注意' | '离线';
type Sensor = { id: string; name: string; code: string; value: string; unit: string; trend: string; status: SensorStatus; color: string; points: number[] };

const sensors: Sensor[] = [
  { id: 'temp', name: '山脊温度', code: 'TMP-01', value: '-8.4', unit: '°C', trend: '↓ 1.2°', status: '正常', color: '#78d7ef', points: [20, 24, 21, 31, 28, 34, 42, 38, 47, 50] },
  { id: 'wind', name: '风速 / 风向', code: 'WND-02', value: '18.6', unit: 'm/s', trend: '↑ 3.8', status: '注意', color: '#f2bc71', points: [31, 28, 38, 40, 34, 47, 45, 56, 54, 62] },
  { id: 'snow', name: '积雪深度', code: 'SNW-03', value: '142', unit: 'cm', trend: '↑ 4 cm', status: '正常', color: '#bba4ff', points: [58, 53, 52, 50, 45, 42, 38, 35, 30, 28] },
  { id: 'power', name: '电池组电量', code: 'PWR-04', value: '76', unit: '%', trend: '↓ 2%', status: '正常', color: '#94df9a', points: [72, 70, 76, 72, 70, 76, 80, 79, 78, 76] }
];

const alerts = [
  { time: '09:42', title: '风速超过巡检阈值', desc: '当前 18.6 m/s · 建议延后无人机巡检', kind: 'warning' },
  { time: '08:15', title: '雪深传感器完成自检', desc: 'SNW-03 数据质量 99.2%', kind: 'good' },
  { time: '06:30', title: '卫星链路已同步', desc: '上行延迟 2.4 秒 · 下一次同步 12:30', kind: 'good' }
];

// ---------- 自检与校准 ----------
type CheckItemState = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
type SessionState = 'running' | 'awaiting-confirmation' | 'confirmed' | 'failed' | 'discarded';
type CheckItem = { key: string; label: string; state: CheckItemState; detail: string };
type SelfCheckSession = {
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
};
type CheckResult = 'passed' | 'failed' | 'running' | 'awaiting' | 'discarded';
type LastSelfCheck = { id: string; state: SessionState; result: CheckResult; finishedAt: string | null };
type SensorMeta = { code: string; quality: number; status: SensorStatus; activeSelfCheck: boolean; lastSelfCheck: LastSelfCheck | null };

const itemStateLabel: Record<CheckItemState, string> = { pending: '等待', running: '检测中…', passed: '通过', failed: '未通过', skipped: '已跳过' };
const sessionStateLabel: Record<SessionState, string> = { running: '自检进行中', 'awaiting-confirmation': '待值守员确认', confirmed: '已确认应用', failed: '自检未通过', discarded: '结果已放弃' };
const checkResultLabel: Record<CheckResult, string> = { passed: '自检通过', failed: '自检未通过', running: '自检中', awaiting: '待确认', discarded: '已放弃' };

function formatTime(value: string | number | null) {
  if (value === null) return '—';
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function MiniChart({ points, color }: { points: number[]; color: string }) {
  const coords = points.map((p, index) => `${(index / (points.length - 1)) * 100},${70 - p}`).join(' ');
  return <svg className="mini-chart" viewBox="0 0 100 70" preserveAspectRatio="none"><defs><linearGradient id={`fill-${color.replace('#', '')}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".28" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs><polygon points={`0,70 ${coords} 100,70`} fill={`url(#fill-${color.replace('#', '')})`} /><polyline points={coords} fill="none" stroke={color} strokeWidth="1.7" vectorEffect="non-scaling-stroke" /></svg>;
}

function MountainScene() {
  return <div className="mountain-scene"><div className="stars" /><div className="sun-glow" /><div className="mountain back" /><div className="mountain mid" /><div className="mountain front" /><div className="station"><span className="mast" /><span className="station-box" /><span className="antenna" /></div><div className="scene-caption"><span>海拔 4,820 m</span><span>自动观测站 · M-07</span></div></div>;
}

export default function App() {
  const [selectedId, setSelectedId] = useState('wind');
  const [range, setRange] = useState('24 小时');
  const [notice, setNotice] = useState('');
  const [metas, setMetas] = useState<Record<string, SensorMeta>>({});
  const [session, setSession] = useState<SelfCheckSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const selected = sensors.find(sensor => sensor.id === selectedId) ?? sensors[0];
  const meta = metas[selected.code] ?? null;
  const selectedStatus = meta?.status ?? selected.status;

  const statusOf = useCallback((sensor: Sensor) => metas[sensor.code]?.status ?? sensor.status, [metas]);
  const summary = useMemo(() => ({
    normal: sensors.filter(s => statusOf(s) === '正常').length,
    attention: sensors.filter(s => statusOf(s) === '注意').length
  }), [statusOf]);

  const loadSensors = useCallback(async () => {
    try {
      const res = await fetch('/api/sensors');
      const data = await res.json();
      const map: Record<string, SensorMeta> = {};
      for (const item of data.sensors as SensorMeta[]) map[item.code] = item;
      setMetas(map);
    } catch {
      // API 不可用时保留页面静态数据
    }
  }, []);

  useEffect(() => { loadSensors(); }, [loadSensors]);

  // 切换传感器时载入该设备最近一次自检会话（会话保存在服务端，不随页面切换丢失）
  useEffect(() => {
    let cancelled = false;
    setSession(null);
    fetch(`/api/sensors/${selected.code}/self-checks/latest`)
      .then(res => res.json())
      .then(data => { if (!cancelled) setSession((data.session as SelfCheckSession | null) ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selected.code]);

  // 自检进行中轮询会话进度
  useEffect(() => {
    if (!session || session.state !== 'running') return;
    const timer = setInterval(() => {
      fetch(`/api/self-checks/${session.id}`)
        .then(async res => {
          if (res.status === 404) { setSession(null); return; }
          const data = await res.json();
          const next = data.session as SelfCheckSession | undefined;
          if (next) {
            setSession(next);
            if (next.state !== 'running') loadSensors();
          }
        })
        .catch(() => {});
    }, 500);
    return () => clearInterval(timer);
  }, [session?.id, session?.state, loadSensors]);

  const startSelfCheck = async () => {
    setStarting(true);
    try {
      const res = await fetch(`/api/sensors/${selected.code}/self-checks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operator: '陈（值守员）' })
      });
      const data = await res.json();
      if (data.session) setSession(data.session as SelfCheckSession);
      setNotice(res.ok ? `已启动 ${selected.name} 自检与校准` : (data.message ?? '无法启动自检'));
      loadSensors();
    } catch {
      setNotice('自检服务暂不可用，请稍后重试');
    } finally {
      setStarting(false);
    }
  };

  const confirmSession = async () => {
    if (!session) return;
    setConfirming(true);
    try {
      const res = await fetch(`/api/self-checks/${session.id}/confirm`, { method: 'POST' });
      const data = await res.json();
      if (data.session) setSession(data.session as SelfCheckSession);
      if (res.ok) {
        const outcome = data.session?.outcome;
        setNotice(outcome ? `已确认应用：${selected.name} 质量评分 ${outcome.qualityAfter.toFixed(1)}，设备状态 ${outcome.statusAfter}` : '已确认应用自检结果');
      } else {
        setNotice(data.message ?? '确认失败');
      }
      loadSensors();
    } catch {
      setNotice('确认请求失败，请稍后重试');
    } finally {
      setConfirming(false);
    }
  };

  const discardSession = async () => {
    if (!session) return;
    setConfirming(true);
    try {
      const res = await fetch(`/api/self-checks/${session.id}/discard`, { method: 'POST' });
      const data = await res.json();
      if (data.session) setSession(data.session as SelfCheckSession);
      setNotice(res.ok ? '已放弃本次校准结果，原始数据保留不变' : (data.message ?? '操作失败'));
      loadSensors();
    } catch {
      setNotice('请求失败，请稍后重试');
    } finally {
      setConfirming(false);
    }
  };

  const sessionActive = session?.state === 'running' || session?.state === 'awaiting-confirmation';
  const startLabel = session?.state === 'running' ? '自检进行中…' : session?.state === 'awaiting-confirmation' ? '待确认上次自检结果' : '▶ 开始自检与校准';

  return <div className="dashboard">
    <header className="topbar">
      <div className="brand">
        <div className="brand-icon">✦</div>
        <div>
          <span className="eyebrow">ALPINE OBSERVATORY / M-07</span>
          <h1>雪线气象站 · 运行总览</h1>
        </div>
      </div>
      <div className="top-meta">
        <span className="sync"><i />数据已同步 · 2026.09.25 10:04</span>
        <button onClick={() => setNotice('已请求最新卫星数据同步')}>↻ 刷新数据</button>
        <div className="profile">陈 <span>值守员</span></div>
      </div>
    </header>
    <main className="main">
      <section className="status-strip">
        <div>
          <span className="eyebrow">STATION STATUS</span>
          <h2>高海拔自动气象观测站</h2>
          <p>北麓冰川保护区 · 当前气象窗口良好</p>
        </div>
        <div className="status-numbers">
          <div><strong className="cyan">{summary.normal}</strong><span>传感器正常</span></div>
          <div><strong className="amber">{summary.attention}</strong><span>需要关注</span></div>
          <div><strong>2.4s</strong><span>链路延迟</span></div>
        </div>
      </section>
      <section className="overview-grid">
        <div className="mountain-card">
          <div className="card-title">
            <div><span className="eyebrow">LIVE TERRAIN</span><h3>站点环境</h3></div>
            <span className="live"><i /> LIVE</span>
          </div>
          <MountainScene />
          <div className="terrain-footer">
            <div><span>体感温度</span><b>-14.2°C</b></div>
            <div><span>能见度</span><b>16.8 km</b></div>
            <div><span>气压</span><b>582 hPa</b></div>
            <div><span>降雪</span><b>0.8 mm/h</b></div>
          </div>
        </div>
        <div className="alert-card">
          <div className="card-title">
            <div><span className="eyebrow">OPERATION LOG</span><h3>观测动态</h3></div>
            <button className="more" onClick={() => setNotice('已打开全部运行日志')}>全部 →</button>
          </div>
          <div className="alerts">
            {alerts.map(alert => <div className="alert" key={alert.time}><span className={`alert-mark ${alert.kind}`}>{alert.kind === 'warning' ? '!' : '✓'}</span><div><div className="alert-line"><b>{alert.title}</b><time>{alert.time}</time></div><p>{alert.desc}</p></div></div>)}
          </div>
          <button className="log-btn" onClick={() => setNotice('已创建巡检任务草稿')}>＋ 创建巡检任务</button>
        </div>
      </section>
      <section className="sensor-section">
        <div className="section-title">
          <div><span className="eyebrow">SENSOR ARRAY / 04</span><h3>传感器阵列</h3></div>
          <div className="range-switch">{['6 小时', '24 小时', '7 天'].map(item => <button key={item} className={range === item ? 'active' : ''} onClick={() => setRange(item)}>{item}</button>)}</div>
        </div>
        <div className="sensor-grid">
          {sensors.map(sensor => {
            const sensorMeta = metas[sensor.code] ?? null;
            const status = sensorMeta?.status ?? sensor.status;
            const lastCheck = sensorMeta?.lastSelfCheck ?? null;
            return <button key={sensor.id} className={selectedId === sensor.id ? 'sensor-card selected' : 'sensor-card'} onClick={() => setSelectedId(sensor.id)}>
              <div className="sensor-top">
                <div><span className="sensor-code">{sensor.code}</span><h4>{sensor.name}</h4></div>
                <span className={`sensor-status ${status === '注意' ? 'warn' : ''}`}><i />{status}</span>
              </div>
              <div className="sensor-reading"><strong>{sensor.value}</strong><span>{sensor.unit}</span><em className={sensor.trend.startsWith('↓') ? 'down' : ''}>{sensor.trend}</em></div>
              <MiniChart points={sensor.points} color={sensor.color} />
              <div className="sensor-meta">
                <span>质量 {sensorMeta ? sensorMeta.quality.toFixed(1) : '—'}</span>
                <span className={`last-check ${lastCheck?.result ?? ''}`}>{lastCheck ? checkResultLabel[lastCheck.result] : '未自检'}</span>
              </div>
              <div className="sensor-time">过去 {range} <span>点击查看详情</span></div>
            </button>;
          })}
        </div>
      </section>
      <section className="detail-section">
        <div className="detail-copy">
          <span className="eyebrow">SELECTED SENSOR / {selected.code}</span>
          <h3>{selected.name}历史曲线</h3>
          <p>基于自动校准后的连续观测数据，当前设备状态为 <b>{selectedStatus}</b>。</p>
          <div className="detail-tags">
            <span>采样间隔 10 min</span>
            <span>质量评分 {meta ? meta.quality.toFixed(1) : '—'}</span>
            <span>海拔 4,820 m</span>
          </div>
        </div>
        <div className="big-chart">
          <div className="chart-y"><span>20</span><span>10</span><span>0</span><span>-10</span></div>
          <svg viewBox="0 0 520 150" preserveAspectRatio="none"><path d="M0 92 L58 78 L110 83 L168 58 L220 66 L274 44 L330 57 L381 33 L438 45 L520 20" fill="none" stroke={selected.color} strokeWidth="3" /><path d="M0 92 L58 78 L110 83 L168 58 L220 66 L274 44 L330 57 L381 33 L438 45 L520 20 L520 150 L0 150 Z" fill={selected.color} opacity=".09" /></svg>
          <div className="chart-x"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>现在</span></div>
        </div>
      </section>
      <section className="check-section">
        <div className="section-title check-title">
          <div>
            <span className="eyebrow">SELF-CHECK & CALIBRATION / {selected.code}</span>
            <h3>{selected.name} · 自检与校准</h3>
          </div>
          {meta?.lastSelfCheck && <span className="last-session">最近会话 {meta.lastSelfCheck.id.slice(0, 8)} · {checkResultLabel[meta.lastSelfCheck.result]}{meta.lastSelfCheck.finishedAt ? ` · ${formatTime(meta.lastSelfCheck.finishedAt)}` : ''}</span>}
        </div>
        <div className="check-body">
          <div className="check-side">
            <div className="check-facts">
              <div><span>当前质量评分</span><b>{meta ? meta.quality.toFixed(1) : '—'}</b></div>
              <div><span>设备状态</span><b className={selectedStatus === '注意' ? 'amber' : ''}>{selectedStatus}</b></div>
              <div><span>最近自检</span><b>{meta?.lastSelfCheck ? checkResultLabel[meta.lastSelfCheck.result] : '未运行'}</b></div>
            </div>
            <button className="check-start" disabled={starting || sessionActive} onClick={startSelfCheck}>{starting ? '正在启动…' : startLabel}</button>
            <p className="check-hint">自检通过后，需值守员确认才会更新质量评分与设备状态；自检未通过或放弃结果时保留原始数据。同一传感器同一时间仅允许一个自检会话。</p>
          </div>
          <div className="check-main">
            {!session && <div className="check-empty">尚未运行自检。值守员发现读数异常时，可在此发起设备自检与校准，逐项查看检查结果。</div>}
            {session && <div className="session">
              <div className="session-head">
                <span className="session-id">会话 {session.id.slice(0, 8)}</span>
                <span className={`session-state ${session.state}`}>{sessionStateLabel[session.state]}</span>
                <span className="session-time">{formatTime(session.startedAt)} 开始 · 操作人 {session.operator}</span>
              </div>
              <div className="check-items">
                {session.items.map(item => <div className={`check-item ${item.state}`} key={item.key}>
                  <i />
                  <span className="item-label">{item.label}</span>
                  <span className="item-detail">{item.detail || itemStateLabel[item.state]}</span>
                </div>)}
              </div>
              {session.state === 'failed' && <div className="check-result failed">
                <b>自检未通过：{session.failReason}</b>
                <p>原始数据已保留，质量评分与设备状态未做任何修改。请安排现场检修后重新发起自检。</p>
                <button onClick={startSelfCheck} disabled={starting}>重新自检</button>
              </div>}
              {session.state === 'awaiting-confirmation' && session.outcome && session.calibration && <div className="check-result awaiting">
                <b>自检全部通过，校准结果待值守员确认</b>
                <div className="calib-grid">
                  <div><span>零点偏移修正</span><b>{session.calibration.offsetBefore} → {session.calibration.offsetAfter}</b></div>
                  <div><span>漂移修正</span><b>{session.calibration.drift}%</b></div>
                  <div><span>质量评分</span><b>{session.outcome.qualityBefore.toFixed(1)} → {session.outcome.qualityAfter.toFixed(1)}</b></div>
                  <div><span>设备状态</span><b>{session.outcome.statusBefore} → {session.outcome.statusAfter}</b></div>
                </div>
                <div className="confirm-actions">
                  <button className="confirm" onClick={confirmSession} disabled={confirming}>✓ 确认应用结果</button>
                  <button className="discard" onClick={discardSession} disabled={confirming}>放弃</button>
                </div>
                <p className="check-hint">点击「确认应用结果」后才会更新质量评分与设备状态；放弃则保留原始数据。</p>
              </div>}
              {session.state === 'confirmed' && session.outcome && <div className="check-result confirmed">
                <b>校准结果已应用</b>
                <p>质量评分 {session.outcome.qualityBefore.toFixed(1)} → {session.outcome.qualityAfter.toFixed(1)} · 设备状态 {session.outcome.statusBefore} → {session.outcome.statusAfter}</p>
                <p>{formatTime(session.confirmedAt)} 由 {session.operator} 确认。</p>
              </div>}
              {session.state === 'discarded' && <div className="check-result discarded">
                <b>校准结果已放弃</b>
                <p>本次自检与校准结果未应用，传感器保留原始数据。</p>
              </div>}
            </div>}
          </div>
        </div>
      </section>
      {notice && <div className="toast" onClick={() => setNotice('')}>{notice}<span>×</span></div>}
    </main>
  </div>;
}
