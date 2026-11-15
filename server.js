const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const port = Number(process.env.PORT || 3000);
const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_PASSWORD;
const production = process.env.NODE_ENV === "production";
const dataDirectory = path.join(__dirname, "data");
const ticketsFile = path.join(dataDirectory, "tickets.json");
const sessionLifetime = 8 * 60 * 60 * 1000;
const sessionCookie = "te_admin_session";
const sessions = new Map();
const loginAttempts = new Map();
const ticketLookupAttempts = new Map();
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/admin", ["admin.html", "text/html; charset=utf-8"]],
  ["/admin.html", ["admin.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/script.js", ["script.js", "text/javascript; charset=utf-8"]],
  ["/admin.js", ["admin.js", "text/javascript; charset=utf-8"]],
  ["/assets/tropical-esports.png", ["assets/tropical-esports.png", "image/png"]],
]);

if (!username || !password) {
  console.error("Set ADMIN_USERNAME and ADMIN_PASSWORD before starting the server.");
  process.exit(1);
}
if (username.length > 100 || password.length < 8 || password.length > 200) {
  console.error("ADMIN_USERNAME must be at most 100 characters and ADMIN_PASSWORD must be 8–200 characters.");
  process.exit(1);
}

let tickets;
let pendingWrites = Promise.resolve();

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
}

function getCookie(request, name) {
  const cookies = request.headers.cookie || "";
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : "";
}

function getAdminSession(request) {
  const token = getCookie(request, sessionCookie);
  const session = sessions.get(token);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function sessionCookieHeader(token, maxAge) {
  const secure = production ? "; Secure" : "";
  return `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function ensureSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new HttpError(403, "Request origin is not allowed.");
  }
  if (parsedOrigin.host !== request.headers.host) {
    throw new HttpError(403, "Request origin is not allowed.");
  }
}

async function readJson(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send the request as JSON.");
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16 * 1024) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON request.");
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function constantTimeEqual(left, right) {
  const leftHash = crypto.createHash("sha256").update(left).digest();
  const rightHash = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function isRateLimited(attempts, ip, limit) {
  const now = Date.now();
  for (const [address, attempt] of attempts) {
    if (attempt.resetAt <= now) attempts.delete(address);
  }
  const attempt = attempts.get(ip);
  return Boolean(attempt && attempt.count >= limit && attempt.resetAt > now);
}

function recordFailedAttempt(attempts, ip) {
  const now = Date.now();
  const attempt = attempts.get(ip);
  if (!attempt || attempt.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
  } else {
    attempt.count += 1;
  }
}

function loginIsBlocked(ip) {
  return isRateLimited(loginAttempts, ip, 8);
}

function recordFailedLogin(ip) {
  recordFailedAttempt(loginAttempts, ip);
}

function validateTicket(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Ticket details are invalid.");
  }
  const limits = {
    name: 60,
    email: 120,
    gamertag: 40,
    game: 40,
    platform: 40,
    discord: 50,
    about: 700,
  };
  const ticket = {};
  for (const [field, limit] of Object.entries(limits)) {
    if (typeof body[field] !== "string") throw new HttpError(400, "Ticket details are incomplete.");
    ticket[field] = body[field].trim();
    if (ticket[field].length > limit || (field !== "discord" && !ticket[field])) {
      throw new HttpError(400, "Ticket details are invalid.");
    }
  }
  if (body.consent !== true) throw new HttpError(400, "Consent is required to submit an application.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ticket.email)) {
    throw new HttpError(400, "Enter a valid email address.");
  }
  const games = ["Fortnite", "Siege"];
  const platforms = ["PC", "PlayStation", "Xbox", "Nintendo Switch", "Mobile"];
  if (!games.includes(ticket.game) || !platforms.includes(ticket.platform)) {
    throw new HttpError(400, "Choose a listed game and platform.");
  }
  return {
    ...ticket,
    consent: true,
    ticketId: `TE-${crypto.randomBytes(16).toString("hex").toUpperCase()}`,
    createdAt: new Date().toISOString(),
    status: "New",
    scheduledAt: null,
    checked: false,
  };
}

function persistTicket(ticket) {
  return enqueueTicketWrite(async () => {
    const updatedTickets = [...tickets, ticket];
    await writeTickets(updatedTickets);
    tickets = updatedTickets;
  });
}

function persistSchedule(ticketId, scheduledAt) {
  return updateTicket(ticketId, { scheduledAt });
}

function persistReview(ticketId, checked) {
  return updateTicket(ticketId, { checked });
}

function updateTicket(ticketId, changes) {
  return enqueueTicketWrite(async () => {
    const ticketIndex = tickets.findIndex((ticket) => ticket.ticketId === ticketId);
    if (ticketIndex === -1) throw new HttpError(404, "Ticket not found.");
    const updatedTickets = tickets.slice();
    updatedTickets[ticketIndex] = { ...updatedTickets[ticketIndex], ...changes };
    await writeTickets(updatedTickets);
    tickets = updatedTickets;
    return updatedTickets[ticketIndex];
  });
}

function enqueueTicketWrite(operation) {
  const previous = pendingWrites;
  let release;
  pendingWrites = new Promise((resolve) => {
    release = resolve;
  });
  return (async () => {
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  })();
}

async function writeTickets(updatedTickets) {
  const temporaryFile = `${ticketsFile}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(updatedTickets, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryFile, ticketsFile);
}

function validateScheduledAt(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new HttpError(400, "Choose a valid date and time.");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new HttpError(400, "Choose a valid date and time.");
  }
  return value;
}

