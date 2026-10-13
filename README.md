# Planner

A personal planner. One Eisenhower matrix sits at the top. Streams such as Uni, Car, and Private sit underneath. Each task has important and urgent, and those two switches place it in Do, Schedule, Hand off, or Later.

The same page is the dashboard on a Mac and on an iPhone.

Tasks stay in `data/planner.db` on the machine that runs the app. That file is not part of git.

## Run

```bash
docker compose up -d --build
```

Open `http://127.0.0.1:8787` on this Mac.

On the iPhone, use the same address with this Mac’s LAN address, for example `http://192.168.1.20:8787`, while both devices are on a network that can reach the Mac. In Safari, use Share → Add to Home Screen.

To print the Wi-Fi address:

```bash
ipconfig getifaddr en0
```

## Run without Docker

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8787
```
