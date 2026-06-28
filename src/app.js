require("dotenv").config();

// ===== HARDERCAST CLEAN PM2 LOG FILTER START =====
const HARDERCAST_ORIGINAL_CONSOLE_LOG = console.log.bind(console);
let HARDERCAST_CUSTOMER_LOG_BUFFER = null;

function hardercastCleanTime() {
  return new Date().toLocaleString("sv-SE", {
    timeZone: "Africa/Harare",
    hour12: false
  });
}

console.log = (...args) => {
  const line = args.map(v => {
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  }).join(" ");

  // Hide noisy raw YCloud event banners and JSON dumps from PM2.
  if (line.includes("===== YCLOUD CATCHALL EVENT =====")) return;
  if (line.trim().startsWith("{\"id\":\"evt_") && line.includes("\"whatsapp")) return;
  if (line.trim().startsWith("{\"id\":\"evt_") && line.includes("\"apiVersion\"")) return;

  // Convert the old multi-line customer log into one clean line.
  if (line.includes("========== HARDERCAST CUSTOMER ==========")) {
    HARDERCAST_CUSTOMER_LOG_BUFFER = {};
    return;
  }

  if (HARDERCAST_CUSTOMER_LOG_BUFFER) {
    if (line.startsWith("FROM:")) {
      HARDERCAST_CUSTOMER_LOG_BUFFER.from = line.replace(/^FROM:\s*/, "").trim();
      return;
    }

    if (line.startsWith("TO:")) {
      HARDERCAST_CUSTOMER_LOG_BUFFER.to = line.replace(/^TO:\s*/, "").trim();
      return;
    }

    if (line.startsWith("MESSAGE:")) {
      HARDERCAST_CUSTOMER_LOG_BUFFER.message = line.replace(/^MESSAGE:\s*/, "").trim();
      return;
    }

    if (line.startsWith("ACTION:")) {
      HARDERCAST_CUSTOMER_LOG_BUFFER.action = line.replace(/^ACTION:\s*/, "").trim();
      return;
    }

    if (line.startsWith("TIME:")) {
      HARDERCAST_CUSTOMER_LOG_BUFFER.time = line.replace(/^TIME:\s*/, "").trim();
      return;
    }

    if (line.startsWith("STATUS:")) {
      HARDERCAST_CUSTOMER_LOG_BUFFER.status = line.replace(/^STATUS:\s*/, "").trim();

      HARDERCAST_ORIGINAL_CONSOLE_LOG(
        `${hardercastCleanTime()} | ${HARDERCAST_CUSTOMER_LOG_BUFFER.from || "unknown"} | ${HARDERCAST_CUSTOMER_LOG_BUFFER.message || ""} | ${HARDERCAST_CUSTOMER_LOG_BUFFER.action || ""} | ${HARDERCAST_CUSTOMER_LOG_BUFFER.time || ""} | ${HARDERCAST_CUSTOMER_LOG_BUFFER.status || ""}`
      );

      HARDERCAST_CUSTOMER_LOG_BUFFER = null;
      return;
    }

    // If something unexpected appears, close buffer and continue.
    HARDERCAST_CUSTOMER_LOG_BUFFER = null;
  }

  HARDERCAST_ORIGINAL_CONSOLE_LOG(...args);
};
// ===== HARDERCAST CLEAN PM2 LOG FILTER END =====



const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.json({
  limit: "30mb",
  verify: (req, res, buf) => {
    req.rawBody = buf.toString("utf8");
  }
}));

const PORT = Number(process.env.PORT || 4120);
const BOT_NUMBER = cleanPhone(process.env.BOT_NUMBER || "263778095142");
const YCLOUD_FROM = cleanPhone(process.env.YCLOUD_FROM || BOT_NUMBER);
const TEST_CUSTOMER = cleanPhone(process.env.TEST_CUSTOMER || "971544835406");
const ALLOWED_CUSTOMERS = String(process.env.ALLOWED_CUSTOMERS || TEST_CUSTOMER).split(",").map(cleanPhone).filter(Boolean);
const ALLOW_ALL_CUSTOMERS = String(process.env.ALLOW_ALL_CUSTOMERS || "false").toLowerCase() === "true";
const ALERT_TEAM = cleanPhone(process.env.ALERT_TEAM || "263778095142");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const YCLOUD_API_KEY = process.env.YCLOUD_API_KEY || "";
const SIGNATURE_MAX_AGE_SECONDS = Number(process.env.SIGNATURE_MAX_AGE_SECONDS || 600);

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const DEEPSEEK_URL = process.env.DEEPSEEK_URL || "https://api.deepseek.com/chat/completions";
const HARDERCAST_LOGO_URL = process.env.HARDERCAST_LOGO_URL || "https://i.postimg.cc/qRbxN53j/Hardercast.png";
const HARDERCAST_WEBSITE = process.env.HARDERCAST_WEBSITE || "https://hardercastconstruction.co.zw/";
const HARDERCAST_FACEBOOK = process.env.HARDERCAST_FACEBOOK || "https://www.facebook.com/hardercastconstruction";
const HARDERCAST_INSTAGRAM = process.env.HARDERCAST_INSTAGRAM || "To be confirmed";

const DATA_DIR = path.join(__dirname, "..", "data");
const LOG_DIR = path.join(__dirname, "..", "logs");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const sessions = new Map();