async function serveStatic(request, response, pathname) {
  const file = staticFiles.get(pathname);
  if (!file) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }
  try {
    const contents = await fs.readFile(path.join(__dirname, file[0]));
    response.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control": "no-cache",
      "Content-Length": contents.length,
    });
    response.end(request.method === "HEAD" ? undefined : contents);
  } catch (error) {
    console.error("Static file read failed:", error.message);
    sendJson(response, 500, { error: "The page could not be served." });
  }
}

async function handleRequest(request, response) {
  setSecurityHeaders(response);
  const url = new URL(request.url, "http://localhost");
  const { pathname } = url;

  if (pathname === "/api/tickets" && request.method === "POST") {
    ensureSameOrigin(request);
    const ticket = validateTicket(await readJson(request));
    await persistTicket(ticket);
    sendJson(response, 201, { ticketId: ticket.ticketId, createdAt: ticket.createdAt });
    return;
  }

  if (pathname === "/api/tickets/lookup" && request.method === "POST") {
    ensureSameOrigin(request);
    const ip = request.socket.remoteAddress || "unknown";
    if (isRateLimited(ticketLookupAttempts, ip, 10)) {
      sendJson(response, 429, { error: "Too many lookup attempts. Try again in 15 minutes." });
      return;
    }
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Enter your email and ticket ID.");
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const ticketId = typeof body.ticketId === "string" ? body.ticketId.trim().toUpperCase() : "";
    if (!email || email.length > 120 || !ticketId || ticketId.length > 40) {
      throw new HttpError(400, "Enter your email and ticket ID.");
    }
    const ticket = tickets.find((savedTicket) =>
      savedTicket.ticketId.toUpperCase() === ticketId && savedTicket.email.toLowerCase() === email,
    );
    if (!ticket) {
      recordFailedAttempt(ticketLookupAttempts, ip);
      sendJson(response, 404, { error: "No ticket matched that email and ticket ID." });
      return;
    }
    ticketLookupAttempts.delete(ip);
    sendJson(response, 200, {
      ticketId: ticket.ticketId,
      checked: Boolean(ticket.checked),
      scheduledAt: ticket.scheduledAt || null,
    });
    return;
  }

  if (pathname === "/api/admin/session" && request.method === "GET") {
    if (!getAdminSession(request)) {
      sendJson(response, 401, { authenticated: false });
      return;
    }
    sendJson(response, 200, { authenticated: true });
    return;
  }

  if (pathname === "/api/admin/login" && request.method === "POST") {
    ensureSameOrigin(request);
    const ip = request.socket.remoteAddress || "unknown";
    if (loginIsBlocked(ip)) {
      sendJson(response, 429, { error: "Too many sign-in attempts. Try again in 15 minutes." });
      return;
    }
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Invalid sign-in request.");
    }
    const suppliedUsername = typeof body.username === "string" ? body.username : "";
    const suppliedPassword = typeof body.password === "string" ? body.password : "";
    const credentialsMatch =
      constantTimeEqual(suppliedUsername, username) && constantTimeEqual(suppliedPassword, password);
    if (!credentialsMatch) {
      recordFailedLogin(ip);
      sendJson(response, 401, { error: "You do not have access. Check your credentials and try again." });
      return;
    }

    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { expiresAt: Date.now() + sessionLifetime });
    sendJson(response, 200, { authenticated: true }, {
      "Set-Cookie": sessionCookieHeader(token, sessionLifetime / 1000),
    });
    return;
  }

  if (pathname === "/api/admin/logout" && request.method === "POST") {
    ensureSameOrigin(request);
    sessions.delete(getCookie(request, sessionCookie));
    sendJson(response, 200, { authenticated: false }, {
      "Set-Cookie": sessionCookieHeader("", 0),
    });
    return;
  }

  const scheduleMatch = pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/schedule$/);
  if (scheduleMatch && request.method === "PUT") {
    if (!getAdminSession(request)) {
      sendJson(response, 401, { error: "You do not have access." });
      return;
    }
    ensureSameOrigin(request);
    let ticketId;
    try {
      ticketId = decodeURIComponent(scheduleMatch[1]);
    } catch {
      throw new HttpError(400, "Ticket ID is invalid.");
    }
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || !("scheduledAt" in body)) {
      throw new HttpError(400, "Choose a valid date and time.");
    }
    const scheduledAt = validateScheduledAt(body.scheduledAt);
    const ticket = await persistSchedule(ticketId, scheduledAt);
    sendJson(response, 200, { ticket });
    return;
  }

  const reviewMatch = pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/review$/);
  if (reviewMatch && request.method === "PUT") {
    if (!getAdminSession(request)) {
      sendJson(response, 401, { error: "You do not have access." });
      return;
    }
    ensureSameOrigin(request);
    let ticketId;
    try {
      ticketId = decodeURIComponent(reviewMatch[1]);
    } catch {
      throw new HttpError(400, "Ticket ID is invalid.");
    }
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.checked !== "boolean") {
      throw new HttpError(400, "Review status is invalid.");
    }
    const ticket = await persistReview(ticketId, body.checked);
    sendJson(response, 200, { ticket });
    return;
  }

  if (pathname === "/api/admin/tickets" && request.method === "GET") {
    if (!getAdminSession(request)) {
      sendJson(response, 401, { error: "You do not have access." });
      return;
    }
    sendJson(response, 200, { tickets });
    return;
  }

  if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }
  await serveStatic(request, response, pathname);
}

async function start() {
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  try {
    tickets = JSON.parse(await fs.readFile(ticketsFile, "utf8"));
    if (!Array.isArray(tickets)) throw new Error("Ticket storage must contain a JSON array.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    tickets = [];
    await fs.writeFile(ticketsFile, "[]\n", { mode: 0o600 });
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      console.error("Request failed:", error.message);
      sendJson(response, 500, { error: "The request could not be completed." });
    });
  });
  server.listen(port, () => {
    console.log(`Tropical Esports is available at http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error("Server startup failed:", error.message);
  process.exit(1);
});
