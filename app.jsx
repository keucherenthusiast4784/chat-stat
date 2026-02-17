const { useMemo, useState } = React;
const {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  BarChart,
  Bar,
  Brush,
} = Recharts;

const BOT_PATTERNS = [/^Wordle#\d+$/i, /^Wordle$/i, /^Meta AI$/i, /^dyno$/i, /^MEE6$/i];
const WA_HEADER = /^\[(\d{1,2}\/\d{1,2}\/\d{4}),\s+(\d{1,2}:\d{2}:\d{2})\s*([ap]m)\]\s+([^:]+):\s*(.*)$/i;
const DISC_HEADER = /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2})\s*([AP]M)\s+-\s+([^:]+):\s*(.*)$/;

const normalizeText = (s) => s.replace(/\u202f/g, ' ').replace(/\u200e|\u200f|\ufeff/g, '').replace(/\r/g, '');
const formatDate = (d) => d.toISOString().slice(0, 10);

const parseDateTime = (datePart, timePart, ampm) => {
  const [d, m, y] = datePart.split('/').map(Number);
  let [h, min, sec = 0] = timePart.split(':').map(Number);
  const low = ampm.toLowerCase();
  if (low === 'pm' && h !== 12) h += 12;
  if (low === 'am' && h === 12) h = 0;
  return new Date(y, m - 1, d, h, min, sec);
};

const parseWhatsApp = (text) => {
  const lines = normalizeText(text).split('\n');
  const msgs = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(WA_HEADER);
    if (m) {
      if (current) msgs.push(current);
      const [, datePart, timePart, ampm, sender, content] = m;
      current = { dt: parseDateTime(datePart, timePart, ampm), sender: sender.trim(), text: content || '', source: 'whatsapp' };
    } else if (current) current.text += `\n${line}`;
  }
  if (current) msgs.push(current);
  return msgs;
};

const parseDiscord = (text) => {
  const lines = normalizeText(text).split('\n');
  const msgs = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(DISC_HEADER);
    if (m) {
      if (current) msgs.push(current);
      const [, datePart, timePart, ampm, sender, content] = m;
      current = { dt: parseDateTime(datePart, timePart, ampm), sender: sender.trim(), text: content || '', source: 'discord' };
    } else if (current) current.text += `\n${line}`;
  }
  if (current) msgs.push(current);
  return msgs;
};