const departments = {
  building: {
    icon: "🏗️",
    title: "Building & Construction",
    desc: "Homes, roofing, renovations",
    longDesc: "Residential and commercial building work, including new builds, roofing, renovations, bathrooms, basements, brickwork and fitted kitchens.",
    serviceSectionTitle: "Building Services",
    services: [
      ["house_construction", "House Construction", "New homes & structures"],
      ["commercial_building", "Commercial Building", "Business & industrial builds"],
      ["brick_walls", "Brick Walls", "Boundary & structural walls"],
      ["roofing", "Roofing", "New roofs, repairs & replacements"],
      ["bathrooms", "Bathrooms", "Bathroom building & upgrades"],
      ["thatching", "Thatching", "Thatch roofing work"],
      ["garage_doors", "Garage Doors", "Garage door installations"],
      ["basements", "Basements", "Basement construction"],
      ["renovations", "Renovations", "Home & office improvements"],
      ["fitted_kitchens", "Fitted Kitchens", "Kitchen fittings & cabinets"],
      ["advisor", "Talk to Advisor", "Get direct building guidance"],
      ["other", "Other Building Service", "Write your own building need"]
    ],
    questions: [
      "Is this a new build, repair, renovation, extension or replacement?",
      "What type of property is it: home, business, office, shop, warehouse or other?",
      "Where is the project site located?",
      "Do you already have drawings, plans, measurements or pictures? You can say yes, no, or describe what you have.",
      "When would you like the Hardercast team to review or start working on this?"
    ]
  },
  civil: {
    icon: "🛣️",
    title: "Civil Works",
    desc: "Paving, driveways, tar",
    longDesc: "Paving, driveways, tar surfacing, concrete works, site preparation and infrastructure projects.",
    serviceSectionTitle: "Civil Services",
    services: [
      ["paving", "Paving", "Residential & commercial paving"],
      ["tar_surfacing", "Tar Surfacing", "Roads & surfaces"],
      ["driveways", "Driveways", "Home & business driveways"],
      ["concrete_works", "Concrete Works", "Slabs, paths & structures"],
      ["infrastructure", "Infrastructure Works", "Site & civil projects"],
      ["advisor", "Talk to Advisor", "Get direct civil works guidance"],
      ["other", "Other Civil Service", "Write your own civil works need"]
    ],
    questions: [
      "Is this for a home, business, road, driveway, open space or construction site?",
      "What civil work do you need done?",
      "What is the approximate size or area involved? You can say not sure.",
      "Is the ground already prepared, or does it still need preparation?",
      "Do you have site pictures, measurements or drawings?"
    ]
  },
  boreholes: {
    icon: "💧",
    title: "Boreholes & Water",
    desc: "Drilling & water systems",
    longDesc: "Borehole drilling, borehole installation, pump setup, tank setup and water supply systems.",
    serviceSectionTitle: "Water Services",
    services: [
      ["borehole_drilling", "Borehole Drilling", "New borehole drilling"],
      ["borehole_installation", "Borehole Installation", "Setup & installation"],
      ["pump_setup", "Pump Setup", "Borehole pump systems"],
      ["water_tank_setup", "Water Tank Setup", "Tank installation"],
      ["water_systems", "Water Systems", "Water supply solutions"],
      ["advisor", "Talk to Advisor", "Get direct water guidance"],
      ["other", "Other Water Service", "Write your own water need"]
    ],
    questions: [
      "Do you need a new borehole, support for an existing borehole, pump setup, tank setup or a water system?",
      "Where is the property located?",
      "Is the water needed for home use, business use, farming, construction or another purpose?",
      "Do you need drilling only, or drilling plus pump/tank setup?",
      "Do you have any site pictures or important details the team should know?"
    ]
  },
  steel: {
    icon: "🔩",
    title: "Steel & Security",
    desc: "Gates, frames, metal works",
    longDesc: "Steel structures, gates, metal doors, security trellis doors, windows, frames and metal fabrication work.",
    serviceSectionTitle: "Steel Services",
    services: [
      ["steel_structures", "Steel Structures", "Steel framework"],
      ["gates", "Gates", "Gate fabrication"],
      ["metal_doors", "Metal Doors", "Strong metal doors"],
      ["trellis_doors", "Security Trellis Doors", "Security protection"],
      ["security_windows", "Security Windows", "Window protection"],
      ["frames", "Frames", "Metal frames"],
      ["advisor", "Talk to Advisor", "Get direct steel guidance"],
      ["other", "Other Steel Work", "Write your own steel/security need"]
    ],
    questions: [
      "What steel or security item do you need?",
      "Is it for a home, business, gate, window, door or structure?",
      "Do you need fabrication, installation, repair or replacement?",
      "Do you have measurements? You can say not sure.",
      "Can you send or describe a picture/design of what you want?"
    ]
  },
  electrical: {
    icon: "⚡",
    title: "Electrical & Solar",
    desc: "Power & solar systems",
    longDesc: "Electrical installation, electrical maintenance, solar installation and solar energy systems.",
    serviceSectionTitle: "Power Services",
    services: [
      ["electrical_installation", "Electrical Installation", "Wiring & installation"],
      ["electrical_maintenance", "Electrical Maintenance", "Repairs & maintenance"],
      ["solar_installation", "Solar Installation", "Solar setup"],
      ["solar_energy", "Solar Energy Solutions", "Energy backup systems"],
      ["advisor", "Talk to Advisor", "Get direct power guidance"],
      ["other", "Other Electrical Work", "Write your own electrical/solar need"]
    ],
    questions: [
      "Do you need electrical work, solar installation or maintenance?",
      "Is this for a home, business or construction site?",
      "Is it a new installation, repair or upgrade?",
      "For solar, what do you want to power? If not solar, say not applicable.",
      "Do you have pictures of the DB box, roof area or current setup?"
    ]
  },
  plumbing: {
    icon: "🚿",
    title: "Plumbing & Water",
    desc: "Plumbing & drainage",
    longDesc: "Plumbing, drainage, leaks, water systems and building water installations.",
    serviceSectionTitle: "Plumbing Services",
    services: [
      ["plumbing", "Plumbing", "General plumbing"],
      ["drainage", "Drainage", "Drainage systems"],
      ["water_systems", "Water Systems", "Water installations"],
      ["building_water", "Building Water Install", "Building water setup"],
      ["advisor", "Talk to Advisor", "Get direct plumbing guidance"],
      ["other", "Other Plumbing Work", "Write your own plumbing need"]
    ],
    questions: [
      "What plumbing or water system help do you need?",
      "Is this a new installation, repair, leak, drainage issue or upgrade?",
      "Which area is affected: bathroom, kitchen, outside, tank, borehole or drainage?",
      "Is the issue urgent or planned work?",
      "Can you send or describe pictures if available?"
    ]
  },
  finishes: {
    icon: "🎨",
    title: "Finishes & Interiors",
    desc: "Painting, tiling, ceilings",
    longDesc: "Painting, tiling, ceilings, bathrooms, fitted kitchens and interior finishing work.",
    serviceSectionTitle: "Interior Services",
    services: [
      ["painting", "Painting", "Interior & exterior painting"],
      ["tiling", "Tiling", "Floor & wall tiling"],
      ["ceilings", "Ceilings", "Ceiling installation"],
      ["bathrooms", "Bathrooms", "Bathroom finishes"],
      ["fitted_kitchens", "Fitted Kitchens", "Kitchen interiors"],
      ["interior_finishing", "Interior Finishing", "Final finishing work"],
      ["advisor", "Talk to Advisor", "Get direct interiors guidance"],
      ["other", "Other Interior Work", "Write your own finishing need"]
    ],
    questions: [
      "Which finishing or interior service do you need?",
      "Is this for a home, office, bathroom, kitchen or full property?",
      "How many rooms or areas are involved? You can say not sure.",
      "Do you already have a design, colour, tile type or layout in mind?",
      "Can you send or describe pictures and measurements?"
    ]
  },
  materials: {
    icon: "🧱",
    title: "Material Supplies",
    desc: "Bricks, sand, cement",
    longDesc: "Supply of bricks, sand, aggregates, timber, cement and other construction materials.",
    serviceSectionTitle: "Material Options",
    services: [
      ["bricks", "Bricks", "Building bricks"],
      ["sand", "Sand", "Pit/building sand"],
      ["aggregates", "Aggregates", "Stone & aggregates"],
      ["timber", "Timber", "Construction timber"],
      ["cement", "Cement", "Cement supply"],
      ["advisor", "Talk to Advisor", "Get direct supply guidance"],
      ["other", "Other Materials", "Write your own material need"]
    ],
    questions: [
      "Which materials do you need?",
      "What quantity are you looking for? You can say not sure.",
      "Is it for delivery or collection?",
      "Where should the materials be delivered, if delivery is needed?",
      "When do you need the materials?"
    ]
  }
};

function ensureOtherServiceOptions() {
  const otherOptions = {
    building: ["other", "Other Building Service", "Type your own building need"],
    civil: ["other", "Other Civil Service", "Type your own civil works need"],
    boreholes: ["other", "Other Water Service", "Type your own water/borehole need"],
    steel: ["other", "Other Steel Service", "Type your own steel/security need"],
    electrical: ["other", "Other Electrical/Solar", "Type your own power/solar need"],
    plumbing: ["other", "Other Plumbing Service", "Type your own plumbing/water need"],
    finishes: ["other", "Other Interior Service", "Type your own finishing/interior need"],
    materials: ["other", "Other Material Supply", "Type your own material need"]
  };

  for (const [key, otherRow] of Object.entries(otherOptions)) {
    const dep = departments[key];
    if (!dep) continue;

    if (!Array.isArray(dep.services)) dep.services = [];

    const existingOtherIndex = dep.services.findIndex(row => row && row[0] === "other");

    if (existingOtherIndex === -1) {
      dep.services.push(otherRow);
    } else {
      dep.services[existingOtherIndex] = otherRow;
    }
  }
}

ensureOtherServiceOptions();


function cleanPhone(v) {
  return String(v || "").replace(/\D/g, "");
}



function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function targetBotNumber() {
  return digitsOnly(process.env.YCLOUD_FROM || process.env.BOT_NUMBER || "15076361002");
}

function extractWebhookRecipient(body) {
  const msg =
    body.whatsappInboundMessage ||
    body.data?.whatsappInboundMessage ||
    body.event?.whatsappInboundMessage ||
    body.whatsappMessage ||
    body.data?.whatsappMessage ||
    body.message ||
    body.data?.message ||
    body;

  return digitsOnly(
    msg.to ||
    msg.recipient ||
    msg.phoneNumber ||
    msg.metadata?.display_phone_number ||
    body.to ||
    body.recipient ||
    body.phoneNumber ||
    body.metadata?.display_phone_number ||
    process.env.YCLOUD_FROM ||
    process.env.BOT_NUMBER
  );
}

function shouldHardercastHandleWebhook(body) {
  const target = targetBotNumber();
  const recipient = extractWebhookRecipient(body);

  // If YCloud payload does not include recipient, allow it.
  // If it includes recipient, only Hardercast handles +15076361002.
  if (!recipient) return true;
  return recipient === target;
}

function rawWebhookDebug(req) {
  try {
    const safeHeaders = { ...(req.headers || {}) };
    if (safeHeaders.authorization) safeHeaders.authorization = "***hidden***";
    if (safeHeaders["x-api-key"]) safeHeaders["x-api-key"] = "***hidden***";

    logFile("raw-webhook.log", {
      time: new Date().toISOString(),
      method: req.method,
      url: req.originalUrl || req.url,
      headers: safeHeaders,
      body: req.body
    });
  } catch (err) {
    try {
      logFile("raw-webhook-errors.log", { error: err.message });
    } catch {}
  }
}

function logFile(name, obj) {
  fs.appendFileSync(
    path.join(LOG_DIR, name),
    JSON.stringify({ time: new Date().toISOString(), data: obj }) + "\n"
  );
}

function maskPhone(v) {
  const s = cleanPhone(v);
  return s ? "+" + s : "";
}

