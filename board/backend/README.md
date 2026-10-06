# board-backend

Sign-in, schedules and the calendar feed for the house board.

- Everyone signs in with their **name + the shared password** (`login.html`). Members edit their own schedule (`update-board.html`).
- A `board` login is view-only. It's for the wall display and stays signed in for ~6 months.
- The `board` login also gets **Board settings** (`house.html`): ticker messages (with an optional date, time window and "show N days ahead"), weekly chores, and extra days off / UBC closures (reading break etc.). These are stored in `data/house.json`, and members can see but not change them.
- People are always shown alphabetically on the board.
- Events people add are stored in `data/events.json`. The board reads everyone's merged calendar from `/api/calendar`.
- Optionally, a person can also have a public iCloud calendar merged in (see "iCloud" below).
- If the backend is down, the board falls back to its built-in sample schedule (the "Right now" header says "sample data").

## Set up
    npm install
    npm test                                   # recurrence/DST, validation and password checks
    PASSWORD='the shared password' node init-users.js Pierce Alex Sam Jordan Riley Morgan
    BOARD_STATIC=.. npm start                  # 127.0.0.1:4033, also serves the pages (dev)

`init-users.js` writes `data/users.json`: the people plus the password as a salted scrypt hash. The password itself is never stored.
- Change the password for everyone: `PASSWORD='new one' node init-users.js --password-only`
- Add/rename someone: edit `data/users.json` (`id` is lowercase letters/digits; sign-in matches the name case-insensitively). They use the shared password.
- People can set their own colour and birthday on the edit page.

Everything under `data/` (users, events, the cookie-signing key) is gitignored and is the only place the server writes.
Back it up. Deleting `data/secret.key` signs everyone out.

## Security notes
- One shared password means anyone who has it can sign in as anyone and edit their schedule. Fine for a house; it is the trade-off you chose.
- Cookies are signed, HttpOnly, SameSite=Lax (and Secure behind HTTPS). Write requests must be JSON, which blocks cross-site form posts.
- 10 wrong passwords in 15 minutes from one address locks that address out for the rest of the window.
- Serve it over HTTPS only. The password is sent in the login request.

## iCloud (optional)
A person's public iCloud calendar can be merged in. Copy `feeds.example.json` to `feeds.json` and put the link under their `id`.
Calendar app → right-click the calendar → Share Calendar → Public Calendar → Copy Link. (The link works like a password: anyone with it can read that calendar.)
`feeds.json` also sets the holiday feed and `classPattern`, the regex that marks an iCloud event as a UBC class (default: course codes like `CPSC 221`).
Recurring events are expanded in wall-clock time, so a 9:00 class doesn't drift an hour across daylight saving.

## Deploy (matches the terminal setup)
1. DNS: A record for `board.pierceoxley.ca`.
2. Copy `board/` (`index.html`, `login.html`, `update-board.html`, `house.html`, `backend/`) to `/var/www/board.pierceoxley.ca/`. In `backend/` run `npm install --omit=dev`, then `sudo -u www-data mkdir data` and run `init-users.js` as `www-data`.
3. `cp setup/board-backend.service /etc/systemd/system/ && systemctl enable --now board-backend`
4. `cp nginx/board.pierceoxley.ca.conf /etc/nginx/sites-available/` (+ symlink), `certbot --nginx -d board.pierceoxley.ca`, reload nginx.
5. On the iPad: sign in as `board`, then Share → Add to Home Screen for a true fullscreen app.
