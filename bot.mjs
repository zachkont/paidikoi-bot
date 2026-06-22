import * as cron from "node-cron";
import * as cheerio from "cheerio";

// --- Config (set via .env or environment variables) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const RECIPIENTS = process.env.RECIPIENTS?.split(",") ?? [];
const BASE_URL = "https://epaidikoi.glyfada.gr";
const TARGET_PATH = "/parents/";
const USERNAME = process.env.USERNAME;
const PASSWORD = process.env.PASSWORD;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? "0 9 * * *";
// -------------------------------------------------------

async function login() {
  // 1. GET login page to obtain the CSRF token
  const loginUrl = `${BASE_URL}/auth/login/`;
  const getRes = await fetch(loginUrl);
  const csrfToken = getRes.headers.get("set-cookie")?.match(/csrftoken=([^;]+)/)?.[1];
  if (!csrfToken) throw new Error("Login failed — could not extract CSRF token from login page");
  const html = await getRes.text();
  const $ = cheerio.load(html);
  const csrfMiddlewareToken = $("input[name=csrfmiddlewaretoken]").val();

  // 2. POST credentials
  const postRes = await fetch(loginUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `csrftoken=${csrfToken}`,
      Referer: loginUrl,
    },
    body: new URLSearchParams({
      csrfmiddlewaretoken: csrfMiddlewareToken,
      username: USERNAME,
      password: PASSWORD,
      next: TARGET_PATH,
    }),
    redirect: "manual",
  });

  // 3. Extract session cookie from response
  const setCookie = postRes.headers.get("set-cookie") ?? "";
  const sessionId = setCookie.match(/sessionid=([^;]+)/)?.[1];
  if (!sessionId) throw new Error("Login failed — check credentials");
  return { cookieHeader: `csrftoken=${csrfToken}; sessionid=${sessionId}`, csrfToken };
}

async function fetchData({ cookieHeader }) {
  const res = await fetch(`${BASE_URL}${TARGET_PATH}`, {
    headers: { Cookie: cookieHeader },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const lines = [`Ημερήσια ενημέρωση από τον Ε' Παιδικό Σταθμό Γλυφάδας:`];
  const today = new Date().toLocaleDateString("el-GR", { dateStyle: "long" });
  lines.push(`📅 ${today}\n`);

  // Ημερήσιες ενημερώσεις
  const mealsCard = $(".card-header.bg-pink").closest(".card");
  lines.push("🍽 Ημερήσιες ενημερώσεις");
  const mealRows = mealsCard.find(".row.flex-column");
  if (mealRows.length === 0) {
    lines.push("  Δεν υπάρχουν ενημερώσεις σήμερα.");
  } else {
    mealRows.each((_, el) => {
      const meal = $(el).find(".fw-bold").text().trim();
      const note = $(el).find("p:not(.fw-bold)").text().trim();
      if (meal) lines.push(`  • ${meal}${note ? `\n    ↳ ${note}` : ""}`);
    });
  }

  lines.push("");

  // Ημερήσιο σχόλιο
  const commentCard = $(".card-header.bg-danger").closest(".card");
  const comment = commentCard.find(".card-body").text().trim();
  lines.push("💬 Ημερήσιο σχόλιο");
  lines.push(`  ${comment}`);

  return lines.join("\n");
}

async function fetchInboxMessages({ cookieHeader, csrfToken }) {
  const args = JSON.stringify({
    draw: 1,
    columns: [
      { data: "sender_full_name", name: "", searchable: true,  orderable: true,  search: { value: "", regex: false, fixed: [] } },
      { data: "subject",          name: "", searchable: true,  orderable: true,  search: { value: "", regex: false, fixed: [] } },
      { data: "time",             name: "", searchable: false, orderable: true,  search: { value: "", regex: false, fixed: [] } },
      { data: "is_read",          name: "", searchable: false, orderable: false, search: { value: "", regex: false, fixed: [] } },
      { data: "pk",               name: "", searchable: false, orderable: false, search: { value: "", regex: false, fixed: [] } },
      { data: "pk",               name: "", searchable: false, orderable: false, search: { value: "", regex: false, fixed: [] } },
    ],
    order: [
      { column: 2, dir: "desc", name: "" },
      { column: 0, dir: "asc",  name: "" },
      { column: 1, dir: "asc",  name: "" },
    ],
    start: 0,
    length: 100,
    search: { value: "", regex: false, fixed: [] },
  });
  const res = await fetch(`${BASE_URL}/commons/ajax/messages_inbox`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-CSRFToken": csrfToken,
      "X-Requested-With": "XMLHttpRequest",
      Cookie: cookieHeader,
      Referer: `${BASE_URL}/parents/messages/inbox/`,
    },
    body: new URLSearchParams({ args }),
  });
  if (!res.ok) throw new Error(`Inbox fetch failed: ${res.status}`);
  const json = await res.json();
  return json.data ?? [];
}

async function fetchMessageBody({ cookieHeader }, pk) {
  const res = await fetch(`${BASE_URL}/parents/messages/display/?message_pk=${pk}`, {
    headers: { Cookie: cookieHeader },
  });
  if (!res.ok) throw new Error(`Message detail fetch failed: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  return $("textarea[name=body]").val()?.trim() ?? "";
}

async function checkInbox(session, dryRun = false) {
  const messages = await fetchInboxMessages(session);
  const unread = messages.filter(m => !m.is_read);
  if (unread.length === 0) return;

  unread.sort((a, b) => new Date(a.time) - new Date(b.time));

  for (const msg of unread) {
    const body = await fetchMessageBody(session, msg.pk);
    if (!body) {
      console.warn(`Message ${msg.pk} has empty body, skipping`);
      continue;
    }
    const date = new Date(msg.time).toLocaleString("el-GR", { dateStyle: "long", timeStyle: "short" });
    const text = [
      `📬 Νέο μήνυμα από: ${msg.sender_full_name}`,
      `📌 Θέμα: ${msg.subject}`,
      `📅 ${date}`,
      ``,
      body,
    ].join("\n");

    if (dryRun) {
      console.log("Inbox message would be sent:");
      console.log(text);
      console.log("---");
    } else {
      try {
        await sendTelegram(text);
      } catch (err) {
        console.error(`Failed to send message ${msg.pk}:`, err.message);
      }
    }
  }
}

async function sendTelegram(text) {
  for (const chatId of RECIPIENTS) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) throw new Error(`Telegram send failed for ${chatId}: ${res.status}`);
  }
}

async function performCheck(dryRun = false) {
  try {
    const session = await login();
    const data = await fetchData(session);
    if (dryRun) {
      console.log("Dry run mode - telegram message would be:");
      console.log(data);
    } else {
      await sendTelegram(data);
      console.log("Sent successfully");
    }
    await checkInbox(session, dryRun);
    return data;
  } catch (err) {
    console.error("Error:", err.message);
    return null;
  }
}

cron.schedule(CRON_SCHEDULE, () => performCheck());

// also run immediately on startup and log the fetched data
;(async () => {
  await performCheck(true);
})();

console.log(`Scheduler running (${CRON_SCHEDULE})`);