function shortText(v, max = 160) {
  const s = String(v || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function readJson(file, fallback) {
  try {
    const fp = path.join(DATA_DIR, file);
    if (!fs.existsSync(fp)) return fallback;
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

function getSavedContact(phone) {
  const contacts = readJson("contacts.json", {});
  return contacts[phone] || null;
}

function saveContact(phone, contact) {
  const contacts = readJson("contacts.json", {});
  contacts[phone] = {
    ...contact,
    phone,
    updatedAt: new Date().toISOString()
  };
  writeJson("contacts.json", contacts);
  return contacts[phone];
}

function isMenuCommand(text) {
  const t = String(text || "").trim().toLowerCase();

  // Do not treat interactive IDs as normal menu commands.
  // Example: menu_departments must open departments, not reset to menu.
  if (
    t.startsWith("menu_") ||
    t.startsWith("dep_") ||
    t.startsWith("svc_") ||
    t.startsWith("action_") ||
    t.startsWith("client_") ||
    t.startsWith("contact_")
  ) {
    return false;
  }

  return (
    t === "menu" ||
    t === "start" ||
    /\bmenu\b/.test(t) ||
    /\bstart\b/.test(t)
  );
}

function isGreeting(text) {
  const t = String(text || "").trim().toLowerCase();
  const greetings = [
    "hi", "hie", "hey", "hello", "hullo",
    "hesi", "murisei", "makadii", "makadini",
    "maswera sei", "mangwanani", "masikati",
    "good morning", "good afternoon", "good evening"
  ];
  return greetings.includes(t);
}

function timingSafeEqualHex(a, b) {
  const aa = Buffer.from(String(a || ""), "hex");
  const bb = Buffer.from(String(b || ""), "hex");
  if (aa.length !== bb.length || aa.length === 0) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function verifyYCloudSignature(req) {
  if (!WEBHOOK_SECRET) return { ok: true, note: "signature check disabled" };

  const header = req.get("YCloud-Signature") || req.get("X-Signature") || "";
  if (!header) return { ok: false, reason: "signature header missing" };

  const parts = {};
  for (const piece of header.split(",")) {
    const [k, ...rest] = piece.trim().split("=");
    parts[k] = rest.join("=");
  }

  const timestamp = parts.t;
  const receivedSignature = parts.s;

  if (!timestamp || !receivedSignature) return { ok: false, reason: "bad signature format" };

  const ts = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);

  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_MAX_AGE_SECONDS) {
    return { ok: false, reason: "timestamp too old or invalid" };
  }

  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  const expectedSignature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  if (!timingSafeEqualHex(receivedSignature, expectedSignature)) {
    return { ok: false, reason: "signature mismatch" };
  }

  return { ok: true };
}

function extractDebugInfo(body) {
  const raw = JSON.stringify(body || {});
  const b = body || {};
  const inbound = b.whatsappInboundMessage || b.message || b.data || b;

  return {
    possibleType: inbound.type || b.type || b.eventType || b.event || b.whatsappInboundMessage?.type || "unknown",
    possibleFrom: inbound.from || inbound.customer?.phone || b.from || b.customer?.phone || "",
    possibleText: inbound.text?.body || inbound.text || b.text?.body || b.text || "",
    possibleInteractive: inbound.interactive || b.interactive || inbound.button || b.button || null,
    rawPreview: raw.slice(0, 1800)
  };
}

function parseInbound(body) {
  const inbound = body?.whatsappInboundMessage || body?.message || body?.data || body || {};
  const interactive = inbound?.interactive || body?.interactive || inbound?.whatsappInteractive || body?.whatsappInteractive || {};

  const listId =
    interactive?.list_reply?.id ||
    interactive?.listReply?.id ||
    inbound?.interactiveListReply?.id ||
    body?.list_reply?.id ||
    body?.listReply?.id ||
    "";

  const buttonId =
    interactive?.button_reply?.id ||
    interactive?.buttonReply?.id ||
    inbound?.interactiveButtonReply?.id ||
    body?.button_reply?.id ||
    body?.buttonReply?.id ||
    "";

  const buttonText =
    interactive?.button_reply?.title ||
    interactive?.buttonReply?.title ||
    inbound?.button?.text ||
    inbound?.button?.payload ||
    body?.button?.text ||
    body?.button?.payload ||
    "";

  const from = cleanPhone(
    inbound?.from ||
    inbound?.customer?.phone ||
    inbound?.waId ||
    inbound?.phone ||
    body?.from ||
    body?.customer?.phone ||
    body?.waId ||
    body?.phone ||
    ""
  );

  const text = String(
    listId ||
    buttonId ||
    buttonText ||
    inbound?.text?.body ||
    inbound?.text ||
    body?.text?.body ||
    body?.text ||
    body?.body ||
    ""
  ).trim();

  return { from, text };
}

async function sendYCloud(to, payloadPart) {
  if (!YCLOUD_API_KEY) {
    logFile("send-errors.log", { to, payloadPart, error: "YCLOUD_API_KEY missing" });
    return { ok: false, error: "YCLOUD_API_KEY missing" };
  }

  const payload = {
    from: YCLOUD_FROM,
    to: cleanPhone(to),
    ...payloadPart
  };

  const response = await fetch("https://api.ycloud.com/v2/whatsapp/messages/sendDirectly", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": YCLOUD_API_KEY
    },
    body: JSON.stringify(payload)
  });

  const resultText = await response.text();
  let result;
  try { result = JSON.parse(resultText); } catch { result = { raw: resultText }; }

  logFile("outbound.log", {
    from: YCLOUD_FROM,
    to,
    type: payloadPart.type,
    status: response.status,
    ok: response.ok,
    result
  });

  if (!response.ok) {
    logFile("send-errors.log", { from: YCLOUD_FROM, to, status: response.status, payload, result });
  }

  return { ok: response.ok, status: response.status, result };
}




async function sendImageMessage(to, imageUrl, caption = "") {
  const image = { link: imageUrl };

  if (caption && String(caption).trim()) {
    image.caption = String(caption).trim();
  }

  return sendYCloud(to, {
    type: "image",
    image
  });
}

async function sendText(to, body) {
  return sendYCloud(to, {
    type: "text",
    text: { body }
  });
}

async function sendList(to, bodyText, buttonText, sections) {
  const sent = await sendYCloud(to, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      footer: { text: "Tap an item to select it" },
      action: {
        button: buttonText,
        sections
      }
    }
  });

  if (!sent.ok) {
    const fallback = bodyText + "\n\n" + sections.map(sec => {
      return sec.title + "\n" + sec.rows.map((r, i) => `${i + 1}. ${r.title} - ${r.description || ""}`).join("\n");
    }).join("\n\n");
    await sendText(to, fallback);
  }

  return sent;
}

async function sendButtons(to, bodyText, buttons) {
  const sent = await sendYCloud(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map(b => ({
          type: "reply",
          reply: {
            id: b.id,
            title: b.title.slice(0, 20)
          }
        }))
      }
    }
  });

  if (!sent.ok) {
    const fallback = bodyText + "\n\n" + buttons.map((b, i) => `${i + 1}. ${b.title}`).join("\n");
    await sendText(to, fallback);
  }

  return sent;
}

function loadHardercastKnowledge() {
  try {
    const fp = path.join(DATA_DIR, "hardercast_knowledge.json");
    if (!fs.existsSync(fp)) return {};
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (err) {
    logFile("ai.log", { ok: false, reason: "knowledge load failed", error: err.message });
    return {};
  }
}

function getAiHistory(phone) {
  const file = "ai_history.json";
  const all = readJson(file, {});
  return all[phone] || [];
}

function saveAiHistory(phone, role, content) {
  const file = "ai_history.json";
  const all = readJson(file, {});
  if (!all[phone]) all[phone] = [];

  all[phone].push({
    role,
    content: String(content || "").slice(0, 1200),
    time: new Date().toISOString()
  });

  all[phone] = all[phone].slice(-20);
  writeJson(file, all);
}

function ensureAiFormat(text) {
  let out = String(text || "").trim();

  if (!out) {
    out = "⚙️\n- I’m not sure from the Hardercast information I have.\n- A team member can confirm this for you.";
  }

  if (!out.startsWith("⚙️")) {
    out = "⚙️\n" + out;
  }

  // Keep WhatsApp responses readable.
  if (out.length > 1400) {
    out = out.slice(0, 1350).trim() + "\n- Type *menu* to return to the main menu.";
  }

  return out;
}

async function aiBrain({ mode, userText = "", session = null, question = "" }) {
  const kb = loadHardercastKnowledge();

  const dep = session?.departmentKey ? departments[session.departmentKey]?.title || "" : "";
  const service = session?.customService || session?.serviceTitle || "";
  const savedAnswers = session?.answers ? Object.values(session.answers).join(" | ") : "";
  const phone = session?.phone || TEST_CUSTOMER;
  const history = getAiHistory(phone).slice(-10);

  const fallbackQuestion = question
    ? `⚙️\n- ${question}`
    : "⚙️\n- Please tell me a bit more so the Hardercast team can assist you properly.";

  if (!DEEPSEEK_API_KEY) {
    logFile("ai.log", {
      ok: false,
      reason: "DEEPSEEK_API_KEY missing",
      mode,
      dep,
      service
    });

    return mode === "question"
      ? fallbackQuestion
      : "⚙️\n- I can help with Hardercast Construction information.\n- Please ask about their services, location, contact details, or how the team can assist.";
  }

  const system = `You are the AI Assistant for Hardercast Construction.

You must answer ONLY using the verified Hardercast knowledge base provided below.

Hardercast knowledge base:
${JSON.stringify(kb, null, 2)}

Strict behaviour:
- You are for help and general enquiries only, not for collecting lead details.
- Start every response with exactly this emoji: ⚙️
- Use bullet points, not long paragraphs.
- Be conversational, confident and helpful.
- Keep answers short and easy to understand on WhatsApp.
- Do not ask more than ONE question in a reply.
- Do not ask for name, phone, email, address or budget in AI Assistant mode.
- Do not discuss money, pricing, deposits or payment unless the verified knowledge says so.
- If asked something outside Hardercast services or outside the knowledge base, say you are not sure from the Hardercast information available.
- Do not invent services, locations, prices, team names, Facebook posts or project facts.
Language rule:
- Understand Shona, Ndebele and mixed local language fully.
- Reply 90% in simple English.
- Use only a tiny local-language touch where natural, for example: "Zvakanaka," "Ndinzwisisa," or "Siyabonga."
- Do NOT reply with full Shona/Ndebele paragraphs.
- Do NOT translate the whole answer into Shona.
- Keep the message clear for Zimbabwean customers.
- For general construction guidance, keep it related to Hardercast's listed services.
- If the customer needs action, gently say they can type menu and choose a department or talk to the team. Do not use buttons in AI Assistant replies.`;

  let userPrompt = "";

  if (mode === "question") {
    userPrompt = `Rewrite this next flow question in a natural human WhatsApp style.

Department: ${dep}
Service: ${service}
Previous client answers: ${savedAnswers || "None yet"}
Question to ask: ${question}

Rules:
- Start with ⚙️
- Ask only this one question.
- No long paragraph.
- No buttons.
- No budget or money question.
Return only the customer message.`;
  } else if (mode === "general") {
    userPrompt = `Conversation history:
${history.map(h => `${h.role}: ${h.content}`).join("\n") || "No history yet"}

Customer message:
${userText}

Answer as the Hardercast AI Assistant using only the verified knowledge base.`;
  } else if (mode === "summary") {
    userPrompt = `Create a short professional internal summary for the Hardercast team.

Department: ${dep}
Service: ${service}
Client answers: ${savedAnswers}
Contact: ${JSON.stringify(session?.contact || {})}

Use bullet points. Start with ⚙️.`;
  } else {
    userPrompt = userText || question || "Help the customer.";
  }

  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.25,
        max_tokens: mode === "general" ? 360 : 260
      })
    });

    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    const content =
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.delta?.content ||
      "";

    let finalText = ensureAiFormat(content);

    logFile("ai.log", {
      ok: response.ok,
      status: response.status,
      mode,
      model: DEEPSEEK_MODEL,
      dep,
      service,
      input: shortText(userPrompt, 400),
      output: shortText(finalText, 700)
    });

    if (!response.ok || !content) {
      finalText = mode === "question"
        ? fallbackQuestion
        : "⚙️\n- I’m not sure from the Hardercast information I have.\n- A team member can confirm this for you.";
    }

    if (mode === "general") {
      saveAiHistory(phone, "customer", userText);
      saveAiHistory(phone, "assistant", finalText);
    }

    return finalText;

  } catch (err) {
    logFile("ai.log", {
      ok: false,
      mode,
      error: err.message
    });

    return mode === "question"
      ? fallbackQuestion
      : "⚙️\n- I’m not sure from the Hardercast information I have.\n- A team member can confirm this for you.";
  }
}


