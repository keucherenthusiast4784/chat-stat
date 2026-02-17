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
const DISC_INLINE_HEADER = /^\[?(\d{1,2}\/\d{1,2}\/\d{4})\]?\s+(\d{1,2}:\d{2})(?::(\d{2}))?\s*([AP]M)\s+-\s+([^:]+):\s*(.*)$/;
const DISC_BLOCK_HEADER = /^\[(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2})(?::(\d{2}))?\s*([AP]M)\]\s+(.+)$/;
const DISCORD_ATTACHMENT_BLOCKS = new Set(['{Attachments}', '{Embed}', '{Stickers}']);
const WA_ATTACHMENT_MARKERS = ['image omitted', 'sticker omitted', 'video omitted', 'gif omitted', 'audio omitted', 'document omitted'];
const SWEAR_RE = /\b(fuck|shit|bitch|cunt|asshole|nigga|wtf|stfu)\b/gi;

const normalizeText = (s) => s.replace(/\u202f/g, ' ').replace(/\u200e|\u200f|\ufeff/g, '').replace(/\r/g, '');
const formatDate = (d) => d.toISOString().slice(0, 10);
const fmtDateTime = (d) => d?.toLocaleString() || 'N/A';
const fmtDuration = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

const parseDateTime = (datePart, timePart, ampm) => {
  const [d, m, y] = datePart.split('/').map(Number);
  let [h, min, sec = 0] = timePart.split(':').map(Number);
  const low = ampm.toLowerCase();
  if (low === 'pm' && h !== 12) h += 12;
  if (low === 'am' && h === 12) h = 0;
  return new Date(y, m - 1, d, h, min, sec);
};

