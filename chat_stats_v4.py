#!/usr/bin/env python3
# chat_stats_v4.py
# WhatsApp + Discord chat stats (LH + Naddia)
# v4 adds conversation session analytics + extra charts

from __future__ import annotations

import argparse
import os
import re
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, date
from collections import defaultdict, Counter
from typing import List, Optional, Tuple, Dict

# =========================
# CONFIG (edit if needed)
# =========================

DEFAULT_STATS_START = date(2024, 9, 1)

# A session = continuous chat until a gap >= SESSION_GAP_MINUTES
SESSION_GAP_MINUTES = 30

# Map discord usernames to canonical WhatsApp names
DISCORD_USER_MAP = {
    "gameboi4784": "LH",
    "kamikoes": "Naddia",
}

# WhatsApp name canonicalization
WHATSAPP_USER_MAP = {
    "LH": "LH",
    "Naddia": "Naddia",
}

# People to ignore completely (Wordle, bots, etc.)
IGNORE_SENDER_REGEXES = [
    r"^Wordle#\d+$",
    r"^Wordle$",
    r"^Meta AI$",
]

IGNORE_SENDERS_ENABLED = True

# Treat these as attachment-only markers in WhatsApp
WHATSAPP_ATTACHMENT_MARKERS = [
    "image omitted",
    "sticker omitted",
    "video omitted",
    "gif omitted",
    "audio omitted",
    "document omitted",
]

# Discord attachment block types
DISCORD_ATTACHMENT_BLOCKS = {"{Attachments}", "{Embed}", "{Stickers}"}

# If a message is only a URL, count as text, but track url-only separately.
URL_ONLY_COUNTS_AS_TEXT = True

# Chart size
FIG_W, FIG_H = 14, 6


# =========================
# DATA MODEL
# =========================

@dataclass
class Msg:
    dt: datetime
    sender: str
    text: str
    source: str  # "whatsapp" or "discord"
    is_attachment: bool  # attachment-only msg
    attachment_type: Optional[str] = None  # "image" "sticker" "embed" "attachment" etc
    is_url_only: bool = False


@dataclass
class Session:
    start: datetime
    end: datetime
    msgs: List[Msg]

    def duration(self) -> timedelta:
        return self.end - self.start

    def msg_count(self) -> int:
        return len(self.msgs)

    def text_count(self) -> int:
        return sum(1 for m in self.msgs if not m.is_attachment)

    def attach_count(self) -> int:
        return sum(1 for m in self.msgs if m.is_attachment)

    def participants(self) -> List[str]:
        return sorted(set(m.sender for m in self.msgs))


# =========================
# UTILS
# =========================

def safe_mkdir(path: str) -> None:
    os.makedirs(path, exist_ok=True)

def parse_date_ddmmyyyy(s: str) -> datetime:
    # WhatsApp: 29/9/2024, 9:06:25 am
    return datetime.strptime(s, "%d/%m/%Y, %I:%M:%S %p")

def parse_date_ddmmyyyy_discord(s: str) -> datetime:
    # Discord: 24/07/2024 8:05 PM
    return datetime.strptime(s, "%d/%m/%Y %I:%M %p")

def canonical_sender(name: str, source: str) -> str:
    name = name.strip()
    if source == "discord":
        return DISCORD_USER_MAP.get(name, name)
    if source == "whatsapp":
        return WHATSAPP_USER_MAP.get(name, name)
    return name

def should_ignore_sender(sender: str) -> bool:
    if not IGNORE_SENDERS_ENABLED:
        return False
    for pat in IGNORE_SENDER_REGEXES:
        if re.match(pat, sender):
            return True
    return False

def is_url_only(text: str) -> bool:
    t = text.strip()
    if not t:
        return False
    parts = re.split(r"\s+", t)
    if not parts:
        return False
    for p in parts:
        if not re.match(r"^https?://", p):
            return False
    return True

def word_count(text: str) -> int:
    t = text.strip()
    if not t:
        return 0
    t = re.sub(r"https?://\S+", "", t)
    words = re.findall(r"[A-Za-z0-9']+", t)
    return len(words)

def day_key(dt: datetime) -> date:
    return dt.date()

def month_key(dt: datetime) -> Tuple[int, int]:
    return (dt.year, dt.month)

def weekday_name(i: int) -> str:
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i]

def human_tdelta(td: timedelta) -> str:
    total = int(td.total_seconds())
    if total < 0:
        total = -total
    days = total // 86400
    rem = total % 86400
    hours = rem // 3600
    rem %= 3600
    mins = rem // 60
    secs = rem % 60
    if days:
        return f"{days} days, {hours:02d}:{mins:02d}:{secs:02d}"
    return f"{hours:02d}:{mins:02d}:{secs:02d}"

def median(nums: List[int]) -> float:
    if not nums:
        return 0.0
    nums = sorted(nums)
    n = len(nums)
    mid = n // 2
    if n % 2 == 1:
        return float(nums[mid])
    return (nums[mid - 1] + nums[mid]) / 2.0

