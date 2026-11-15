# Tropical Esports tryout site

This site uses a small Node.js server for ticket submission and private admin access. It does not have a default admin account.

## Run locally

Use Node.js 18 or newer. The server requires an admin password of at least eight characters. In PowerShell, set admin credentials for the current terminal and start the server:

```powershell
$env:ADMIN_USERNAME = "your-admin-name"
$env:ADMIN_PASSWORD = "use-a-unique-password-of-at-least-12-characters"
$env:PORT = "3000"
npm start
```

Open `http://localhost:3000`. New applications can select Fortnite or Siege and enter the matching in-game username for the team to add. Applicants can check a ticket with its confirmation email and ticket ID to see whether it has been checked and any scheduled tryout time. Admins can mark tickets checked and set or clear each tryout date and time. Times are displayed in the viewer’s local timezone. Tickets and review/schedule updates are stored in `data/tickets.json` on the server.

## Deployment

Deploy this project to a Node.js host that provides persistent disk storage. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` as server environment variables in the host’s secret/configuration settings, and set `NODE_ENV=production` when served over HTTPS. Do not put admin credentials in HTML, JavaScript, or a committed file. Back up `data/tickets.json`; it contains applicant personal information.

The server uses in-memory sign-in sessions and rate limits failed logins per server-observed client IP. Sessions expire after eight hours and are cleared when the server restarts. For multi-instance deployments, replace the local JSON file and in-memory sessions with shared persistent storage and a shared session store.
