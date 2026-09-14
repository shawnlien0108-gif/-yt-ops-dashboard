"""讀取同一個 repo 裡的 schedule.json,整理成日報,寄到自己的 Gmail。
只用標準函式庫,GitHub Actions 不需要額外 pip install。
"""
import json
import os
import smtplib
import ssl
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Taipei")
DATA_PATH = "schedule.json"
WEEKDAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"]
PRIORITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def load_data():
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def parse(d):
    return datetime.strptime(d, "%Y-%m-%d").date()


def build_report(data):
    today = datetime.now(TZ).date()
    tasks = data.get("tasks", [])

    active_today, overdue, upcoming = [], [], []
    for t in tasks:
        start, end = parse(t["startDate"]), parse(t["endDate"])
        done = t.get("status") == "已完成"
        if start <= today <= end:
            active_today.append(t)
        elif end < today and not done:
            overdue.append(t)
        elif 0 < (start - today).days <= 3:
            upcoming.append(t)

    active_today.sort(key=lambda x: PRIORITY_ORDER.get(x.get("priority"), 1))
    upcoming.sort(key=lambda x: x["startDate"])

    lines = [
        f"📅 {today.strftime('%Y/%m/%d')}（週{WEEKDAY_NAMES[today.weekday()]}）YT 頻道營運日報",
        "",
    ]

    def section(title, items, date_field):
        lines.append(f"{title}（{len(items)}）")
        if items:
            for t in items:
                lines.append(f"・[{t['category']}] {t['project']} — {t['task']}（{t[date_field]}）")
        else:
            lines.append("　無")
        lines.append("")

    section("🔥 今日任務", active_today, "endDate")
    section("⚠️ 已逾期", overdue, "endDate")
    section("⏰ 未來 3 天", upcoming, "startDate")

    return "\n".join(lines)


def send_email(body):
    sender = os.environ["EMAIL_ADDRESS"]
    password = os.environ["EMAIL_APP_PASSWORD"]

    msg = MIMEMultipart()
    msg["From"] = sender
    msg["To"] = sender  # 寄給自己
    msg["Subject"] = f"📅 YT 頻道營運日報 {datetime.now(TZ).strftime('%Y/%m/%d')}"
    msg.attach(MIMEText(body, "plain", "utf-8"))

    context = ssl.create_default_context()
    with smtplib.SMTP("smtp.gmail.com", 587) as server:
        server.starttls(context=context)
        server.login(sender, password)
        server.send_message(msg)


if __name__ == "__main__":
    report = build_report(load_data())
    print(report)  # 也會留在 Actions 的執行紀錄裡,方便除錯
    send_email(report)