def mean(nums: List[float]) -> float:
    if not nums:
        return 0.0
    return sum(nums) / len(nums)

def percentile(vals: List[float], p: float) -> float:
    if not vals:
        return 0.0
    vals = sorted(vals)
    k = (len(vals) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return vals[int(k)]
    return vals[f] * (c - k) + vals[c] * (k - f)


# =========================
# PARSERS
# =========================

def parse_whatsapp(path: str) -> List[Msg]:
    msgs: List[Msg] = []

    header_re = re.compile(
        r"^\[(\d{1,2}/\d{1,2}/\d{4}),\s+(\d{1,2}:\d{2}:\d{2})\s*([ap]m)\]\s+([^:]+):\s*(.*)$",
        re.IGNORECASE
    )

    def normalize_line(line: str) -> str:
        return line.replace("\u202f", " ").replace("\u200e", "").replace("\u200f", "").replace("\ufeff", "").rstrip("\n")

    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        lines = [normalize_line(x) for x in f.readlines()]

    current: Optional[Msg] = None

    for line in lines:
        if not line.strip():
            if current is not None:
                current.text += "\n"
            continue

        m = header_re.match(line)
        if m:
            if current is not None:
                msgs.append(current)

            d = m.group(1)
            t = m.group(2)
            ap = m.group(3).upper()
            sender_raw = m.group(4).strip()
            body = m.group(5)

            dt = parse_date_ddmmyyyy(f"{d}, {t} {ap}")
            sender = canonical_sender(sender_raw, "whatsapp")

            body_stripped = body.strip()
            attach_type = None
            is_attach = False

            body_norm = body_stripped.lower().replace("\u200e", "").replace("\u200f", "").strip("‎ ").strip()

            for mk in WHATSAPP_ATTACHMENT_MARKERS:
                if mk in body_norm:
                    is_attach = True
                    attach_type = mk.split()[0]
                    body_stripped = ""
                    break

            current = Msg(
                dt=dt,
                sender=sender,
                text=body_stripped,
                source="whatsapp",
                is_attachment=is_attach,
                attachment_type=attach_type,
                is_url_only=is_url_only(body_stripped) if body_stripped else False,
            )
        else:
            if current is None:
                continue
            current.text += ("\n" if current.text else "") + line.strip()

    if current is not None:
        msgs.append(current)

    out: List[Msg] = []
    for msg in msgs:
        if should_ignore_sender(msg.sender):
            continue
        out.append(msg)
    return out


def parse_discord(path: str) -> List[Msg]:
    msgs: List[Msg] = []

    header_re = re.compile(
        r"^\[(\d{2}/\d{2}/\d{4})\s+(\d{1,2}:\d{2})\s+([AP]M)\]\s+(.+)$"
    )

    def normalize_line(line: str) -> str:
        return line.replace("\u202f", " ").replace("\u200e", "").replace("\u200f", "").replace("\ufeff", "").rstrip("\n")

    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        lines = [normalize_line(x) for x in f.readlines()]

    i = 0
    while i < len(lines):
        line = lines[i].strip()
        m = header_re.match(line)
        if not m:
            i += 1
            continue

        d = m.group(1)
        t = m.group(2)
        ap = m.group(3)
        sender_raw = m.group(4).strip()

        dt = parse_date_ddmmyyyy_discord(f"{d} {t} {ap}")
        sender = canonical_sender(sender_raw, "discord")

        i += 1

        body_lines = []
        attachment_only = False
        attachment_type = None

        while i < len(lines):
            nxt = lines[i].strip()

            if header_re.match(nxt):
                break

            if nxt in DISCORD_ATTACHMENT_BLOCKS:
                attachment_only = True
                if nxt == "{Stickers}":
                    attachment_type = "sticker"
                elif nxt == "{Embed}":
                    attachment_type = "embed"
                else:
                    attachment_type = "attachment"

                i += 1
                while i < len(lines):
                    b = lines[i].strip()
                    if not b:
                        i += 1
                        break
                    if header_re.match(b):
                        break
                    i += 1
                continue

            if nxt != "":
                body_lines.append(nxt)
            i += 1

        body = "\n".join(body_lines).strip()

        msg = Msg(
            dt=dt,
            sender=sender,
            text=body,
            source="discord",
            is_attachment=attachment_only and (not body),
            attachment_type=attachment_type if (attachment_only and not body) else None,
            is_url_only=is_url_only(body) if body else False,
        )

        if should_ignore_sender(msg.sender):
            continue

        msgs.append(msg)

    return msgs


# =========================
# META AI FILTER
# =========================

def apply_meta_ai_filter(msgs: List[Msg]) -> List[Msg]:
    """
    Exclude messages from Naddia if:
      - immediately after a message containing "@Meta AI"
      - AND Naddia message contains "<This message was edited>"
    """
    out: List[Msg] = []
    for idx, msg in enumerate(msgs):
        if msg.sender != "Naddia":
            out.append(msg)
            continue

        if idx == 0:
            out.append(msg)
            continue

        prev = msgs[idx - 1]
        if "@meta ai" in prev.text.lower() and "<this message was edited>" in msg.text.lower():
            continue

        out.append(msg)
    return out


# =========================
# SESSIONS
# =========================

def build_sessions(msgs: List[Msg], gap_minutes: int) -> List[Session]:
    if not msgs:
        return []

    msgs = sorted(msgs, key=lambda m: m.dt)
    gap = timedelta(minutes=gap_minutes)

    sessions: List[Session] = []
    cur_msgs: List[Msg] = [msgs[0]]
    cur_start = msgs[0].dt
    cur_end = msgs[0].dt

    for prev, nxt in zip(msgs, msgs[1:]):
        if (nxt.dt - prev.dt) >= gap:
            sessions.append(Session(start=cur_start, end=cur_end, msgs=cur_msgs))
            cur_msgs = [nxt]
            cur_start = nxt.dt
            cur_end = nxt.dt
        else:
            cur_msgs.append(nxt)
            cur_end = nxt.dt

    sessions.append(Session(start=cur_start, end=cur_end, msgs=cur_msgs))
    return sessions


# =========================
# STATS CORE
# =========================

def compute_stats(msgs: List[Msg], stats_start: date) -> Dict:
    msgs = sorted(msgs, key=lambda m: m.dt)

    sessions = build_sessions(msgs, SESSION_GAP_MINUTES)

    total = len(msgs)

    attachment_only = [m for m in msgs if m.is_attachment]
    text_msgs = [m for m in msgs if not m.is_attachment]

    attach_breakdown = Counter()
    for m in attachment_only:
        attach_breakdown[m.attachment_type or "attachment"] += 1

    people = sorted(set(m.sender for m in msgs))
    per_person = {}
    for p in people:
        p_msgs = [m for m in msgs if m.sender == p]
        per_person[p] = {
            "total": len(p_msgs),
            "text": sum(1 for m in p_msgs if not m.is_attachment),
            "attachments": sum(1 for m in p_msgs if m.is_attachment),
            "url_only": sum(1 for m in p_msgs if (not m.is_attachment and m.is_url_only)),
            "words": sum(word_count(m.text) for m in p_msgs if not m.is_attachment),
            "chars": sum(len(m.text) for m in p_msgs if not m.is_attachment),
        }

    total_words = sum(word_count(m.text) for m in text_msgs)
    total_chars = sum(len(m.text) for m in text_msgs)

    if msgs:
        first_dt = msgs[0].dt
        last_dt = msgs[-1].dt
    else:
        first_dt = last_dt = None

    daily_all = Counter()
    daily_text = Counter()
    daily_attach = Counter()

    for m in msgs:
        d = day_key(m.dt)
        daily_all[d] += 1
        if m.is_attachment:
            daily_attach[d] += 1
        else:
            daily_text[d] += 1

    top3_all = sorted(daily_all.items(), key=lambda x: (-x[1], x[0]))[:3]
    top3_text = sorted(daily_text.items(), key=lambda x: (-x[1], x[0]))[:3]

    longest_gap = timedelta(0)
    gap_pair = None
    for a, b in zip(msgs, msgs[1:]):
        gap = b.dt - a.dt
        if gap > longest_gap:
            longest_gap = gap
            gap_pair = (a.dt, b.dt)

    days_with_contact = sorted(daily_all.keys())
    longest_streak = 0
    streak_start = None
    streak_end = None

    cur_len = 0
    cur_start = None
    prev_day = None

    for d in days_with_contact:
        if prev_day is None or d == prev_day + timedelta(days=1):
            if cur_len == 0:
                cur_start = d
            cur_len += 1
        else:
            if cur_len > longest_streak:
                longest_streak = cur_len
                streak_start = cur_start
                streak_end = prev_day
            cur_len = 1
            cur_start = d
        prev_day = d

    if cur_len > longest_streak:
        longest_streak = cur_len
        streak_start = cur_start
        streak_end = prev_day

    # Most messages in a row (TEXT-ONLY)
    best_run = {p: {"count": 0, "start": None, "end": None} for p in people}
    cur_sender = None
    cur_count = 0
    cur_start_dt = None
    last_dt_run = None

    for m in msgs:
        if m.is_attachment:
            cur_sender = None
            cur_count = 0
            cur_start_dt = None
            last_dt_run = None
            continue

        if m.sender == cur_sender:
            cur_count += 1
            last_dt_run = m.dt
        else:
            if cur_sender is not None and cur_count > best_run[cur_sender]["count"]:
                best_run[cur_sender] = {"count": cur_count, "start": cur_start_dt, "end": last_dt_run}
            cur_sender = m.sender
            cur_count = 1
            cur_start_dt = m.dt
            last_dt_run = m.dt

    if cur_sender is not None and cur_count > best_run[cur_sender]["count"]:
        best_run[cur_sender] = {"count": cur_count, "start": cur_start_dt, "end": last_dt_run}

    # Hourly distribution
    hour_all = Counter()
    hour_text = Counter()
    for m in msgs:
        hour_all[m.dt.hour] += 1
        if not m.is_attachment:
            hour_text[m.dt.hour] += 1

    # Weekday distribution
    weekday_all = Counter()
    weekday_text = Counter()
    for m in msgs:
        wd = m.dt.weekday()
        weekday_all[wd] += 1
        if not m.is_attachment:
            weekday_text[wd] += 1

    # Averages/medians after stats_start
    daily_after = []
    daily_text_after = []
    if msgs:
        start_dt = max(stats_start, msgs[0].dt.date())
        end_dt = msgs[-1].dt.date()

        d = start_dt
        while d <= end_dt:
            daily_after.append(daily_all.get(d, 0))
            daily_text_after.append(daily_text.get(d, 0))
            d += timedelta(days=1)

    avg_all_after = (sum(daily_after) / len(daily_after)) if daily_after else 0.0
    avg_text_after = (sum(daily_text_after) / len(daily_text_after)) if daily_text_after else 0.0
    med_all_after = median(daily_after)
    med_text_after = median(daily_text_after)

    # Response time stats (sender-switch gaps <= 6h)
    response_times = []
    response_times_by = defaultdict(list)

    for a, b in zip(msgs, msgs[1:]):
        if a.sender != b.sender:
            gap = b.dt - a.dt
            if timedelta(seconds=0) < gap <= timedelta(hours=6):
                response_times.append(gap.total_seconds())
                response_times_by[b.sender].append(gap.total_seconds())

    resp_median = percentile(response_times, 0.5)
    resp_p90 = percentile(response_times, 0.9)

    # 5-minute burst record
    burst_best = {"count": 0, "start": None, "end": None}
    window = []
    for m in msgs:
        window.append(m)
        while window and (m.dt - window[0].dt) > timedelta(minutes=5):
            window.pop(0)
        if len(window) > burst_best["count"]:
            burst_best = {"count": len(window), "start": window[0].dt, "end": window[-1].dt}

    # Most active month
    monthly = Counter()
    for m in msgs:
        monthly[month_key(m.dt)] += 1
    top_month = None
    if monthly:
        top_month = max(monthly.items(), key=lambda x: x[1])

    # Profanity-ish counter (unserious)
    SWEAR_RE = re.compile(r"\b(fuck|shit|bitch|cunt|asshole|nigga|wtf|stfu)\b", re.IGNORECASE)
    swear_total = 0
    swear_by = defaultdict(int)
    for m in text_msgs:
        hits = len(SWEAR_RE.findall(m.text))
        swear_total += hits
        swear_by[m.sender] += hits

    # Emoji-ish count (non-ascii)
    emoji_total = 0
    emoji_by = defaultdict(int)
    for m in text_msgs:
        non_ascii = sum(1 for ch in m.text if ord(ch) > 127)
        emoji_total += non_ascii
        emoji_by[m.sender] += non_ascii

    # =========================
    # SESSION STATS
    # =========================

    session_count = len(sessions)
    session_durations_min = [s.duration().total_seconds() / 60 for s in sessions]
    session_msg_counts = [s.msg_count() for s in sessions]
    session_text_counts = [s.text_count() for s in sessions]
    session_attach_counts = [s.attach_count() for s in sessions]

    avg_session_minutes = mean(session_durations_min)
    median_session_minutes = median([int(x) for x in session_durations_min])

    avg_msgs_per_session = mean([float(x) for x in session_msg_counts])
    median_msgs_per_session = median(session_msg_counts)

    longest_session = max(sessions, key=lambda s: s.duration()) if sessions else None
    biggest_session = max(sessions, key=lambda s: s.msg_count()) if sessions else None

    session_starts_by = Counter()
    session_ends_by = Counter()
    for s in sessions:
        if s.msgs:
            session_starts_by[s.msgs[0].sender] += 1
            session_ends_by[s.msgs[-1].sender] += 1

    most_one_sided = None
    most_balanced = None
    one_sided_score_best = -1.0
    balanced_score_best = 999.0

    fastest_session = None
    fastest_speed = 0.0

    for s in sessions:
        if not s.msgs:
            continue

        counts = Counter(m.sender for m in s.msgs if not m.is_attachment)
        total_text = sum(counts.values())

        if total_text > 0:
            shares = [counts[p] / total_text for p in counts]
            mx = max(shares) if shares else 0.0

            if mx > one_sided_score_best:
                one_sided_score_best = mx
                most_one_sided = (s, mx, counts)

            if len(counts) >= 2:
                top2 = counts.most_common(2)
                a = top2[0][1]
                b = top2[1][1]
                share_a = a / (a + b)
                diff = abs(0.5 - share_a)
                if diff < balanced_score_best:
                    balanced_score_best = diff
                    most_balanced = (s, diff, counts)

        dur_min = max(1.0, s.duration().total_seconds() / 60.0)
        speed = s.msg_count() / dur_min
        if speed > fastest_speed:
            fastest_speed = speed
            fastest_session = (s, speed)

    # Sessions per week (chart)
    sessions_weekly = Counter()
    for s in sessions:
        if s.start.date() < stats_start:
            continue
        iso = s.start.isocalendar()
        sessions_weekly[(iso.year, iso.week)] += 1

    # Avg msgs per session per month (chart)
    session_msgs_monthly = Counter()
    session_counts_monthly = Counter()
    for s in sessions:
        if s.start.date() < stats_start:
            continue
        key = (s.start.year, s.start.month)
        session_msgs_monthly[key] += s.msg_count()
        session_counts_monthly[key] += 1

    # Session duration histogram data (minutes)
    session_durations_after = [
        (s.duration().total_seconds() / 60)
        for s in sessions
        if s.start.date() >= stats_start
    ]

    return {
        "msgs": msgs,
        "total": total,
        "text_total": len(text_msgs),
        "attach_total": len(attachment_only),
        "attach_breakdown": attach_breakdown,
        "per_person": per_person,
        "people": people,
        "total_words": total_words,
        "total_chars": total_chars,
        "first_dt": first_dt,
        "last_dt": last_dt,
        "daily_all": daily_all,
        "daily_text": daily_text,
        "daily_attach": daily_attach,
        "top3_all": top3_all,
        "top3_text": top3_text,
        "longest_gap": longest_gap,
        "gap_pair": gap_pair,
        "longest_streak": longest_streak,
        "streak_start": streak_start,
        "streak_end": streak_end,
        "best_run": best_run,
        "hour_all": hour_all,
        "hour_text": hour_text,
        "weekday_all": weekday_all,
        "weekday_text": weekday_text,
        "avg_all_after": avg_all_after,
        "avg_text_after": avg_text_after,
        "med_all_after": med_all_after,
        "med_text_after": med_text_after,
        "stats_start": stats_start,
        "resp_median": resp_median,
        "resp_p90": resp_p90,
        "response_times_by": response_times_by,
        "burst_best": burst_best,
        "top_month": top_month,
        "monthly": monthly,
        "swear_total": swear_total,
        "swear_by": swear_by,
        "emoji_total": emoji_total,
        "emoji_by": emoji_by,

        # sessions
        "sessions": sessions,
        "session_count": session_count,
        "session_durations_min": session_durations_min,
        "session_msg_counts": session_msg_counts,
        "session_text_counts": session_text_counts,
        "session_attach_counts": session_attach_counts,
        "avg_session_minutes": avg_session_minutes,
        "median_session_minutes": median_session_minutes,
        "avg_msgs_per_session": avg_msgs_per_session,
        "median_msgs_per_session": median_msgs_per_session,
        "longest_session": longest_session,
        "biggest_session": biggest_session,
        "session_starts_by": session_starts_by,
        "session_ends_by": session_ends_by,
        "most_one_sided": most_one_sided,
        "most_balanced": most_balanced,
        "fastest_session": fastest_session,
        "sessions_weekly": sessions_weekly,
        "session_msgs_monthly": session_msgs_monthly,
        "session_counts_monthly": session_counts_monthly,
        "session_durations_after": session_durations_after,
    }
# =========================
# REPORT WRITER
# =========================

def write_section(title: str, lines: List[str]) -> str:
    out = []
    out.append(f"--- {title} ---")
    for ln in lines:
        out.append(ln)
    out.append("")
    return "\n".join(out)

def fmt_dt(dt: Optional[datetime]) -> str:
    if dt is None:
        return "N/A"
    return dt.strftime("%Y-%m-%d %H:%M:%S")

def fmt_day(d: Optional[date]) -> str:
    if d is None:
        return "N/A"
    return d.isoformat()

def fmt_month(k: Tuple[int, int]) -> str:
    y, m = k
    return f"{y}-{m:02d}"

def safe_div(a: float, b: float) -> float:
    return (a / b) if b else 0.0

def render_report(stats: Dict, sources: List[str]) -> str:
    people = stats["people"]
    per_person = stats["per_person"]

    report = []
    report.append("=== CHAT STATS REPORT ===")
    report.append(f"Sources included: {', '.join(sources)}")
    report.append(f"Total messages: {stats['total']}")
    report.append(f"Text messages (no attachments): {stats['text_total']}")
    report.append(f"Attachment-only messages: {stats['attach_total']}")
    report.append("")

    # Per person
    lines = []
    for p in people:
        d = per_person[p]
        lines.append(
            f"{p}: total={d['total']}, text={d['text']}, attachments={d['attachments']}, url_only={d['url_only']}"
        )
    report.append(write_section("Per person", lines))

    # Attachments breakdown
    lines = []
    for k, v in stats["attach_breakdown"].most_common():
        lines.append(f"{k}: {v}")
    report.append(write_section("Attachments breakdown", lines))

    # Word counts
    lines = []
    lines.append(f"Total words: {stats['total_words']}")
    for p in people:
        lines.append(f"{p}: {per_person[p]['words']}")
    report.append(write_section("Word counts (text-only)", lines))

    # Char counts
    lines = []
    lines.append(f"Total characters: {stats['total_chars']}")
    for p in people:
        lines.append(f"{p}: {per_person[p]['chars']}")
    report.append(write_section("Character counts (text-only)", lines))

    # Top 3 busiest days
    lines = []
    for d, c in stats["top3_all"]:
        lines.append(f"{d.isoformat()}: {c}")
    report.append(write_section("Top 3 busiest days (INCLUDING attachments)", lines))

    lines = []
    for d, c in stats["top3_text"]:
        lines.append(f"{d.isoformat()}: {c}")
    report.append(write_section("Top 3 busiest days (TEXT-ONLY)", lines))

    # Longest gap
    if stats["gap_pair"]:
        a, b = stats["gap_pair"]
        lines = [f"{human_tdelta(stats['longest_gap'])} between {fmt_dt(a)} and {fmt_dt(b)}"]
    else:
        lines = ["N/A"]
    report.append(write_section("Longest no-contact gap", lines))

    # Streak
    if stats["streak_start"] and stats["streak_end"]:
        lines = [f"{stats['longest_streak']} days: {fmt_day(stats['streak_start'])} -> {fmt_day(stats['streak_end'])}"]
    else:
        lines = ["N/A"]
    report.append(write_section("Longest consecutive-day streak with contact", lines))

    # Best run
    lines = []
    for p in people:
        r = stats["best_run"][p]
        if r["count"] <= 0:
            continue
        lines.append(
            f"{p}: {r['count']} in a row from {fmt_dt(r['start'])} to {fmt_dt(r['end'])}"
        )
    report.append(write_section("Most messages in a row (TEXT-ONLY)", lines))

    # Extra nerd stats (date range full, avg/median after stats_start)
    first_dt = stats["first_dt"]
    last_dt = stats["last_dt"]
    stats_start = stats["stats_start"]

    if first_dt and last_dt:
        full_days = (last_dt.date() - first_dt.date()).days + 1
        after_days = (last_dt.date() - max(stats_start, first_dt.date())).days + 1
    else:
        full_days = 0
        after_days = 0

    lines = []
    if first_dt and last_dt:
        lines.append(f"Date range (FULL): {first_dt.date()} -> {last_dt.date()} ({full_days} days)")
        lines.append(f"Stats start date: {stats_start.isoformat()}")
        lines.append(f"Days counted for avg/median: {after_days}")
    else:
        lines.append("No messages.")

    lines.append(f"Avg messages/day (since {stats_start.isoformat()}): {stats['avg_all_after']:.2f}")
    lines.append(f"Avg text/day (since {stats_start.isoformat()}): {stats['avg_text_after']:.2f}")
    lines.append(f"Median messages/day (since {stats_start.isoformat()}): {stats['med_all_after']:.0f}")
    lines.append(f"Median text/day (since {stats_start.isoformat()}): {stats['med_text_after']:.0f}")

    # Response time
    if stats["resp_median"] > 0:
        lines.append(f"Median response time (sender switch <=6h): {human_tdelta(timedelta(seconds=stats['resp_median']))}")
        lines.append(f"P90 response time (sender switch <=6h): {human_tdelta(timedelta(seconds=stats['resp_p90']))}")
    else:
        lines.append("Response time stats: N/A")

    # Burst
    bb = stats["burst_best"]
    if bb["count"] > 0:
        lines.append(f"Most msgs in 5 minutes: {bb['count']} from {fmt_dt(bb['start'])} to {fmt_dt(bb['end'])}")

    # Month
    if stats["top_month"]:
        (y, m), c = stats["top_month"]
        lines.append(f"Most active month: {y}-{m:02d} ({c} msgs)")

    # unserious counters
    lines.append(f"Swear-ish hits (unserious): {stats['swear_total']}")
    for p in people:
        if stats["swear_by"].get(p, 0) > 0:
            lines.append(f"  {p}: {stats['swear_by'][p]}")
    lines.append(f"Non-ascii chars (emoji-ish): {stats['emoji_total']}")
    for p in people:
        if stats["emoji_by"].get(p, 0) > 0:
            lines.append(f"  {p}: {stats['emoji_by'][p]}")

    report.append(write_section("Extra nerd stats", lines))

    # =========================
    # SESSION STATS REPORT
    # =========================

    sessions = stats["sessions"]
    lines = []
    lines.append(f"Session gap threshold: {SESSION_GAP_MINUTES} minutes")
    lines.append(f"Total sessions: {stats['session_count']}")
    lines.append(f"Avg session duration: {stats['avg_session_minutes']:.2f} minutes")
    lines.append(f"Median session duration: {stats['median_session_minutes']:.0f} minutes")
    lines.append(f"Avg msgs/session: {stats['avg_msgs_per_session']:.2f}")
    lines.append(f"Median msgs/session: {stats['median_msgs_per_session']:.0f}")

    if stats["longest_session"]:
        s = stats["longest_session"]
        lines.append(
            f"Longest session: {human_tdelta(s.duration())} "
            f"({s.msg_count()} msgs) from {fmt_dt(s.start)} -> {fmt_dt(s.end)}"
        )

    if stats["biggest_session"]:
        s = stats["biggest_session"]
        lines.append(
            f"Most msgs in a session: {s.msg_count()} msgs "
            f"({human_tdelta(s.duration())}) from {fmt_dt(s.start)} -> {fmt_dt(s.end)}"
        )

    # starters/enders
    starts = stats["session_starts_by"]
    ends = stats["session_ends_by"]

    if starts:
        lines.append("Session starters:")
        for p, c in starts.most_common():
            lines.append(f"  {p}: {c}")

    if ends:
        lines.append("Session enders:")
        for p, c in ends.most_common():
            lines.append(f"  {p}: {c}")

    # one-sided / balanced / fastest
    if stats["most_one_sided"]:
        s, mx, counts = stats["most_one_sided"]
        lines.append(
            f"Most one-sided session: {mx*100:.1f}% by top sender "
            f"({dict(counts)}) from {fmt_dt(s.start)} -> {fmt_dt(s.end)}"
        )

    if stats["most_balanced"]:
        s, diff, counts = stats["most_balanced"]
        lines.append(
            f"Most balanced session: {dict(counts)} from {fmt_dt(s.start)} -> {fmt_dt(s.end)}"
        )

    if stats["fastest_session"]:
        s, speed = stats["fastest_session"]
        lines.append(
            f"Fastest session: {speed:.2f} msgs/min "
            f"({s.msg_count()} msgs, {human_tdelta(s.duration())}) "
            f"from {fmt_dt(s.start)} -> {fmt_dt(s.end)}"
        )

    report.append(write_section("Conversation sessions", lines))

    return "\n".join(report)


# =========================
# CHARTS
# =========================

def make_charts(stats: Dict, outdir: str) -> None:
    import matplotlib.pyplot as plt

    safe_mkdir(outdir)

    msgs = stats["msgs"]
    stats_start = stats["stats_start"]

    # Helper: filter msgs after stats_start for charts
    msgs_after = [m for m in msgs if m.dt.date() >= stats_start]

    # --- Daily messages (all) ---
    daily = Counter()
    for m in msgs_after:
        daily[m.dt.date()] += 1

    if daily:
        xs = sorted(daily.keys())
        ys = [daily[d] for d in xs]

        plt.figure(figsize=(FIG_W, FIG_H))
        plt.plot(xs, ys)
        plt.title(f"Daily messages (since {stats_start.isoformat()})")
        plt.xlabel("Date")
        plt.ylabel("Messages")
        plt.tight_layout()
        plt.savefig(os.path.join(outdir, "daily_messages.png"))
        plt.close()

    # --- Daily text vs attachments ---
    daily_text = Counter()
    daily_att = Counter()
    for m in msgs_after:
        if m.is_attachment:
            daily_att[m.dt.date()] += 1
        else:
            daily_text[m.dt.date()] += 1

    if daily_text or daily_att:
        xs = sorted(set(daily_text.keys()) | set(daily_att.keys()))
        y1 = [daily_text.get(d, 0) for d in xs]
        y2 = [daily_att.get(d, 0) for d in xs]

        plt.figure(figsize=(FIG_W, FIG_H))
        plt.plot(xs, y1, label="Text")
        plt.plot(xs, y2, label="Attachments")
        plt.title(f"Daily text vs attachments (since {stats_start.isoformat()})")
        plt.xlabel("Date")
        plt.ylabel("Messages")
        plt.legend()
        plt.tight_layout()
        plt.savefig(os.path.join(outdir, "daily_text_vs_attachments.png"))
        plt.close()

    # --- Monthly messages ---
    monthly = Counter()
    for m in msgs_after:
        monthly[(m.dt.year, m.dt.month)] += 1

    if monthly:
        xs = sorted(monthly.keys())
        labels = [fmt_month(k) for k in xs]
        ys = [monthly[k] for k in xs]

        plt.figure(figsize=(FIG_W, FIG_H))
        plt.plot(labels, ys)
        plt.title(f"Monthly messages (since {stats_start.isoformat()})")
        plt.xlabel("Month")
        plt.ylabel("Messages")
        plt.xticks(rotation=45, ha="right")
        plt.tight_layout()
        plt.savefig(os.path.join(outdir, "monthly_messages.png"))
        plt.close()

    # --- Hour of day ---
    hour = Counter()
    for m in msgs_after:
        hour[m.dt.hour] += 1

    if hour:
        xs = list(range(24))
        ys = [hour.get(h, 0) for h in xs]

        plt.figure(figsize=(FIG_W, FIG_H))
        plt.bar(xs, ys)
        plt.title(f"Messages by hour (since {stats_start.isoformat()})")
        plt.xlabel("Hour (0-23)")
        plt.ylabel("Messages")
        plt.tight_layout()
        plt.savefig(os.path.join(outdir, "hour_distribution.png"))
        plt.close()

    # --- Weekday ---
    wd = Counter()
    for m in msgs_after:
        wd[m.dt.weekday()] += 1

    if wd:
        xs = list(range(7))
        ys = [wd.get(i, 0) for i in xs]
        labels = [weekday_name(i) for i in xs]

        plt.figure(figsize=(FIG_W, FIG_H))
        plt.bar(labels, ys)
        plt.title(f"Messages by weekday (since {stats_start.isoformat()})")
        plt.xlabel("Weekday")
        plt.ylabel("Messages")
        plt.tight_layout()
        plt.savefig(os.path.join(outdir, "weekday_distribution.png"))
        plt.close()

    # --- Sessions per week ---
    weekly = stats["sessions_weekly"]
    if weekly:
        xs = sorted(weekly.keys())
        labels = [f"{y}-W{w:02d}" for (y, w) in xs]
        ys = [weekly[k] for k in xs]

        plt.figure(figsize=(FIG_W, FIG_H))
        plt.plot(labels, ys)
        plt.title(f"Sessions per week (since {stats_start.isoformat()})")
        plt.xlabel("ISO Week")
        plt.ylabel("Sessions")
        plt.xticks(rotation=45, ha="right")
        plt.tight_layout()
        plt.savefig(os.path.join(outdir, "sessions_per_week.png"))
        plt.close()

    # --- Avg msgs per session per month ---
    sm = stats["session_msgs_monthly"]
    sc = stats["session_counts_monthly"]
    if sm and sc:
        xs = sorted(sc.keys())
        labels = [fmt_month(k) for k in xs]
        ys = [safe_div(sm[k], sc[k]) for k in xs]

        plt.figure(figsize=(FIG_W, FIG_H))
        plt.plot(labels, ys)
        plt.title(f"Avg msgs/session per month (since {stats_start.isoformat()})")
        plt.xlabel("Month")
        plt.ylabel("Avg msgs/session")
        plt.xticks(rotation=45, ha="right")
        plt.tight_layout()
        plt.savefig(os.path.join(outdir, "avg_msgs_per_session_monthly.png"))
        plt.close()

    # --- Session duration histogram ---
    durs = stats["session_durations_after"]
    if durs:
        plt.figure(figsize=(FIG_W, FIG_H))
        plt.hist(durs, bins=30)
        plt.title(f"Session duration distribution (minutes) (since {stats_start.isoformat()})")
        plt.xlabel("Session duration (minutes)")
        plt.ylabel("Count")
        plt.tight_layout()
        plt.savefig(os.path.join(outdir, "session_duration_hist.png"))
        plt.close()


# =========================
# MAIN
# =========================

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--whatsapp", type=str, default=None, help="Path to WhatsApp exported txt")
    ap.add_argument("--discord", type=str, default=None, help="Path to Discord exported txt")
    ap.add_argument("--out", type=str, default="out", help="Output folder")
    ap.add_argument("--stats-start", type=str, default=None, help="Override stats start date (YYYY-MM-DD)")
    ap.add_argument("--session-gap", type=int, default=None, help="Override session gap minutes (default 30)")
    ap.add_argument("--no-ignore", action="store_true", help="Disable ignoring bot senders")
    ap.add_argument("--no-meta-filter", action="store_true", help="Disable Meta AI edited-message filter")

    args = ap.parse_args()

    global IGNORE_SENDERS_ENABLED
    if args.no_ignore:
        IGNORE_SENDERS_ENABLED = False

    global SESSION_GAP_MINUTES
    if args.session_gap is not None:
        SESSION_GAP_MINUTES = int(args.session_gap)

    stats_start = DEFAULT_STATS_START
    if args.stats_start:
        stats_start = datetime.strptime(args.stats_start, "%Y-%m-%d").date()

    sources = []
    msgs: List[Msg] = []

    if args.whatsapp:
        sources.append("whatsapp")
        msgs += parse_whatsapp(args.whatsapp)

    if args.discord:
        sources.append("discord")
        msgs += parse_discord(args.discord)

    msgs = sorted(msgs, key=lambda m: m.dt)

    if not args.no_meta_filter:
        msgs = apply_meta_ai_filter(msgs)

    safe_mkdir(args.out)

    stats = compute_stats(msgs, stats_start)

    report_txt = render_report(stats, sources)

    report_path = os.path.join(args.out, "report.txt")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report_txt)

    charts_dir = os.path.join(args.out, "charts")
    make_charts(stats, charts_dir)

    print(report_txt)
    print(f"\nSaved report to: {report_path}")
    print(f"Saved charts to: {charts_dir}")


if __name__ == "__main__":
    main()
