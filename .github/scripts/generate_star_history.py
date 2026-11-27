#!/usr/bin/env python3
"""Generate a self-hosted cumulative GitHub stars chart for Orbit README."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


def fetch_stars(repository: str, token: str) -> list[dt.date]:
    url = f"https://api.github.com/repos/{repository}/stargazers?per_page=100"
    dates: list[dt.date] = []
    while url:
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/vnd.github.star+json",
                "Authorization": f"Bearer {token}",
                "User-Agent": "orbit-star-history",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        with urllib.request.urlopen(request) as response:
            for star in json.load(response):
                dates.append(
                    dt.datetime.fromisoformat(star["starred_at"].replace("Z", "+00:00")).date()
                )
            links = response.headers.get("Link", "")
        url = ""
        for link in links.split(","):
            if 'rel="next"' in link:
                url = link[link.index("<") + 1 : link.index(">")]
                break
    return dates


def week_start(day: dt.date) -> dt.date:
    """Return the Monday containing ``day``."""
    return day - dt.timedelta(days=day.weekday())


def format_week(day: dt.date) -> str:
    return f"{day.strftime('%b')} {day.day}"


def render_svg(repository: str, dates: list[dt.date], today: dt.date | None = None) -> str:
    today = today or dt.date.today()
    sorted_dates = sorted(dates)
    current_week = week_start(today)
    weeks = [current_week - dt.timedelta(weeks=week) for week in reversed(range(26))]
    values = [sum(day <= min(week + dt.timedelta(days=6), today) for day in sorted_dates) for week in weeks]
    weekly = [
        sum(week <= day <= min(week + dt.timedelta(days=6), today) for day in sorted_dates)
        for week in weeks
    ]

    width, height = 800, 420
    left, right, top, bottom = 68, 24, 78, 64
    plot_w, plot_h = width - left - right, height - top - bottom
    latest = values[-1]
    if latest <= 0:
        step, grid_max = 1, 4
    else:
        magnitude = 10 ** max(0, len(str(latest)) - 2)
        step = max(magnitude, math.ceil(latest / 4 / magnitude) * magnitude)
        grid_max = max(step * 4, 4)

    def x(index: int) -> float:
        return left + index * plot_w / (len(weeks) - 1)

    def y(value: int) -> float:
        return top + (1 - value / grid_max) * plot_h

    y_ticks = []
    for index in range(5):
        value = step * index
        yy = y(value)
        label = f"{value / 1000:g}k" if value >= 1000 else str(value)
        y_ticks.append(
            f'<line x1="{left}" y1="{yy:.1f}" x2="{width-right}" y2="{yy:.1f}" class="grid"/>'
            f'<text x="{left-12}" y="{yy+5:.1f}" text-anchor="end">{label}</text>'
        )

    points = " ".join(f"{x(index):.1f},{y(value):.1f}" for index, value in enumerate(values))
    area = f"{left},{top + plot_h:.1f} {points} {width-right},{top + plot_h:.1f}"
    x_ticks = []
    dots = []
    for index, (week, value, gain) in enumerate(zip(weeks, values, weekly)):
        week_lbl = format_week(week)
        if index % 4 == 0 or index == len(weeks) - 1:
            x_ticks.append(
                f'<text x="{x(index):.1f}" y="{height-30}" text-anchor="middle">{week_lbl}</text>'
            )
        current = " current" if week == current_week else ""
        radius = 5 if current else 3
        noun = "star" if value == 1 else "stars"
        dots.append(
            f'<circle class="point{current}" cx="{x(index):.1f}" cy="{y(value):.1f}" r="{radius}">'
            f'<title>{week_lbl}: {value:,} total {noun} (+{gain:,} that week)</title></circle>'
        )

    star_noun = "star" if latest == 1 else "stars"
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">
<title id="title">{repository} cumulative GitHub stars over time</title>
<desc id="desc">Cumulative GitHub stars sampled weekly over the last 26 weeks, ending at {latest:,} {star_noun}.</desc>
<style>
  :root {{ color-scheme: light dark; }}
  .bg {{ fill: #fff; }} text {{ fill: #57606a; font: 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }}
  .grid {{ stroke: #d8dee4; stroke-width: 1; }}
  .area {{ fill: #2e9b78; fill-opacity: .14; }} .line {{ fill: none; stroke: #2e9b78; stroke-width: 3; stroke-linejoin: round; stroke-linecap: round; }}
  .point {{ fill: #fff; stroke: #2e9b78; stroke-width: 2; }} .point.current {{ fill: #2e9b78; stroke: #fff; stroke-width: 2; }}
  .heading {{ fill: #24292f; font-size: 17px; font-weight: 600; }} .metric {{ fill: #24292f; font-size: 18px; font-weight: 600; }}
  @media (prefers-color-scheme: dark) {{ .bg {{ fill: #0d1117; }} text {{ fill: #8b949e; }} .grid {{ stroke: #30363d; }} .area {{ fill: #4fd1a5; fill-opacity: .16; }} .line {{ stroke: #4fd1a5; }} .point {{ fill: #0d1117; stroke: #4fd1a5; }} .point.current {{ fill: #4fd1a5; stroke: #0d1117; }} .heading,.metric {{ fill: #f0f6fc; }} }}
</style>
<rect class="bg" width="100%" height="100%" rx="6"/>
<text class="heading" x="{left}" y="28">GitHub stars over time</text>
<text x="{left}" y="51">Cumulative stars · weekly sampling · last 26 weeks</text>
<text class="metric" x="{width-right}" y="28" text-anchor="end">{latest:,} {star_noun}</text>
<text x="{width-right}" y="51" text-anchor="end">+{weekly[-1]:,} this week so far</text>
{''.join(y_ticks)}
<polygon class="area" points="{area}"/>
<polyline class="line" points="{points}"/>
{''.join(dots)}
{''.join(x_ticks)}
</svg>
'''


def self_test() -> None:
    today = dt.date(2026, 11, 27)
    empty_svg = render_svg("aphelion31/orbit", [], today=today)
    ET.fromstring(empty_svg)
    assert "0 stars" in empty_svg

    one_svg = render_svg("aphelion31/orbit", [dt.date(2026, 11, 25)], today=today)
    ET.fromstring(one_svg)
    assert "1 star</text>" in one_svg

    many_dates = [today - dt.timedelta(days=i % 150) for i in range(2400)]
    many_svg = render_svg("aphelion31/orbit", many_dates, today=today)
    ET.fromstring(many_svg)
    assert "2,400 stars" in many_svg
    print("✔ generate_star_history.py self-test passed (0, 1, 2,400 stars)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default="aphelion31/orbit")
    parser.add_argument("--output", type=Path, default=Path("docs/images/star-history.svg"))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        raise SystemExit("GITHUB_TOKEN or GH_TOKEN is required")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render_svg(args.repo, fetch_stars(args.repo, token)))


if __name__ == "__main__":
    main()