const isUrlOnly = (text) => {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((p) => /^https?:\/\//i.test(p));
};

const wordCount = (text) => {
  const t = text.trim().replace(/https?:\/\/\S+/gi, '');
  return (t.match(/[A-Za-z0-9']+/g) || []).length;
};

const median = (nums) => {
  if (!nums.length) return 0;
  const arr = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
};

const percentile = (vals, p) => {
  if (!vals.length) return 0;
  const arr = [...vals].sort((a, b) => a - b);
  const k = (arr.length - 1) * p;
  const f = Math.floor(k);
  const c = Math.ceil(k);
  if (f === c) return arr[k];
  return arr[f] * (c - k) + arr[c] * (k - f);
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
      const baseText = (content || '').trim();
      const norm = baseText.toLowerCase();
      const marker = WA_ATTACHMENT_MARKERS.find((k) => norm.includes(k));
      current = {
        dt: parseDateTime(datePart, timePart, ampm),
        sender: sender.trim(),
        text: marker ? '' : baseText,
        source: 'whatsapp',
        is_attachment: !!marker,
        attachment_type: marker ? marker.split(' ')[0] : null,
        is_url_only: marker ? false : isUrlOnly(baseText),
      };
    } else if (current) {
      current.text += `${current.text ? '\n' : ''}${line}`;
      current.is_url_only = isUrlOnly(current.text);
    }
  }
  if (current) msgs.push(current);
  return msgs;
};

const parseDiscord = (text) => {
  const lines = normalizeText(text).split('\n');
  const msgs = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    const inline = line.match(DISC_INLINE_HEADER);
    if (inline) {
      const [, datePart, timePart, sec = '00', ampm, sender, content] = inline;
      const msgText = (content || '').trim();
      msgs.push({
        dt: parseDateTime(datePart, `${timePart}:${sec}`, ampm),
        sender: sender.trim(),
        text: msgText,
        source: 'discord',
        is_attachment: false,
        attachment_type: null,
        is_url_only: isUrlOnly(msgText),
      });
      i += 1;
      continue;
    }

    const block = line.match(DISC_BLOCK_HEADER);
    if (!block) {
      i += 1;
      continue;
    }

    const [, datePart, timePart, sec = '00', ampm, sender] = block;
    const dt = parseDateTime(datePart, `${timePart}:${sec}`, ampm);
    i += 1;
    let attachmentType = null;
    let attachmentOnly = false;
    const body = [];

    while (i < lines.length) {
      const nxt = lines[i].trim();
      if (DISC_BLOCK_HEADER.test(nxt) || DISC_INLINE_HEADER.test(nxt)) break;

      if (DISCORD_ATTACHMENT_BLOCKS.has(nxt)) {
        attachmentOnly = true;
        attachmentType = nxt === '{Stickers}' ? 'sticker' : nxt === '{Embed}' ? 'embed' : 'attachment';
        i += 1;
        while (i < lines.length && lines[i].trim() && !DISC_BLOCK_HEADER.test(lines[i].trim()) && !DISC_INLINE_HEADER.test(lines[i].trim())) i += 1;
        continue;
      }

      if (nxt) body.push(nxt);
      i += 1;
    }

    const msgText = body.join('\n').trim();
    msgs.push({
      dt,
      sender: sender.trim(),
      text: msgText,
      source: 'discord',
      is_attachment: attachmentOnly && !msgText,
      attachment_type: attachmentOnly && !msgText ? attachmentType : null,
      is_url_only: msgText ? isUrlOnly(msgText) : false,
    });
  }

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
    setRawMessages((prev) => [...prev, ...parsed].filter((m) => !Number.isNaN(m.dt?.getTime())).sort((a, b) => a.dt - b.dt));
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

  const participantKeys = [...new Set(mappedMessages.map((m) => m.sender))];

  const dailyData = useMemo(() => {
    const map = new Map();
    for (const m of mappedMessages) {
      const day = formatDate(m.dt);
      if (!map.has(day)) map.set(day, { date: day, total: 0, text: 0, attachments: 0 });
      const row = map.get(day);
      row[m.sender] = (row[m.sender] || 0) + 1;
      row.total += 1;
      if (m.is_attachment) row.attachments += 1;
      else row.text += 1;
    }
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [mappedMessages]);

  const hourData = useMemo(() => {
    const arr = Array.from({ length: 24 }, (_, h) => ({ hour: `${h}:00`, all: 0, text: 0 }));
    for (const m of mappedMessages) {
      arr[m.dt.getHours()].all += 1;
      if (!m.is_attachment) arr[m.dt.getHours()].text += 1;
    }
    return arr;
  }, [mappedMessages]);

  const weekdayData = useMemo(() => {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const arr = names.map((name) => ({ day: name, all: 0, text: 0 }));
    for (const m of mappedMessages) {
      arr[m.dt.getDay()].all += 1;
      if (!m.is_attachment) arr[m.dt.getDay()].text += 1;
    }
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
    const grouped = [];
    let cur = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].dt - sorted[i - 1].dt >= gapMs) {
        grouped.push(cur);
        cur = [sorted[i]];
      } else cur.push(sorted[i]);
    }
    grouped.push(cur);

    return grouped.map((msgs, idx) => {
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
        id: idx,
        start,
        end,
        msgs,
        byUser,
        joinedText,
        count: msgs.length,
        textCount: msgs.filter((m) => !m.is_attachment).length,
        attachCount: msgs.filter((m) => m.is_attachment).length,
        durationMs: Math.max(0, end - start),
        durationMin: Math.max(1, Math.round((end - start) / 60000)),
        dominant: dominant[0],
        dominantPct: Math.round((dominant[1] / msgs.length) * 100),
      };
    }).filter((s) => s.count >= sessionMinMsgs)
      .filter((s) => !sessionKeyword.trim() || s.joinedText.toLowerCase().includes(sessionKeyword.toLowerCase()));
  }, [mappedMessages, gapMinutes, sessionMinMsgs, sessionKeyword]);

  const stats = useMemo(() => {
    const msgs = [...mappedMessages].sort((a, b) => a.dt - b.dt);
    if (!msgs.length) return null;

    const textMsgs = msgs.filter((m) => !m.is_attachment);
    const attachmentMsgs = msgs.filter((m) => m.is_attachment);

    const attachBreakdown = {};
    attachmentMsgs.forEach((m) => {
      const k = m.attachment_type || 'attachment';
      attachBreakdown[k] = (attachBreakdown[k] || 0) + 1;
    });

    const people = [...new Set(msgs.map((m) => m.sender))].sort();
    const perPerson = Object.fromEntries(people.map((p) => [p, {
      total: 0, text: 0, attachments: 0, url_only: 0, words: 0, chars: 0, swear: 0, emojiish: 0,
    }]));

    msgs.forEach((m) => {
      const row = perPerson[m.sender];
      row.total += 1;
      if (m.is_attachment) row.attachments += 1;
      else {
        row.text += 1;
        row.words += wordCount(m.text);
        row.chars += m.text.length;
        if (m.is_url_only) row.url_only += 1;
        row.swear += (m.text.match(SWEAR_RE) || []).length;
        row.emojiish += [...m.text].filter((ch) => ch.charCodeAt(0) > 127).length;
      }
    });

    const dailyAll = {};
    const dailyText = {};
    msgs.forEach((m) => {
      const d = formatDate(m.dt);
      dailyAll[d] = (dailyAll[d] || 0) + 1;
      if (!m.is_attachment) dailyText[d] = (dailyText[d] || 0) + 1;
    });

    const top3All = Object.entries(dailyAll).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const top3Text = Object.entries(dailyText).sort((a, b) => b[1] - a[1]).slice(0, 3);

    let longestGapMs = 0;
    let gapPair = null;
    for (let i = 1; i < msgs.length; i++) {
      const g = msgs[i].dt - msgs[i - 1].dt;
      if (g > longestGapMs) {
        longestGapMs = g;
        gapPair = [msgs[i - 1].dt, msgs[i].dt];
      }
    }

    const days = Object.keys(dailyAll).sort();
    let longestStreak = 0;
    let streakStart = null;
    let streakEnd = null;
    let curLen = 0;
    let curStart = null;
    let prev = null;
    for (const d of days) {
      const dt = new Date(`${d}T00:00:00`);
      if (!prev || dt - prev === 86400000) {
        if (!curLen) curStart = d;
        curLen += 1;
      } else {
        if (curLen > longestStreak) {
          longestStreak = curLen;
          streakStart = curStart;
          streakEnd = formatDate(prev);
        }
        curLen = 1;
        curStart = d;
      }
      prev = dt;
    }
    if (curLen > longestStreak) {
      longestStreak = curLen;
      streakStart = curStart;
      streakEnd = prev ? formatDate(prev) : null;
    }

    const bestRun = Object.fromEntries(people.map((p) => [p, { count: 0, start: null, end: null }]));
    let curSender = null;
    let runCount = 0;
    let runStart = null;
    for (const m of textMsgs) {
      if (m.sender === curSender) runCount += 1;
      else {
        curSender = m.sender;
        runCount = 1;
        runStart = m.dt;
      }
      if (runCount > bestRun[m.sender].count) bestRun[m.sender] = { count: runCount, start: runStart, end: m.dt };
    }

    const dailyCounts = Object.values(dailyAll);
    const dailyTextCounts = Object.values(dailyText);

    const responseTimes = [];
    for (let i = 1; i < msgs.length; i++) {
      if (msgs[i].sender !== msgs[i - 1].sender) {
        const gap = msgs[i].dt - msgs[i - 1].dt;
        if (gap > 0 && gap <= 6 * 3600000) responseTimes.push(gap / 1000);
      }
    }

    let burst = { count: 0, start: null, end: null };
    const win = [];
    for (const m of msgs) {
      win.push(m);
      while (win.length && m.dt - win[0].dt > 300000) win.shift();
      if (win.length > burst.count) burst = { count: win.length, start: win[0].dt, end: win[win.length - 1].dt };
    }

    const monthly = {};
    msgs.forEach((m) => {
      const k = `${m.dt.getFullYear()}-${String(m.dt.getMonth() + 1).padStart(2, '0')}`;
      monthly[k] = (monthly[k] || 0) + 1;
    });
    const topMonth = Object.entries(monthly).sort((a, b) => b[1] - a[1])[0] || null;

    const sessionStartsBy = {};
    const sessionEndsBy = {};
    sessions.forEach((s) => {
      sessionStartsBy[s.msgs[0].sender] = (sessionStartsBy[s.msgs[0].sender] || 0) + 1;
      sessionEndsBy[s.msgs[s.msgs.length - 1].sender] = (sessionEndsBy[s.msgs[s.msgs.length - 1].sender] || 0) + 1;
    });

    let mostOneSided = null;
    let mostBalanced = null;
    let fastestSession = null;
    let bestOneSidedScore = -1;
    let bestBalancedScore = Infinity;
    let fastestSpeed = -1;

    sessions.forEach((s) => {
      const textOnly = s.msgs.filter((m) => !m.is_attachment);
      const counts = {};
      textOnly.forEach((m) => { counts[m.sender] = (counts[m.sender] || 0) + 1; });
      const values = Object.values(counts);
      const totalText = values.reduce((a, b) => a + b, 0);
      if (totalText > 0) {
        const mx = Math.max(...values) / totalText;
        if (mx > bestOneSidedScore) {
          bestOneSidedScore = mx;
          mostOneSided = { session: s, pct: mx, counts };
        }
        const top2 = Object.values(counts).sort((a, b) => b - a).slice(0, 2);
        if (top2.length >= 2) {
          const diff = Math.abs(0.5 - top2[0] / (top2[0] + top2[1]));
          if (diff < bestBalancedScore) {
            bestBalancedScore = diff;
            mostBalanced = { session: s, counts };
          }
        }
      }
      const durMin = Math.max(1, s.durationMs / 60000);
      const speed = s.count / durMin;
      if (speed > fastestSpeed) {
        fastestSpeed = speed;
        fastestSession = { session: s, speed };
      }
    });

    return {
      total: msgs.length,
      textTotal: textMsgs.length,
      attachTotal: attachmentMsgs.length,
      attachBreakdown,
      people,
      perPerson,
      totalWords: textMsgs.reduce((a, m) => a + wordCount(m.text), 0),
      totalChars: textMsgs.reduce((a, m) => a + m.text.length, 0),
      top3All,
      top3Text,
      longestGapMs,
      gapPair,
      longestStreak,
      streakStart,
      streakEnd,
      bestRun,
      avgAll: dailyCounts.length ? dailyCounts.reduce((a, b) => a + b, 0) / dailyCounts.length : 0,
      avgText: dailyTextCounts.length ? dailyTextCounts.reduce((a, b) => a + b, 0) / dailyTextCounts.length : 0,
      medAll: median(dailyCounts),
      medText: median(dailyTextCounts),
      respMedian: percentile(responseTimes, 0.5),
      respP90: percentile(responseTimes, 0.9),
      burst,
      topMonth,
      monthly,
      swearTotal: Object.values(perPerson).reduce((a, p) => a + p.swear, 0),
      emojiTotal: Object.values(perPerson).reduce((a, p) => a + p.emojiish, 0),
      sessionCount: sessions.length,
      avgSessionMinutes: sessions.length ? sessions.reduce((a, s) => a + s.durationMs / 60000, 0) / sessions.length : 0,
      medSessionMinutes: median(sessions.map((s) => s.durationMs / 60000)),
      avgMsgsPerSession: sessions.length ? sessions.reduce((a, s) => a + s.count, 0) / sessions.length : 0,
      medMsgsPerSession: median(sessions.map((s) => s.count)),
      longestSession: sessions.length ? [...sessions].sort((a, b) => b.durationMs - a.durationMs)[0] : null,
      biggestSession: sessions.length ? [...sessions].sort((a, b) => b.count - a.count)[0] : null,
      sessionStartsBy,
      sessionEndsBy,
      mostOneSided,
      mostBalanced,
      fastestSession,
    };
  }, [mappedMessages, sessions]);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);
  const colors = ['#2563eb', '#16a34a', '#9333ea', '#ea580c', '#dc2626', '#0891b2'];

  return <div className="page">
    <h1>Chat Stats Analyzer (React)</h1>

    <section className="card">
      <h2>1) Upload chats</h2>
      <label>WhatsApp .txt files <input type="file" accept=".txt" multiple onChange={(e) => handleUpload(e, parseWhatsApp)} /></label>
      <label>Discord .txt files <input type="file" accept=".txt" multiple onChange={(e) => handleUpload(e, parseDiscord)} /></label>
      <p>Loaded messages: {rawMessages.length}</p>
      <p>Loaded by source: WhatsApp {rawMessages.filter((m) => m.source === 'whatsapp').length} · Discord {rawMessages.filter((m) => m.source === 'discord').length}</p>
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

    {stats && <section className="card">
      <h2>4) Python-style summary stats</h2>
      <div className="statsGrid">
        <div><b>Total:</b> {stats.total} | <b>Text:</b> {stats.textTotal} | <b>Attachments:</b> {stats.attachTotal}</div>
        <div><b>Total words:</b> {stats.totalWords} | <b>Total chars:</b> {stats.totalChars}</div>
        <div><b>Avg/day:</b> {stats.avgAll.toFixed(2)} | <b>Median/day:</b> {stats.medAll.toFixed(0)}</div>
        <div><b>Avg text/day:</b> {stats.avgText.toFixed(2)} | <b>Median text/day:</b> {stats.medText.toFixed(0)}</div>
        <div><b>Longest gap:</b> {fmtDuration(stats.longestGapMs)} {stats.gapPair ? `(${fmtDateTime(stats.gapPair[0])} → ${fmtDateTime(stats.gapPair[1])})` : ''}</div>
        <div><b>Longest streak:</b> {stats.longestStreak} days {stats.streakStart ? `(${stats.streakStart} → ${stats.streakEnd})` : ''}</div>
        <div><b>Response median:</b> {fmtDuration(stats.respMedian * 1000)} | <b>P90:</b> {fmtDuration(stats.respP90 * 1000)}</div>
        <div><b>5-min burst:</b> {stats.burst.count} msgs {stats.burst.start ? `(${fmtDateTime(stats.burst.start)} → ${fmtDateTime(stats.burst.end)})` : ''}</div>
        <div><b>Most active month:</b> {stats.topMonth ? `${stats.topMonth[0]} (${stats.topMonth[1]} msgs)` : 'N/A'}</div>
        <div><b>Swear-ish hits:</b> {stats.swearTotal} | <b>Emoji-ish chars:</b> {stats.emojiTotal}</div>
      </div>

      <h3>Per person</h3>
      <div className="tableWrap"><table><thead><tr><th>Name</th><th>Total</th><th>Text</th><th>Attach</th><th>URL only</th><th>Words</th><th>Chars</th><th>Swear-ish</th><th>Emoji-ish</th><th>Best run (text)</th></tr></thead>
        <tbody>{stats.people.map((p) => <tr key={p}><td>{p}</td><td>{stats.perPerson[p].total}</td><td>{stats.perPerson[p].text}</td><td>{stats.perPerson[p].attachments}</td><td>{stats.perPerson[p].url_only}</td><td>{stats.perPerson[p].words}</td><td>{stats.perPerson[p].chars}</td><td>{stats.perPerson[p].swear}</td><td>{stats.perPerson[p].emojiish}</td><td>{stats.bestRun[p].count}</td></tr>)}</tbody>
      </table></div>

      <h3>Top days & attachment breakdown</h3>
      <div className="split">
        <div><p><b>Top 3 busiest days (all)</b></p><ul>{stats.top3All.map(([d, c]) => <li key={d}>{d}: {c}</li>)}</ul></div>
        <div><p><b>Top 3 busiest days (text)</b></p><ul>{stats.top3Text.map(([d, c]) => <li key={d}>{d}: {c}</li>)}</ul></div>
      </div>
      <ul>{Object.entries(stats.attachBreakdown).map(([k, v]) => <li key={k}>{k}: {v}</li>)}</ul>

      <h3>Session analytics</h3>
      <div className="statsGrid">
        <div><b>Total sessions:</b> {stats.sessionCount}</div>
        <div><b>Avg session minutes:</b> {stats.avgSessionMinutes.toFixed(2)} | <b>Median:</b> {stats.medSessionMinutes.toFixed(0)}</div>
        <div><b>Avg msgs/session:</b> {stats.avgMsgsPerSession.toFixed(2)} | <b>Median:</b> {stats.medMsgsPerSession.toFixed(0)}</div>
        <div><b>Longest session:</b> {stats.longestSession ? `${fmtDuration(stats.longestSession.durationMs)} (${stats.longestSession.count} msgs)` : 'N/A'}</div>
        <div><b>Biggest session:</b> {stats.biggestSession ? `${stats.biggestSession.count} msgs (${fmtDuration(stats.biggestSession.durationMs)})` : 'N/A'}</div>
        <div><b>Fastest session:</b> {stats.fastestSession ? `${stats.fastestSession.speed.toFixed(2)} msgs/min` : 'N/A'}</div>
        <div><b>Most one-sided:</b> {stats.mostOneSided ? `${(stats.mostOneSided.pct * 100).toFixed(1)}%` : 'N/A'}</div>
        <div><b>Most balanced:</b> {stats.mostBalanced ? JSON.stringify(stats.mostBalanced.counts) : 'N/A'}</div>
      </div>
    </section>}

    <section className="card">
      <h2>Daily messages (brush to zoom range)</h2>
      <div className="chartWrap"><ResponsiveContainer width="100%" height={340}><LineChart data={dailyData}>
        <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" /><YAxis /><Tooltip /><Legend />
        <Line type="monotone" dataKey="total" stroke="#111827" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="text" stroke="#16a34a" dot={false} />
        <Line type="monotone" dataKey="attachments" stroke="#dc2626" dot={false} />
        {participantKeys.map((k, i) => <Line key={k} type="monotone" dataKey={k} stroke={colors[i % colors.length]} dot={false} />)}
        <Brush dataKey="date" height={25} travellerWidth={10} />
      </LineChart></ResponsiveContainer></div>
    </section>

    <section className="card split">
      <div><h2>Top users</h2><div className="chartWrap small"><ResponsiveContainer width="100%" height={280}><BarChart data={topUsers}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" /><YAxis /><Tooltip /><Bar dataKey="count" fill="#2563eb" /></BarChart></ResponsiveContainer></div></div>
      <div><h2>Hour distribution</h2><div className="chartWrap small"><ResponsiveContainer width="100%" height={280}><BarChart data={hourData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="hour" /><YAxis /><Tooltip /><Legend /><Bar dataKey="all" fill="#16a34a" /><Bar dataKey="text" fill="#0ea5e9" /></BarChart></ResponsiveContainer></div></div>
    </section>

    <section className="card">
      <h2>Weekday distribution</h2>
      <div className="chartWrap small"><ResponsiveContainer width="100%" height={280}><BarChart data={weekdayData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="day" /><YAxis /><Tooltip /><Legend /><Bar dataKey="all" fill="#9333ea" /><Bar dataKey="text" fill="#f59e0b" /></BarChart></ResponsiveContainer></div>
    </section>

    <section className="card">
      <h2>5) Session explorer</h2>
      <p>Total sessions: {sessions.length}</p>
      <div className="sessionList">{sessions.map((s) => <button key={s.id} className="sessionBtn" onClick={() => setSelectedSessionId(s.id)}><strong>{s.start.toLocaleString()}</strong> → {s.end.toLocaleTimeString()} | {s.count} msgs | {s.durationMin} min | dominant: {s.dominant} ({s.dominantPct}%)</button>)}</div>
      {selectedSession && <div className="drilldown">
        <h3>Session detail</h3>
        <p>{selectedSession.start.toLocaleString()} to {selectedSession.end.toLocaleString()} · {selectedSession.count} messages · {selectedSession.durationMin} minutes · text {selectedSession.textCount} · attachments {selectedSession.attachCount}</p>
        <ul>{Object.entries(selectedSession.byUser).map(([u, c]) => <li key={u}>{u}: {c}</li>)}</ul>
        <div className="msgs">{selectedSession.msgs.map((m, i) => <p key={`${m.sender}-${i}`}><b>[{m.dt.toLocaleString()}] {m.sender}:</b> {m.text || `(attachment: ${m.attachment_type || 'unknown'})`}</p>)}</div>
      </div>}
    </section>
  </div>;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