function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      phone,
      active: false,
      step: "idle",
      departmentKey: null,
      serviceId: null,
      serviceTitle: null,
      customService: "",
      questionIndex: 0,
      answers: {},
      contactChoice: "",
      contact: {},
      clientType: "",
      usedExistingContact: false
    });
  }
  return sessions.get(phone);
}

function resetSession(session) {
  session.active = true;
  session.step = "main_menu";
  session.departmentKey = null;
  session.serviceId = null;
  session.serviceTitle = null;
  session.customService = "";
  session.questionIndex = 0;
  session.answers = {};
  session.contactChoice = "";
  session.contact = {};
  session.clientType = "";
  session.usedExistingContact = false;
}

function buildMainMenuSections() {
  return [
    {
      title: "Main Options",
      rows: [
        { id: "menu_departments", title: "Choose our Main Services", description: "Building, boreholes, civil, solar & more" },
        { id: "menu_team", title: "Talk to Team", description: "Direct communication" },
        { id: "menu_ai", title: "AI Assistant", description: "General enquiries" }
      ]
    }
  ];
}

function buildDepartmentSections() {
  return [
    {
      title: "Core Construction",
      rows: [
        { id: "dep_building", title: "Building Works", description: "Homes, roofing, renovations" },
        { id: "dep_civil", title: "Civil Works", description: "Paving, driveways, tar" },
        { id: "dep_boreholes", title: "Boreholes & Water", description: "Drilling & water systems" },
        { id: "dep_steel", title: "Steel & Security", description: "Gates, frames, metal works" }
      ]
    },
    {
      title: "Specialist Services",
      rows: [
        { id: "dep_electrical", title: "Electrical & Solar", description: "Power & solar systems" },
        { id: "dep_plumbing", title: "Plumbing & Water", description: "Plumbing & drainage" },
        { id: "dep_finishes", title: "Finishes & Interiors", description: "Painting, tiling, ceilings" },
        { id: "dep_materials", title: "Material Supplies", description: "Bricks, sand, cement" }
      ]
    },
    {
      title: "Info & Help",
      rows: [
        { id: "dep_advisor", title: "Talk to Advisor", description: "Direct team assistance" },
        { id: "dep_ai", title: "AI Assistant", description: "Ask general questions" }
      ]
    }
  ];
}

function buildServiceSections(depKey) {
  ensureOtherServiceOptions();

  const dep = departments[depKey];
  const mainRows = [];
  const helpRows = [];

  for (const item of dep.services || []) {
    if (!Array.isArray(item)) continue;

    const [id, title, desc] = item;

    const row = {
      id: "svc_" + id,
      title: String(title || "").slice(0, 24),
      description: String(desc || "").slice(0, 72)
    };

    if (id === "advisor" || id === "other") {
      helpRows.push(row);
    } else {
      mainRows.push(row);
    }
  }

  // Keep Talk to Advisor and Other Service under Info & Help.
  helpRows.sort((a, b) => {
    if (a.id === "svc_advisor") return -1;
    if (b.id === "svc_advisor") return 1;
    if (a.id === "svc_other") return 1;
    if (b.id === "svc_other") return -1;
    return 0;
  });

  const sections = [];

  if (mainRows.length) {
    sections.push({
      title: String(dep.serviceSectionTitle || "Services").slice(0, 24),
      rows: mainRows
    });
  }

  if (helpRows.length) {
    sections.push({
      title: "Info & Help",
      rows: helpRows
    });
  }

  return sections;
}

async function sendGreetingMenu(to) {
  const greetingCaption = `👋 *Welcome to Hardercast Construction*

✨ *Your reliable partner in construction excellence.*

*We help with*
• 🏠 Building & renovations
• 💧 Boreholes & water systems
• 🛣️ Civil works & paving
• ⚡ Electrical & solar
• 🚿 Plumbing & interiors
• 🧱 Materials supply

*Build with confidence.*`;

  try {
    await sendImageMessage(to, HARDERCAST_LOGO_URL, greetingCaption);
  } catch (err) {
    logFile("send-errors.log", {
      kind: "greeting-logo",
      error: err.message
    });
    await sendText(to, greetingCaption);
  }

  const body = `🏗️ *How can we help you today?*

Tap *Open Menu* below to continue.`;

  return sendList(to, body, "Open Menu", buildMainMenuSections());
}

async function sendNormalMenu(to) {
  const body = `🏗️ *Hardercast Construction*

✨ *Your reliable partner in construction excellence.*

Tap *Open Menu* below to continue.`;

  return sendList(to, body, "Open Menu", buildMainMenuSections());
}

async function sendDepartmentMenu(to) {
  const body = `🛠️ *Choose Service*

• Select the main service area you need
• We will guide you step by step`;

  return sendList(to, body, "Choose Service", buildDepartmentSections());
}

async function sendDepartmentIntro(to, session) {
  const dep = departments[session.departmentKey];

  const body = `${dep.icon} *${dep.title}*

• ${dep.longDesc}

*Choose the specific service you need below*`;

  return sendList(to, body, "Choose Service", buildServiceSections(session.departmentKey));
}

async function sendAfterService(to, session) {
  const dep = departments[session.departmentKey];

  const body = `🛠️ *${session.serviceTitle}*

*Department*
• ${dep.title}

*Next step*
• I will ask a few clear questions
• This helps the team understand your request properly`;

  return sendButtons(to, body, [
    { id: "action_continue", title: "Continue" },
    { id: "action_advisor", title: "Talk Advisor" },
    { id: "action_back", title: "Back" }
  ]);
}

function serviceQuestion(session) {
  const dep = departments[session.departmentKey];
  return dep.questions[session.questionIndex] || null;
}






// ===== HARDERCAST GATHER AI START =====

function customerUsedLocalLanguage(text) {
  const t = String(text || "").toLowerCase();

  const localWords = [
    "ndiri", "ndirikuda", "ndoda", "ndinoda", "ndekwa", "gogo", "magetsi",
    "zvakanaka", "saka", "kumba", "pamba", "kwangu", "ku", "mukoma",
    "hie", "hesi", "makadii", "murisei", "masvingo", "harare", "ma1",
    "yangu", "yedu", "zesa", "ndanzwa", "ndinzwisisa", "ndatenda",
    "siyabonga", "ngiyabonga", "ngicela", "kancane"
  ];

  let score = 0;
  for (const w of localWords) {
    if (new RegExp(`\\\\b${w}\\\\b`, "i").test(t)) score += 1;
  }

  return score >= 2;
}

