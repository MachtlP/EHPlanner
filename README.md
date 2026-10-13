# EHPlanner

A personal Eisenhower planner you run on your own computer. One page holds the matrix, your streams, the week, a task builder, a record of time spent, and the tasks you have finished.

Important and urgent place each task:

| | Urgent | Not urgent |
| --- | --- | --- |
| Important | Do | Schedule |
| Not important | Hand off | Later |

Streams such as Uni, Car, and Private sit under the matrix. You can add your own. The week shows 06:00–20:00. A **!** on a task plans it onto a day, either as a block on the clock or as an estimate in the strip at the top of that day. Time spent is the record of what the day actually went to. The graveyard parks a stream you are not using, and you can restore it or delete it there.

The gear at the top right renames the heading and adds calendars.

## Can someone else use a clone?

Yes. Cloning the repo gives you the program only. Tasks, time logs, the app name, and calendar links are created on the machine that runs it. They live in `data/` and are not part of git, so your copy does not contain anyone else's plans, and a push does not publish them.

Each person needs their own running copy. The iPhone view is a browser pointed at that computer. It is not a second database.

## Requirements

- Python 3.12 or newer, with `pip`
- A browser
- macOS 13 or newer, Xcode command line tools, and Brave Browser, only if you want the Dock icon

Docker is optional. The steps below use Python. Use Docker only if you already want the app in a container.

## To-dos for a new copy

1. Clone this repo.
2. Create the virtual environment and install the packages.
3. Start the planner and open it.
4. Use the gear to set the app name and add your calendars.
5. On a Mac, install the Dock icon if you want one click to start it.
6. On an iPhone, open the computer's address while both are on the same network.

## Run with Python

From the project folder:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8787
```

Open `http://127.0.0.1:8787`.

Leave that terminal running while you use the planner. The database appears at `data/planner.db` the first time the server starts. Three streams are created when the database is empty: Uni, Car, and Private. Rename them, add more, or move one to the graveyard.

## Calendars

Open the gear, then **Calendars**.

- iCloud: open the calendar, share it as a public calendar, and paste the `webcal` link.
- Outlook: paste the link that ends in `calendar.ics`. The `calendar.html` page does not load.

Give it a name and a color. **Refresh** on the week loads the events. The secret link stays in the local database. The week shows the calendar name and color only.

The week uses Pacific time (`America/Vancouver`). To use another zone, change `LOCAL_TZ` in `app/calendars.py`.

## Mac application icon

This builds `~/Applications/Machtls-Planner.app` and puts it in the Dock. The icon starts this copy of the project when port 8787 is free, then opens Brave at `http://127.0.0.1:8787`.

From the project folder:

```bash
scripts/install-mac-app.sh
```

That script needs macOS, the Xcode command line tools (`swift`, `sips`, and `iconutil`), and Brave Browser. Run it again after you move the project folder, so the icon still points at the right place.

The Dock name stays Machtls-Planner. The gear changes the heading inside the page.

You can skip the icon and start the Python command above, then open the address in any browser.

## iPhone

On the Mac, print the Wi-Fi address:

```bash
ipconfig getifaddr en0
```

On the iPhone, open `http://<that-address>:8787` while the Mac is awake and both devices can reach each other. In Safari, use Share → Add to Home Screen. The phone reads and writes the database on the Mac.

## Docker

Docker is not required. If you prefer a container:

```bash
docker compose up -d --build
```

Open `http://127.0.0.1:8787`. The container stores the database in the local `data/` folder. The Mac icon script expects the Python virtual environment, so use the Python steps above when you want the Dock icon.
