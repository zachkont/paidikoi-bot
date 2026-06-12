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
  const csrfToken = getRes.headers.get("set-cookie").match(/csrftoken=([^;]+)/)[1];
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
  return `csrftoken=${csrfToken}; sessionid=${sessionId}`;
}

async function fetchData(cookieHeader) {
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

async function sendTelegram(text) {
  for (const chatId of RECIPIENTS) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }
}

async function performCheck(dryRun = false) {
  try {
    const cookies = await login();
    const data = await fetchData(cookies);
    if (dryRun) {
      console.log("Dry run mode - telegram message would be:");
      console.log(data);
    } else {
      await sendTelegram(data);
      console.log("Sent successfully");
    }
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