function normalizeServiceAiMessage(text, localLanguageUsed) {
  let out = String(text || "").trim();

  if (!out) {
    out = "⚙️ Thanks, that helps. What is the next important detail the team should know about this job?";
  }

  out = out.replace(/^["'`]+|["'`]+$/g, "").trim();

  if (!out.startsWith("⚙️")) {
    out = "⚙️ " + out;
  }

  // English only unless the customer used local language.
  if (!localLanguageUsed) {
    out = out
      .replace(/⚙️\s*Ndinzwisisa,?\s*/i, "⚙️ ")
      .replace(/⚙️\s*Zvakanaka,?\s*/i, "⚙️ ")
      .replace(/⚙️\s*Siyabonga,?\s*/i, "⚙️ ")
      .replace(/\bNdinzwisisa,?\s*/gi, "")
      .replace(/\bZvakanaka,?\s*/gi, "")
      .replace(/\bSiyabonga,?\s*/gi, "")
      .trim();

    if (!out.startsWith("⚙️")) out = "⚙️ " + out;
  } else {
    // Keep only a tiny local touch, never full Shona/Ndebele paragraphs.
    out = out
      .replace(/\bNdanzwa kuti\b/gi, "Thanks, I understand")
      .replace(/\bNdinzwisisa kuti\b/gi, "I understand that")
      .replace(/\bNdirikufunga\b/gi, "I think")
      .replace(/\bpanoda\b/gi, "we may need")
      .replace(/\bkana kuti\b/gi, "or")
      .trim();

    if (!/^⚙️\s*(Zvakanaka|Ndinzwisisa|Siyabonga|Thanks|Great)/i.test(out)) {
      out = out.replace(/^⚙️\s*/i, "⚙️ Zvakanaka, ");
    }
  }

  // Remove accidental markdown/code wrappers
  out = out.replace(/```/g, "").trim();

  if (out.length > 850) {
    out = out.slice(0, 820).trim() + "...";
  }

  return out;
}

function gatherAnswersText(session) {
  const entries = Object.entries(session?.answers || {});
  if (!entries.length) return "No previous answers yet.";

  return entries
    .map(([k, v], i) => `${i + 1}. ${String(v || "").trim()}`)
    .join("\n");
}

function countGatherAnswers(session) {
  return Object.values(session?.answers || {})
    .filter(v => String(v || "").trim().length > 1)
    .length;
}

function lastGatherAnswer(session) {
  const vals = Object.values(session?.answers || {}).filter(v => String(v || "").trim());
  return vals.length ? String(vals[vals.length - 1]) : "";
}

function getGatherProfile(session) {
  const depKey = session?.departmentKey || "";
  const serviceId = session?.serviceId || "";
  const serviceTitle = session?.customService || session?.serviceTitle || "";

  const base = {
    objective: "Gather clear project details without repeating what the customer already said.",
    enoughAfter: 4,
    mustNotAsk: [
      "Do not ask what service they need if a service was already selected.",
      "Do not ask for name, phone, email or address.",
      "Do not ask about budget, price or payment.",
      "Do not repeat a question if the answer already gives that detail."
    ],
    needed: [
      "site or property type",
      "exact work needed",
      "location",
      "size/quantity/scope if relevant",
      "photos/drawings/measurements if available"
    ]
  };

  const profiles = {
    building: {
      objective: "Understand the building or renovation work clearly.",
      enoughAfter: 4,
      needed: [
        "new build, renovation, repair, extension or installation",
        "property type: home, business, shop, office, warehouse or other",
        "project location",
        "important scope such as rooms, roof, wall, bathroom, kitchen or structure",
        "plans, photos or measurements if available"
      ]
    },
    civil: {
      objective: "Understand the civil works, paving, driveway, tar or concrete request.",
      enoughAfter: 4,
      needed: [
        "site type: home, business, road, driveway, yard, open space or construction site",
        "work needed: paving, tar surfacing, concrete, driveway, repairs or preparation",
        "surface condition, for example grass, soil, existing paving or damaged area",
        "approximate size or rough area",
        "location and whether photos are available"
      ]
    },
    boreholes: {
      objective: "Understand the borehole or water system request.",
      enoughAfter: 4,
      needed: [
        "new borehole or existing borehole support",
        "property location",
        "water use: home, business, farming, construction or other",
        "drilling only or drilling plus pump/tank setup",
        "site access or current water problem if known"
      ]
    },
    steel: {
      objective: "Understand the gate, steel, security or metal fabrication request.",
      enoughAfter: 4,
      needed: [
        "selected item such as gate, steel structure, metal door, trellis, window, frame or other",
        "property type: home, business, shop, warehouse or other",
        "new fabrication/installation, repair or replacement",
        "style/material preference such as steel, wood, glass, sliding, swing or modern design",
        "opening size, number of vehicles, measurements or photos if available"
      ],
      serviceSpecificWarning: "If the selected service is Gates, do not ask 'what steel or security item do you need?' because the item is already gates."
    },
    electrical: {
      objective: "Understand the electrical or solar request.",
      enoughAfter: 4,
      needed: [
        "new installation, repair, upgrade or maintenance",
        "site type: home, business or construction site",
        "location",
        "what they want to power or fix",
        "current setup such as ZESA, inverter, panels, batteries or DB board if known"
      ]
    },
    plumbing: {
      objective: "Understand the plumbing or water system request.",
      enoughAfter: 4,
      needed: [
        "new installation, repair, leak, drainage issue or upgrade",
        "affected area: bathroom, kitchen, outside, tank, borehole, drainage or other",
        "urgency or planned work",
        "problem description",
        "photos if available"
      ]
    },
    finishes: {
      objective: "Understand the finishes or interiors request.",
      enoughAfter: 4,
      needed: [
        "service needed: painting, tiling, ceilings, bathroom, kitchen or interior finishing",
        "property or room area",
        "number of rooms/areas",
        "design, colour, tile type or layout preference",
        "photos or measurements if available"
      ]
    },
    materials: {
      objective: "Understand the material supply request.",
      enoughAfter: 4,
      needed: [
        "material needed such as bricks, sand, stones, cement, quarry dust, putty powder or timber",
        "quantity or rough amount",
        "delivery or collection",
        "delivery location",
        "when materials are needed"
      ]
    }
  };

  const profile = profiles[depKey] || base;

  if (serviceTitle) {
    profile.selectedService = serviceTitle;
  }

  if (serviceId === "gates") {
    profile.needed = [
      "property type: home, business, shop, warehouse or other",
      "new gate installation, repair or replacement",
      "gate style/material preference: steel, wood, glass, sliding, swing or modern design",
      "opening size or how many vehicles should fit through",
      "photos, sketch or existing opening details if available"
    ];
    profile.enoughAfter = 4;
    profile.serviceSpecificWarning = "The selected service is Gates. Never ask what steel/security item they need. Start with property type or gate purpose.";
  }

  if (serviceId === "solar_installation" || serviceId === "solar_energy") {
    profile.needed = [
      "new installation, upgrade or repair",
      "location",
      "site type: home, business or construction site",
      "what should be powered: lights, fridge, TV, borehole pump, whole house, business equipment, etc.",
      "current setup if known: ZESA only, inverter, panels, batteries, or none"
    ];
    profile.enoughAfter = 4;
  }

  if (serviceId === "paving" || serviceId === "driveways") {
    profile.needed = [
      "site type: home, business or other",
      "new paving, repair, driveway or surface preparation",
      "current ground condition: grass, soil, existing paving, concrete or damaged area",
      "rough size/area or number of cars if known",
      "location and photos if available"
    ];
    profile.enoughAfter = 4;
  }

  return profile;
}

function extractJsonDecision(text) {
  const raw = String(text || "").trim();

  try {
    return JSON.parse(raw);
  } catch {}

  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  return null;
}

async function aiGatherNextStep(session) {
  const dep = session?.departmentKey ? departments[session.departmentKey]?.title || "" : "";
  const service = session?.customService || session?.serviceTitle || "";
  const previousAnswers = gatherAnswersText(session);
  const answerCount = countGatherAnswers(session);
  const lastAnswer = lastGatherAnswer(session);
  const localLanguageUsed = customerUsedLocalLanguage(lastAnswer);
  const profile = getGatherProfile(session);

  if (answerCount >= 5) {
    return {
      done: true,
      message: "⚙️ Perfect, I have enough project details now. I’ll prepare this clearly for the Hardercast team."
    };
  }

  const fallbackQuestions = {
    building: "What part of the building work should the team focus on first?",
    civil: "What is the rough size of the area, or how many cars can fit there?",
    boreholes: "Is this for home use, business use, farming or construction?",
    steel: session?.serviceId === "gates"
      ? "Is this a new gate installation, a repair, or a replacement?"
      : "Is this for a home or business property?",
    electrical: "What do you want the system to power or fix?",
    plumbing: "Which area is affected: bathroom, kitchen, outside, tank, borehole or drainage?",
    finishes: "Which room or area needs the finishing work?",
    materials: "What quantity or rough amount do you need?"
  };

  const fallback = normalizeServiceAiMessage(
    fallbackQuestions[session?.departmentKey] || "Please share one more important detail about the job.",
    localLanguageUsed
  );

  if (!DEEPSEEK_API_KEY) {
    return { done: false, message: fallback };
  }

  const system = `You are the Service Flow AI for Hardercast Construction.

You are NOT the general AI Assistant.
You collect project details only.

Core behaviour:
- Be logical and psychologically natural.
- Understand what the customer already said.
- Never ask repeated or similar questions.
- Never ask what service is needed when the selected service is already known.
- Ask only ONE main question at a time.
- If enough useful project information is gathered, stop asking and mark done.
- Do not collect contact details. The system will do that after you finish.
- Do not ask about budget, price, payment, deposit or money.

Language:
- Reply in English only by default.
- If the customer's last message includes Shona/Ndebele/mixed language, use only one tiny friendly phrase like "Zvakanaka," then continue in simple English.
- Do not write full Shona/Ndebele sentences.
- Do not use broken or awkward Shona.
- Never say long phrases like "Ndanzwa kuti..." or full Shona paragraphs.

Formatting:
- Start message with ⚙️
- Short WhatsApp style.
- No long paragraphs.
- No buttons.
- No markdown table.

You must return JSON only:
{
  "done": false,
  "message": "customer-facing message"
}

or:
{
  "done": true,
  "message": "short completion message"
}`;

  const prompt = `Selected department: ${dep}
Selected service: ${service}
Selected service id: ${session?.serviceId || ""}

Information we need:
${JSON.stringify(profile, null, 2)}

Previous customer answers:
${previousAnswers}

Last customer answer:
${lastAnswer || "None yet"}

Number of useful answers already captured: ${answerCount}

Task:
- Decide if enough project details have been gathered.
- Enough usually means 4 useful project details, or 3 very strong detailed answers.
- If not enough, ask the next BEST missing question only.
- Do not repeat anything already answered.
- If the selected service is Gates, do not ask what steel/security item they need.
- If the user said "not sure", accept it and move to the next useful detail.
- If enough, done=true and message should say we have enough details and will prepare it for the team.

Return JSON only.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ],
        temperature: 0.25,
        max_tokens: 300
      })
    });

    clearTimeout(timeout);

    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    const content =
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.delta?.content ||
      "";

    const decision = extractJsonDecision(content);

    let finalDecision = {
      done: false,
      message: fallback
    };

    if (decision && typeof decision === "object") {
      finalDecision.done = Boolean(decision.done);
      finalDecision.message = normalizeServiceAiMessage(decision.message || fallback, localLanguageUsed);
    }

    // Do not allow completion too early unless customer gave enough answers.
    if (answerCount < 3) {
      finalDecision.done = false;
    }

    logFile("ai-gather.log", {
      ok: response.ok,
      status: response.status,
      model: DEEPSEEK_MODEL,
      department: dep,
      service,
      answerCount,
      localLanguageUsed,
      decision: finalDecision,
      rawOutput: shortText(content || raw, 1000)
    });

    if (!response.ok || !content) {
      return { done: false, message: fallback };
    }

    return finalDecision;

  } catch (err) {
    clearTimeout(timeout);

    logFile("ai-gather.log", {
      ok: false,
      department: dep,
      service,
      answerCount,
      error: err.message
    });

    return { done: false, message: fallback };
  }
}