function App() {
  const [rawMessages, setRawMessages] = useState([]);
  const [nameMap, setNameMap] = useState({});
  const [excluded, setExcluded] = useState({});
  const [includeBots, setIncludeBots] = useState(false);
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [gapMinutes, setGapMinutes] = useState(30);
  const [topN, setTopN] = useState(5);
  const [sessionMinMsgs, setSessionMinMsgs] = useState(1);
  const [sessionKeyword, setSessionKeyword] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState(null);

  const detectedNames = useMemo(() => [...new Set(rawMessages.map((m) => m.sender))].sort((a, b) => a.localeCompare(b)), [rawMessages]);

  const handleUpload = async (e, parser) => {
    const files = [...(e.target.files || [])];
    const parsed = [];
    for (const file of files) parsed.push(...parser(await file.text()));
    setRawMessages((prev) => [...prev, ...parsed].sort((a, b) => a.dt - b.dt));
  };

  const mappedMessages = useMemo(() => rawMessages
    .map((m) => {
      const canonical = nameMap[m.sender]?.trim() || m.sender;
      return { ...m, sender: canonical, isBot: BOT_PATTERNS.some((p) => p.test(canonical)) };
    })
    .filter((m) => !excluded[m.sender])
    .filter((m) => includeBots || !m.isBot)
    .filter((m) => {
      const d = formatDate(m.dt);
      if (dateStart && d < dateStart) return false;
      if (dateEnd && d > dateEnd) return false;
      return true;
    }), [rawMessages, nameMap, excluded, includeBots, dateStart, dateEnd]);

  const dailyData = useMemo(() => {
    const map = new Map();
    for (const m of mappedMessages) {
      const day = formatDate(m.dt);
      if (!map.has(day)) map.set(day, { date: day, total: 0 });
      const row = map.get(day);
      row[m.sender] = (row[m.sender] || 0) + 1;
      row.total += 1;
    }
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [mappedMessages]);

  const hourData = useMemo(() => {
    const arr = Array.from({ length: 24 }, (_, h) => ({ hour: `${h}:00`, count: 0 }));
    for (const m of mappedMessages) arr[m.dt.getHours()].count += 1;
    return arr;
  }, [mappedMessages]);

  const topUsers = useMemo(() => Object.entries(mappedMessages.reduce((acc, m) => {
    acc[m.sender] = (acc[m.sender] || 0) + 1;
    return acc;
  }, {})).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, topN), [mappedMessages, topN]);

  const sessions = useMemo(() => {
    if (!mappedMessages.length) return [];
    const sorted = [...mappedMessages].sort((a, b) => a.dt - b.dt);
    const gapMs = gapMinutes * 60000;
    const out = [];
    let cur = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].dt - sorted[i - 1].dt >= gapMs) {
        out.push(cur);
        cur = [sorted[i]];
      } else cur.push(sorted[i]);
    }
    out.push(cur);
    return out.map((msgs, idx) => {
      const start = msgs[0].dt;
      const end = msgs[msgs.length - 1].dt;
      const byUser = {};
      let joinedText = '';
      msgs.forEach((m) => {
        byUser[m.sender] = (byUser[m.sender] || 0) + 1;
        joinedText += ` ${m.text}`;
      });
      const dominant = Object.entries(byUser).sort((a, b) => b[1] - a[1])[0] || ['n/a', 0];
      return {
        id: idx, start, end, msgs, byUser, joinedText,
        count: msgs.length,
        durationMin: Math.max(1, Math.round((end - start) / 60000)),
        dominant: dominant[0], dominantPct: Math.round((dominant[1] / msgs.length) * 100),
      };
    }).filter((s) => s.count >= sessionMinMsgs)
      .filter((s) => !sessionKeyword.trim() || s.joinedText.toLowerCase().includes(sessionKeyword.toLowerCase()));
  }, [mappedMessages, gapMinutes, sessionMinMsgs, sessionKeyword]);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);
  const participantKeys = [...new Set(mappedMessages.map((m) => m.sender))];
  const colors = ['#2563eb', '#16a34a', '#9333ea', '#ea580c', '#dc2626', '#0891b2'];

  return <div className="page">
    <h1>Chat Stats Analyzer (React)</h1>

    <section className="card">
      <h2>1) Upload chats</h2>
      <label>WhatsApp .txt files <input type="file" accept=".txt" multiple onChange={(e) => handleUpload(e, parseWhatsApp)} /></label>
      <label>Discord .txt files <input type="file" accept=".txt" multiple onChange={(e) => handleUpload(e, parseDiscord)} /></label>
      <p>Loaded messages: {rawMessages.length}</p>
    </section>

    <section className="card">
      <h2>2) Participants (map, merge, exclude)</h2>
      <div className="grid">
        {detectedNames.map((name) => <div key={name} className="nameRow">
          <strong>{name}</strong>
          <input value={nameMap[name] || ''} placeholder="Canonical name" onChange={(e) => setNameMap((p) => ({ ...p, [name]: e.target.value }))} />
          <label><input type="checkbox" checked={!!excluded[nameMap[name] || name]} onChange={(e) => setExcluded((p) => ({ ...p, [nameMap[name] || name]: e.target.checked }))} />Exclude</label>
        </div>)}
      </div>
    </section>

    <section className="card controls">
      <h2>3) Controls</h2>
      <label>Start <input type="date" value={dateStart} onChange={(e) => setDateStart(e.target.value)} /></label>
      <label>End <input type="date" value={dateEnd} onChange={(e) => setDateEnd(e.target.value)} /></label>
      <label>Session gap {gapMinutes} min <input type="range" min="10" max="120" value={gapMinutes} onChange={(e) => setGapMinutes(Number(e.target.value))} /></label>
      <label>Top N {topN} <input type="range" min="3" max="50" value={topN} onChange={(e) => setTopN(Number(e.target.value))} /></label>
      <label>Session min messages <input type="number" min="1" value={sessionMinMsgs} onChange={(e) => setSessionMinMsgs(Number(e.target.value) || 1)} /></label>
      <label>Session keyword <input value={sessionKeyword} onChange={(e) => setSessionKeyword(e.target.value)} /></label>
      <label><input type="checkbox" checked={includeBots} onChange={(e) => setIncludeBots(e.target.checked)} /> Include bots</label>
    </section>

    <section className="card">
      <h2>Daily messages (brush to zoom range)</h2>
      <div className="chartWrap"><ResponsiveContainer width="100%" height={340}><LineChart data={dailyData}>
        <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" /><YAxis /><Tooltip /><Legend />
        <Line type="monotone" dataKey="total" stroke="#111827" strokeWidth={2} dot={false} />
        {participantKeys.map((k, i) => <Line key={k} type="monotone" dataKey={k} stroke={colors[i % colors.length]} dot={false} />)}
        <Brush dataKey="date" height={25} travellerWidth={10} />
      </LineChart></ResponsiveContainer></div>
    </section>

    <section className="card split">
      <div><h2>Top users</h2><div className="chartWrap small"><ResponsiveContainer width="100%" height={280}><BarChart data={topUsers}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" /><YAxis /><Tooltip /><Bar dataKey="count" fill="#2563eb" /></BarChart></ResponsiveContainer></div></div>
      <div><h2>Hour distribution</h2><div className="chartWrap small"><ResponsiveContainer width="100%" height={280}><BarChart data={hourData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="hour" /><YAxis /><Tooltip /><Bar dataKey="count" fill="#16a34a" /></BarChart></ResponsiveContainer></div></div>
    </section>

    <section className="card">
      <h2>4) Session explorer</h2>
      <p>Total sessions: {sessions.length}</p>
      <div className="sessionList">{sessions.map((s) => <button key={s.id} className="sessionBtn" onClick={() => setSelectedSessionId(s.id)}><strong>{s.start.toLocaleString()}</strong> → {s.end.toLocaleTimeString()} | {s.count} msgs | {s.durationMin} min | dominant: {s.dominant} ({s.dominantPct}%)</button>)}</div>
      {selectedSession && <div className="drilldown">
        <h3>Session detail</h3>
        <p>{selectedSession.start.toLocaleString()} to {selectedSession.end.toLocaleString()} · {selectedSession.count} messages · {selectedSession.durationMin} minutes</p>
        <ul>{Object.entries(selectedSession.byUser).map(([u, c]) => <li key={u}>{u}: {c}</li>)}</ul>
        <div className="msgs">{selectedSession.msgs.map((m, i) => <p key={`${m.sender}-${i}`}><b>[{m.dt.toLocaleString()}] {m.sender}:</b> {m.text}</p>)}</div>
      </div>}
    </section>
  </div>;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
