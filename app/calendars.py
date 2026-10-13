import time
import urllib.request
from datetime import date, datetime, time as clock, timedelta
from zoneinfo import ZoneInfo

from icalendar import Calendar
import recurring_ical_events

from app.db import ROOT

LOCAL_TZ = ZoneInfo("America/Vancouver")
CACHE = ROOT / "data" / "cache"
FRESH_SECONDS = 15 * 60


def today() -> date:
    return datetime.now(LOCAL_TZ).date()


def monday_of(day: date) -> date:
    return day - timedelta(days=day.weekday())


def http_url(url: str) -> str:
    if url.startswith("webcal://"):
        url = "https://" + url[len("webcal://") :]
    if url.endswith("/calendar.html"):
        url = url[: -len("html")] + "ics"
    return url


def fetch_ics(url: str) -> bytes:
    request = urllib.request.Request(http_url(url), headers={"User-Agent": "planner"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read()


def cached_ics(calendar_id: int, url: str, refresh: bool) -> tuple[bytes, bool]:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{calendar_id}.ics"
    fresh = path.exists() and (time.time() - path.stat().st_mtime) < FRESH_SECONDS
    if path.exists() and fresh and not refresh:
        return path.read_bytes(), False
    try:
        data = fetch_ics(url)
    except Exception:
        if path.exists():
            return path.read_bytes(), True
        raise
    path.write_bytes(data)
    return data, False


def format_time(moment: datetime) -> str:
    hour = moment.strftime("%I").lstrip("0") or "12"
    minute = moment.strftime("%M")
    suffix = "a" if moment.hour < 12 else "p"
    if minute == "00":
        return f"{hour}{suffix}"
    return f"{hour}:{minute}{suffix}"


def _local_datetime(value, tz) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=tz)
        return value.astimezone(tz)
    return datetime.combine(value, clock.min, tz)


def expand_calendar(name: str, color: str, payload: bytes, start_day: date, end_day: date) -> list[dict]:
    calendar = Calendar.from_ical(payload)
    window_start = datetime.combine(start_day, clock.min, LOCAL_TZ)
    window_end = datetime.combine(end_day + timedelta(days=1), clock.min, LOCAL_TZ)
    found = []
    for component in recurring_ical_events.of(calendar).between(window_start, window_end):
        if str(component.get("status", "")).upper() == "CANCELLED":
            continue
        title = str(component.get("summary") or "Busy").strip() or "Busy"
        start = component.start
        end = getattr(component, "end", None) or start
        if isinstance(start, datetime):
            start_local = _local_datetime(start, LOCAL_TZ)
            end_local = _local_datetime(end, LOCAL_TZ)
            if end_local <= start_local:
                end_local = start_local + timedelta(hours=1)
            day = start_day
            while day <= end_day:
                day_start = datetime.combine(day, clock.min, LOCAL_TZ)
                day_end = day_start + timedelta(days=1)
                if start_local < day_end and end_local > day_start:
                    segment_start = max(start_local, day_start)
                    segment_end = min(end_local, day_end)
                    start_min = segment_start.hour * 60 + segment_start.minute
                    end_min = 24 * 60 if segment_end >= day_end else segment_end.hour * 60 + segment_end.minute
                    if end_min <= start_min:
                        end_min = min(start_min + 30, 24 * 60)
                    found.append(
                        {
                            "day": day.isoformat(),
                            "title": title,
                            "time": format_time(start_local) if day == start_local.date() else "cont.",
                            "all_day": False,
                            "start_min": start_min,
                            "end_min": end_min,
                            "calendar": name,
                            "color": color,
                            "sort": f"{start_min:04d}",
                        }
                    )
                day += timedelta(days=1)
            continue
        if isinstance(start, date):
            end_day_exclusive = end if isinstance(end, date) and not isinstance(end, datetime) else start + timedelta(days=1)
            if isinstance(end, datetime):
                end_day_exclusive = end.date()
            cursor = start
            while cursor < end_day_exclusive:
                if start_day <= cursor <= end_day:
                    found.append(
                        {
                            "day": cursor.isoformat(),
                            "title": title,
                            "time": "All day",
                            "all_day": True,
                            "start_min": 0,
                            "end_min": 0,
                            "calendar": name,
                            "color": color,
                            "sort": "00:00",
                        }
                    )
                cursor += timedelta(days=1)
    return found


def events_for_range(calendars: list[dict], start_day: date, end_day: date, refresh: bool) -> tuple[list[dict], list[str]]:
    events = []
    warnings = []
    seen = set()
    for calendar in calendars:
        try:
            payload, stale = cached_ics(calendar["id"], calendar["url"], refresh)
            if stale:
                warnings.append(f"{calendar['name']} could not refresh")
            expanded = expand_calendar(calendar["name"], calendar["color"], payload, start_day, end_day)
        except Exception:
            warnings.append(f"{calendar['name']} could not be loaded")
            continue
        for event in expanded:
            key = (event["day"], event["calendar"], event["title"], event["start_min"], event["end_min"])
            if key in seen:
                continue
            seen.add(key)
            events.append(event)
    events.sort(key=lambda event: (event["day"], not event["all_day"], event["sort"], event["title"]))
    for event in events:
        event.pop("sort", None)
    return events, warnings