async function sendGatherComplete(to, session) {
  const service = session?.customService || session?.serviceTitle || "service";

  await sendText(to, `⚙️ Great, I have enough details for the *${service}* request.

I’ll now prepare it properly for the Hardercast team, then collect the contact details for follow-up.`);
}

// ===== HARDERCAST GATHER AI END =====

async function askNextServiceQuestion(to, session) {
  const step = await aiGatherNextStep(session);

  if (step.done) {
    await sendText(to, normalizeServiceAiMessage(step.message, customerUsedLocalLanguage(lastGatherAnswer(session))));
    await sendGatherComplete(to, session);
    await moveToContactPath(to, session);
    return;
  }

  await sendText(to, step.message);
}

async function sendTalkAdvisorIntro(to) {
  const companyInfo = `🏗️ *Hardercast Construction*

✨ *Build with confidence.*

*Main services*
• 🏠 Building & renovations
• 💧 Boreholes & civil works
• ⚡ Steel, security, electrical & solar
• 🚿 Plumbing, interiors & materials

*Connect*
• 🌐 Website: https://hardercastconstruction.co.zw/
• 📘 Facebook: Hardercast Construction`;

  try {
    await sendImageMessage(to, HARDERCAST_LOGO_URL, companyInfo);
  } catch (err) {
    logFile("send-errors.log", {
      kind: "advisor-logo",
      error: err.message
    });
    await sendText(to, companyInfo);
  }
}

async function startAdvisorFlow(to, session) {
  session.step = "advisor_waiting_message";
  session.route = "advisor_waiting_message";

  await sendTalkAdvisorIntro(to);

  await sendText(to, `👷 *Talk to the Team*

*Send your message now*
• Tell us what you need
• Add location or photos if helpful
• Your message will go straight to the Hardercast team

↩️ Type *menu* anytime to go back.`);
}


async function moveToContactPath(to, session) {
  const existing = getSavedContact(session.phone);

  if (existing) {
    session.step = "contact_existing_choice";

    await sendButtons(to, `I already have contact details saved for you:

${formatContactShort(existing)}

Would you like to continue with these details or use new contact details?`, [
      { id: "contact_existing", title: "Use Existing" },
      { id: "contact_new", title: "New Contact" },
      { id: "action_back_menu", title: "Menu" }
    ]);

    return;
  }

  session.step = "client_type";
  await sendButtons(to, `👤 *Client Type*

Before sending this to the Hardercast team:

• Are you enquiring as an individual or a company?`, [
    { id: "client_individual", title: "Individual" },
    { id: "client_company", title: "Company" }
  ]);
}

function formatContactShort(c) {
  if (!c) return "";
  if (c.clientType === "Company") {
    return `Company: ${c.companyName || ""}
Contact: ${c.contactPerson || ""}
Phone: ${c.contactPhone || ""}
Email: ${c.email || ""}
Address: ${c.address || ""}`;
  }

  return `Name: ${c.fullName || ""}
Phone: ${c.contactPhone || ""}
Email: ${c.email || ""}
Address: ${c.address || ""}`;
}


function getRawProjectAnswers(session) {
  return Object.entries(session?.answers || {})
    .map(([k, v], i) => `${i + 1}. ${String(v || "").trim()}`)
    .join("\n");
}

async function aiProjectSummary(session) {
  const dep = session?.departmentKey ? departments[session.departmentKey]?.title || "" : "";
  const service = session?.customService || session?.serviceTitle || "";
  const rawAnswers = getRawProjectAnswers(session);
  const contact = session?.contact || {};

  const fallback = `*Project request*
• Service: ${service}
• Department: ${dep}
• Details: ${rawAnswers || "Some details still need confirmation."}

*Client details*
${formatContactShort(contact)}`;

  if (!DEEPSEEK_API_KEY) return fallback;

  const system = `You are the Project Summary AI for Hardercast Construction.

Your job:
- Turn raw customer conversation into a clean professional project summary.
- Understand Shona, Ndebele, slang and mixed language, but write the summary in English.
- Do not include full Shona/Ndebele in the summary.
- Do not include confusing lines like "what are you saying" as a project detail.
- If something is unclear, write "Needs confirmation."
- Do not invent price, timeline, stock, technical guarantees or measurements.
- Do not ask questions in the summary.
- Use bold headings and bullets.
- Keep it polished and WhatsApp-friendly.
- This summary will be shown to the customer and sent to the Hardercast team.`;

  const prompt = `Department: ${dep}
Service: ${service}

Raw customer answers:
${rawAnswers || "No answers captured"}

Contact details:
${JSON.stringify(contact, null, 2)}

Create a clean summary in this exact style:

*Project request*
• Service:
• Location:
• Property/site:
• Work needed:
• Materials/design:
• Measurements/scope:
• Important notes:

*Client details*
• Type:
• Name/company:
• Contact person:
• Phone:
• Email:
• Address:

Rules:
- Use English.
- Clean up grammar.
- Summarise meaning, do not copy raw answers word for word.
- If a field is unknown, say "Needs confirmation".
- Return only the summary.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 520
      })
    });

    clearTimeout(timeout);

    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    const content =
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.delta?.content ||
      "";

    logFile("ai-summary.log", {
      ok: response.ok,
      status: response.status,
      department: dep,
      service,
      rawAnswers: shortText(rawAnswers, 900),
      output: shortText(content || raw, 1200)
    });

    if (!response.ok || !content) return fallback;

    return content.trim();

  } catch (err) {
    clearTimeout(timeout);

    logFile("ai-summary.log", {
      ok: false,
      department: dep,
      service,
      error: err.message
    });

    return fallback;
  }
}


function buildSummary(session) {
  const dep = departments[session.departmentKey];
  const service = session.customService || session.serviceTitle;
  const answers = Object.entries(session.answers || {})
    .map(([k, v], i) => `${i + 1}. ${v}`)
    .join("\n");

  return `Department: ${dep?.title || ""}
Service: ${service || ""}
Client need:
${answers || "Not provided"}

Client type: ${session.contact.clientType || ""}
${formatContactShort(session.contact)}`;
}

async function sendSummary(to, session) {
  session.step = "summary_action";

  const smartSummary = await aiProjectSummary(session);
  session.smartSummary = smartSummary;

  await sendButtons(to, `✅ *Request Summary*

Here is the clean summary that will be sent to the Hardercast team:

${smartSummary}

*What would you like to do next?*`, [
    { id: "action_send_request", title: "Send Request" },
    { id: "action_advisor", title: "Talk Advisor" },
    { id: "action_back_menu", title: "Menu" }
  ]);
}

function saveLead(session, status) {
  const leads = readJson("leads.json", []);

  const lead = {
    createdAt: new Date().toISOString(),
    status,
    customerPhone: session.phone,
    department: departments[session.departmentKey]?.title || "",
    service: session.customService || session.serviceTitle || "",
    answers: session.answers || {},
    contact: session.contact || {}
  };

  leads.push(lead);
  writeJson("leads.json", leads);
  return lead;
}

async function sendTeamAlert(session, status) {
  const lead = saveLead(session, status);

  const smartSummary = session.smartSummary || await aiProjectSummary(session);

  const alert = `👷 *New Hardercast Client Request*

*Status*
• ${status}

${smartSummary}

*Customer WhatsApp*
• ${maskPhone(session.phone)}

*Next step*
• Review and respond to the customer.`;

  logFile("team-alerts.log", {
    to: ALERT_TEAM,
    alert
  });

  await sendText(ALERT_TEAM, alert);
}

async function handleFlow(from, text) {
  const session = getSession(from);
  const t = String(text || "").trim().toLowerCase();

  if (isMenuCommand(t)) {
    resetSession(session);
    await sendNormalMenu(from);
    return "normal_menu_sent";
  }

  if (isGreeting(t)) {
    resetSession(session);
    await sendGreetingMenu(from);
    return "greeting_menu_sent";
  }

  if (!session.active) {
    logFile("ignored-unstarted.log", {
      from,
      text,
      note: "conversation not started because message was not a greeting"
    });
    return "ignored_until_greeting";
  }

  if (session.step === "main_menu") {
    if (t === "menu_departments" || t === "1" || t.includes("department") || t.includes("service")) {
      session.step = "department";
      await sendDepartmentMenu(from);
      return "department_menu_sent";
    }

    if (t === "menu_team" || t === "2" || t.includes("team")) {
      session.departmentKey = "building";
      session.serviceTitle = "Direct Team Communication";
      session.customService = "Direct team communication from main menu";
      session.answers = { need: "Client selected Talk to Team from the greeting/main menu." };
      await startAdvisorFlow(from, session);
      return "team_direct_contact_path";
    }

    if (t === "menu_ai" || t === "3" || t.includes("assistant") || t.includes("ai")) {
      session.step = "ai_assistant";
      await sendText(from, `⚙️ Hardercast AI Assistant

- Ask me general questions about Hardercast Construction.
- I can help with services, location, contact details and what the business offers.
- I will only answer from the Hardercast information I know.
- Type *menu* anytime to return to the main menu.`);

      return "ai_assistant_started";
    }

    await sendNormalMenu(from);
    return "main_menu_repeated";
  }

  if (session.step === "advisor_waiting_message") {
    const msg = String(text || "").trim();

    if (!msg) {
      await sendText(from, `👷 *Talk to the Team*

• Please type your message clearly.
• Example: I need roofing assistance in Borrowdale.

↩️ Type *menu* anytime to go back.`);
      return "advisor_empty_message";
    }

    const advisorMessages = readJson("advisor_messages.json", []);

    const saved = {
      createdAt: new Date().toISOString(),
      customerPhone: from,
      message: msg,
      route: "Talk to Team"
    };

    advisorMessages.push(saved);
    writeJson("advisor_messages.json", advisorMessages);

    const alert = `👷 *New Hardercast Team Message*

*Customer*
• ${maskPhone(from)}

*Message*
• ${msg}

*Next step*
• Review and respond to the customer.`;

    await sendText(ALERT_TEAM, alert);

    await sendText(from, `✅ *Message sent to the Hardercast team*

• Thank you, your message has been received
• A team member will review it and assist you
• You can send more details or photos here if needed

↩️ Type *menu* anytime to go back.`);

    session.step = "advisor_waiting_message";
    return "advisor_message_sent_to_team";
  }

  if (session.step === "ai_assistant") {
    session.answers = { aiQuestion: text };

    const aiAnswer = await aiBrain({
      mode: "general",
      userText: text,
      session
    });

    await sendText(from, aiAnswer + "\n\n- Type *menu* to return to the main menu.");

    // Stay inside AI Assistant for flowing conversation and memory.
    session.step = "ai_assistant";
    return "ai_assistant_answered";
  }

  if (session.step === "department") {
    if (t === "dep_advisor") {
      session.departmentKey = "building";
      session.serviceTitle = "Talk to Advisor";
      session.customService = "Client requested advisor from department menu";
      session.answers = { need: "Client requested direct advisor support." };
      await startAdvisorFlow(from, session);
      return "department_advisor_contact_path";
    }

    if (t === "dep_ai") {
      session.step = "ai_assistant";
      await sendText(from, `⚙️ Hardercast AI Assistant

- Ask me about Hardercast services, location, contact details or what the company offers.
- I will only answer from the Hardercast information I know.
- Type *menu* anytime to return to the main menu.`);

      return "department_ai_selected";
    }

    let depKey = null;

    if (t.startsWith("dep_")) depKey = t.replace("dep_", "");
    else if (/^[1-8]$/.test(t)) depKey = Object.keys(departments)[Number(t) - 1];

    if (!depKey || !departments[depKey]) {
      await sendDepartmentMenu(from);
      return "invalid_department";
    }

    session.departmentKey = depKey;
    session.step = "service";
    await sendDepartmentIntro(from, session);
    return "department_selected";
  }

  if (session.step === "service") {
    const dep = departments[session.departmentKey];
    let service = null;

    if (t.startsWith("svc_")) {
      const id = t.replace("svc_", "");
      service = dep.services.find(s => s[0] === id);
    } else {
      const n = Number(t);
      if (n >= 1 && n <= dep.services.length) service = dep.services[n - 1];
    }

    if (!service) {
      await sendDepartmentIntro(from, session);
      return "invalid_service";
    }

    session.serviceId = service[0];
    session.serviceTitle = service[1];

    if (session.serviceId === "advisor") {
      session.customService = "Talk to Advisor";
      session.answers = { need: `Client requested advisor under ${dep.title}.` };
      await startAdvisorFlow(from, session);
      return "service_advisor_contact_path";
    }

    if (session.serviceId === "other") {
      session.step = "custom_service";
      await sendText(from, `⚙️ *Other Service*\n\n• No problem. Please type the exact ${dep.title.toLowerCase()} service you need.\n• Write it in your own words, and I will guide you from there.`);
      return "custom_service_requested";
    }

    session.step = "after_service";
    await sendAfterService(from, session);
    return "service_selected";
  }

  if (session.step === "custom_service") {
    session.customService = text;
    session.serviceTitle = "Other Service";
    session.step = "after_service";
    await sendAfterService(from, session);
    return "custom_service_saved";
  }

  if (session.step === "after_service") {
    if (t === "action_continue" || t === "1" || t.includes("continue")) {
      session.step = "service_questions";
      session.questionIndex = 0;
      session.answers = {};
      await askNextServiceQuestion(from, session);
      return "smart_service_questions_started";
    }

    if (t === "action_advisor" || t === "2" || t.includes("advisor") || t.includes("team")) {
      session.answers = { need: `Client wants advisor for ${session.serviceTitle}.` };
      await startAdvisorFlow(from, session);
      return "advisor_contact_path";
    }

    if (t === "action_back" || t === "3" || t.includes("back")) {
      session.step = "service";
      await sendDepartmentIntro(from, session);
      return "back_to_services";
    }

    await sendAfterService(from, session);
    return "invalid_after_service";
  }

  if (session.step === "service_questions") {
    const key = "q" + (session.questionIndex + 1);
    session.answers[key] = text;
    session.questionIndex += 1;

    await askNextServiceQuestion(from, session);
    return "smart_service_question_saved";
  }

  if (session.step === "contact_existing_choice") {
    if (t === "contact_existing" || t === "1" || t.includes("existing")) {
      const existing = getSavedContact(session.phone);
      session.contact = existing || {};
      session.usedExistingContact = true;
      await sendSummary(from, session);
      return "existing_contact_used";
    }

    if (t === "contact_new" || t === "2" || t.includes("new")) {
      session.contact = {};
      session.usedExistingContact = false;
      session.step = "client_type";
      await sendButtons(from, `Are you enquiring as an individual or a company?`, [
        { id: "client_individual", title: "Individual" },
        { id: "client_company", title: "Company" }
      ]);
      return "new_contact_selected";
    }

    if (t === "action_back_menu") {
      resetSession(session);
      await sendNormalMenu(from);
      return "back_to_menu";
    }

    await moveToContactPath(from, session);
    return "invalid_contact_choice";
  }

  if (session.step === "client_type") {
    if (t === "client_individual" || t === "1" || t.includes("individual")) {
      session.clientType = "Individual";
      session.contact.clientType = "Individual";
      session.step = "contact_full_name";
      await sendText(from, `👤 *Your full name*

• Please send your full name.`);
      return "client_individual_selected";
    }

    if (t === "client_company" || t === "2" || t.includes("company")) {
      session.clientType = "Company";
      session.contact.clientType = "Company";
      session.step = "contact_company_name";
      await sendText(from, `🏢 *Company name*

• Please send the company name.`);
      return "client_company_selected";
    }

    await sendButtons(from, `Please choose one option.`, [
      { id: "client_individual", title: "Individual" },
      { id: "client_company", title: "Company" }
    ]);
    return "invalid_client_type";
  }

  if (session.step === "contact_company_name") {
    session.contact.companyName = text;
    session.step = "contact_person";
    await sendText(from, `👤 *Contact person*

• Please send the contact person's full name.`);
    return "company_name_saved";
  }

  if (session.step === "contact_person") {
    session.contact.contactPerson = text;
    session.step = "contact_phone";
    await sendText(from, `📞 *Contact number*

• Please send the best phone number to contact.`);
    return "contact_person_saved";
  }

  if (session.step === "contact_full_name") {
    session.contact.fullName = text;
    session.step = "contact_phone";
    await sendText(from, `📞 *Contact number*

• Please send the best phone number to contact.`);
    return "full_name_saved";
  }

  if (session.step === "contact_phone") {
    session.contact.contactPhone = text;
    session.step = "contact_email";
    await sendText(from, `📧 *Email address*

• Please send your email address
• If you do not have one, reply *none*.`);
    return "contact_phone_saved";
  }

  if (session.step === "contact_email") {
    session.contact.email = text;
    session.step = "contact_address";
    await sendText(from, `📍 *Project address*

• Please send the physical address or project location.`);
    return "contact_email_saved";
  }

  if (session.step === "contact_address") {
    session.contact.address = text;
    saveContact(session.phone, session.contact);
    await sendSummary(from, session);
    return "contact_saved_summary_sent";
  }

  if (session.step === "summary_action") {
    if (t === "action_send_request" || t === "1" || t.includes("send")) {
      await sendTeamAlert(session, "Client confirmed request");
      session.step = "done";
      await sendText(from, `✅ *Request sent successfully*

• The Hardercast team has received your request
• A team member will review it and contact you with the next step

↩️ Type *menu* to return to the main menu.`);
      return "request_sent_to_team";
    }

    if (t === "action_advisor" || t === "2" || t.includes("advisor") || t.includes("team")) {
      await sendTeamAlert(session, "Client wants to talk to advisor");
      session.step = "done";
      await sendText(from, `👷 *Advisor request sent*

• Your request has been sent to a Hardercast advisor
• A team member will review and assist you shortly

↩️ Type *menu* to return to the main menu.`);
      return "advisor_alert_sent";
    }

    if (t === "action_back_menu" || t === "3" || t.includes("menu")) {
      resetSession(session);
      await sendNormalMenu(from);
      return "back_to_menu";
    }

    await sendSummary(from, session);
    return "invalid_summary_action";
  }

  if (t === "action_back_menu") {
    resetSession(session);
    await sendNormalMenu(from);
    return "back_to_menu";
  }

  await sendText(from, `↩️ Type *menu* to start again.`);
  return "fallback";
}

app.get("/health/hardercast-construction", (req, res) => {
  res.json({
    ok: true,
    bot: "Hardercast Construction",
    port: PORT,
    botNumber: BOT_NUMBER,
    allowedCustomer: TEST_CUSTOMER,
    allowedCustomers: ALLOWED_CUSTOMERS,
    contactBlocking: "removed - accepts all customers",
    allowAllCustomers: true,
    alertTeam: ALERT_TEAM,
    outbound: YCLOUD_API_KEY ? "enabled" : "missing",
    aiBrain: DEEPSEEK_API_KEY ? "enabled" : "missing",
    aiModel: DEEPSEEK_MODEL,
    aiAssistantMode: "knowledge-only flowing chat with memory",
    gatheringAI: "enabled separate flowing service-detail collector",
    summaryAI: "enabled clean project summaries",
    smartGatherAI: "adaptive no-repeat question logic",
    replyLanguageRule: "English by default, tiny local phrase only when user uses local language",
    languageMode: "understands local language, replies mostly English",
    aiEmoji: "⚙️",
    theme: "professional-construction-flow",
    autoTestSend: "disabled",
    startRule: "greeting starts full menu, menu/start opens short menu",
    signatureLogs: "silent",
    statusUpdates: "ignored silently"
  });
});

app.get("/debug/hardercast-last", (req, res) => {
  function lastLines(file, n = 10) {
    const fp = path.join(LOG_DIR, file);
    if (!fs.existsSync(fp)) return [];
    return fs.readFileSync(fp, "utf8").trim().split("\n").filter(Boolean).slice(-n);
  }

  res.json({
    ok: true,
    bot: "Hardercast Construction",
    now: new Date().toISOString(),
    inbound: lastLines("inbound.log", 5),
    replies: lastLines("bot-replies.log", 5),
    outbound: lastLines("outbound.log", 5),
    teamAlerts: lastLines("team-alerts.log", 5),
    sendErrors: lastLines("send-errors.log", 5),
    signatureWarnings: lastLines("signature-warnings.log", 5),
    statusUpdates: lastLines("status-updates.log", 5),
    blocked: lastLines("blocked-contacts.log", 5),
    debugWebhook: lastLines("debug-webhook.log", 5)
  });
});

app.post("/webhooks/hardercast-construction", async (req, res) => {
  rawWebhookDebug(req);

  if (!shouldHardercastHandleWebhook(req.body)) {
    logFile("ignored-non-hardercast-number.log", {
      target: targetBotNumber(),
      recipient: extractWebhookRecipient(req.body),
      body: req.body
    });
    return res.status(200).json({ ok: true, ignored: "not-hardercast-number" });
  }


  // Reply to YCloud immediately so the webhook is fast.
  res.status(200).json({ ok: true });

  const requestId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);

  try {
    const debugInfo = extractDebugInfo(req.body);
    const eventType = String(debugInfo.possibleType || "").toLowerCase();

    // Ignore YCloud delivery/read/status updates silently.
    // These are not customer messages.
    if (
      eventType.includes("updated") ||
      eventType.includes("status") ||
      eventType.includes("delivered") ||
      eventType.includes("read")
    ) {
      logFile("status-updates.log", {
        requestId,
        type: debugInfo.possibleType,
        note: "YCloud delivery/status update ignored silently"
      });
      return;
    }

    const inbound = parseInbound(req.body);
    const from = inbound.from;
    const text = inbound.text || "";

    logFile("debug-webhook.log", {
      requestId,
      type: debugInfo.possibleType,
      parsedFrom: from,
      parsedText: text
    });

    if (!from) {
      logFile("events.log", {
        requestId,
        note: "no sender detected",
        type: debugInfo.possibleType,
        rawPreview: debugInfo.rawPreview
      });
      return;
    }

    // Blocking removed: accept all customers.

    logFile("inbound.log", {
      requestId,
      from,
      to: BOT_NUMBER,
      text,
      type: debugInfo.possibleType
    });

    console.log("========== HARDERCAST CUSTOMER ==========");
    console.log("FROM:", maskPhone(from));
    console.log("TO:", maskPhone(BOT_NUMBER));
    console.log("MESSAGE:", shortText(text || "[empty]"));

    const startedAt = Date.now();
    const action = await handleFlow(from, text);
    const ms = Date.now() - startedAt;

    logFile("bot-replies.log", {
      requestId,
      from,
      to: from,
      botNumber: BOT_NUMBER,
      text,
      action,
      ms
    });

    console.log("ACTION:", action);
    console.log("TIME:", ms + "ms");
    console.log("STATUS: completed");

  } catch (err) {
    console.error("HARDERCAST ERROR:", err.message);
    logFile("errors.log", {
      requestId,
      error: err.message,
      stack: err.stack
    });
  }
});


app.post("/webhooks/hardercast-catchall", async (req, res) => {
  res.status(200).json({ ok: true, catchall: true });

  try {
    logFile("ycloud-catchall.log", {
      time: new Date().toISOString(),
      headers: req.headers,
      body: req.body
    });

    console.log("===== YCLOUD CATCHALL EVENT =====");
    console.log(JSON.stringify(req.body).slice(0, 1200));
  } catch (err) {
    logFile("ycloud-catchall-errors.log", {
      error: err.message,
      stack: err.stack
    });
  }
});


app.post("/test/send-hi", async (req, res) => {
  return res.json({
    ok: true,
    disabled: true,
    message: "Auto test sending is disabled. Customer must send a greeting first."
  });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Hardercast professional construction bot running on 127.0.0.1:${PORT}`);
});
