const path = require('path');
const fs = require('fs-extra');

require('dotenv').config({ quiet: true });

const ROOT_DIR = __dirname;
const QUESTIONS_DIR = path.join(ROOT_DIR, 'questions');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');
const TEMPLATE_FILE = path.join(QUESTIONS_DIR, 'templates.json');
const UNMATCHED_FILE = path.join(DATA_DIR, 'unmatched-questions.json');
const DEFAULT_USER_STATE = {
  hasSeenMenu: false,
  expectsMenuSelection: true,
  lastMenuShownAt: null,
  lastSelectedMenuNumber: null,
  lastSelectedTemplateId: null,
};
const MENU_KEYWORDS = new Set([
  'menu',
  'daftar',
  'list',
  'pilihan',
  'bantuan',
  'help',
  'halo',
  'hai',
  'hi',
  'start',
  'mulai',
]);

const DEFAULT_TEMPLATES = [
  {
    id: 'jam-operasional',
    label: 'Jam operasional',
    question: 'Jam operasional toko kapan?',
    answer: 'Jam operasional kami Senin sampai Jumat, pukul 09.00 sampai 17.00 WIB.',
  },
];

const EMPTY_TEMPLATE_REPLY =
  'Daftar pertanyaan masih kosong. Isi file questions/templates.json dulu ya, supaya bot bisa mengirim menu.';
const TEMPLATE_ERROR_REPLY =
  'File template sedang bermasalah. Cek questions/templates.json dulu ya.';

let waModule = null;
let qrModule = null;

function getWhatsAppModule() {
  if (!waModule) {
    waModule = require('whatsapp-web.js');
  }

  return waModule;
}

function getQrModule() {
  if (!qrModule) {
    qrModule = require('qrcode-terminal');
  }

  return qrModule;
}

function normalizeText(text = '') {
  return text
    .toString()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeFileName(value = '') {
  return value.replace(/[^\w-]/g, '_');
}

function getFirstName(name = '') {
  return name.trim().split(/\s+/)[0] || '';
}

function getTemplateLabel(template) {
  if (typeof template.label === 'string' && template.label.trim()) {
    return template.label.trim();
  }

  return template.question.trim();
}

function formatMenuList(templates) {
  return templates
    .map((template, index) => `${index + 1}. ${getTemplateLabel(template)}`)
    .join('\n');
}

function buildMenuMessage({ contactName, templates, variant = 'menu' }) {
  const firstName = getFirstName(contactName);
  const menuList = formatMenuList(templates);

  if (variant === 'welcome') {
    const greeting = firstName ? `Halo ${firstName}!` : 'Halo!';

    return [
      greeting,
      'Aku siap bantu lewat daftar pertanyaan berikut:',
      '',
      menuList,
      '',
      'Balas dengan angka pilihan, misalnya 1.',
      'Ketik MENU kapan saja kalau mau lihat daftarnya lagi.',
    ].join('\n');
  }

  return [
    'Berikut daftar pertanyaan yang tersedia:',
    '',
    menuList,
    '',
    'Balas dengan angka pilihan, misalnya 1.',
  ].join('\n');
}

function buildSelectionReply({ template, selectedMenuNumber }) {
  return [
    `Pilihan ${selectedMenuNumber}: ${getTemplateLabel(template)}`,
    '',
    template.answer.trim(),
    '',
    'Kalau masih mau cek topik lain, balas angka lain atau ketik MENU.',
  ].join('\n');
}

function buildInvalidSelectionReply(templates) {
  return [
    'Nomor itu belum ada di daftar.',
    'Silakan pilih angka yang tersedia ya.',
    '',
    buildMenuMessage({ templates, variant: 'menu' }),
  ].join('\n');
}

function buildRedirectToMenuReply(templates) {
  return [
    'Supaya lebih cepat, balas dengan angka dari daftar berikut ya.',
    '',
    buildMenuMessage({ templates, variant: 'menu' }),
  ].join('\n');
}

function isMenuRequest(messageText) {
  const words = normalizeText(messageText).split(' ').filter(Boolean);

  return words.some((word) => MENU_KEYWORDS.has(word));
}

function parseSelectedMenuNumber(messageText) {
  const rawText = messageText.trim();

  if (!/^\d+$/.test(rawText)) {
    return null;
  }

  return Number(rawText);
}

function getTemplateByMenuNumber(templates, selectedMenuNumber) {
  if (!Number.isInteger(selectedMenuNumber) || selectedMenuNumber < 1) {
    return null;
  }

  return templates[selectedMenuNumber - 1] || null;
}

function createUserFilePath(chatId) {
  return path.join(USERS_DIR, `${sanitizeFileName(chatId)}.json`);
}

function createDefaultUserRecord(chatId, contactName) {
  const now = new Date().toISOString();

  return {
    chatId,
    contactName: contactName || null,
    createdAt: now,
    lastSeenAt: now,
    state: { ...DEFAULT_USER_STATE },
    messages: [],
  };
}

async function loadUserRecord(chatId, contactName) {
  const userFile = createUserFilePath(chatId);

  if (!(await fs.pathExists(userFile))) {
    return createDefaultUserRecord(chatId, contactName);
  }

  try {
    const userRecord = await fs.readJson(userFile);

    return {
      ...createDefaultUserRecord(chatId, contactName),
      ...userRecord,
      chatId,
      contactName: contactName || userRecord.contactName || null,
      state: {
        ...DEFAULT_USER_STATE,
        ...(userRecord.state || {}),
      },
      messages: Array.isArray(userRecord.messages) ? userRecord.messages : [],
    };
  } catch (error) {
    console.error(
      `File data user rusak, dibuat ulang: ${path.relative(ROOT_DIR, userFile)}`,
    );

    return createDefaultUserRecord(chatId, contactName);
  }
}

async function ensureBaseFiles() {
  await fs.ensureDir(QUESTIONS_DIR);
  await fs.ensureDir(DATA_DIR);
  await fs.ensureDir(USERS_DIR);
  await fs.ensureDir(SESSIONS_DIR);

  if (!(await fs.pathExists(TEMPLATE_FILE))) {
    await fs.writeJson(TEMPLATE_FILE, DEFAULT_TEMPLATES, { spaces: 2 });
  }

  if (!(await fs.pathExists(UNMATCHED_FILE))) {
    await fs.writeJson(UNMATCHED_FILE, [], { spaces: 2 });
  }
}

async function loadTemplates() {
  const rawTemplates = await fs.readJson(TEMPLATE_FILE);

  if (!Array.isArray(rawTemplates)) {
    throw new Error('questions/templates.json harus berupa array JSON.');
  }

  return rawTemplates
    .filter(
      (item) =>
        item &&
        typeof item.question === 'string' &&
        typeof item.answer === 'string',
    )
    .map((item, index) => {
      const question = item.question.trim();

      return {
        id: item.id || `template-${index + 1}`,
        label:
          typeof item.label === 'string' && item.label.trim()
            ? item.label.trim()
            : question,
        question,
        answer: item.answer.trim(),
        order: Number.isInteger(item.order) ? item.order : index + 1,
      };
    })
    .sort((firstTemplate, secondTemplate) => firstTemplate.order - secondTemplate.order);
}

async function getReplyData({ messageText, contactName, userState }) {
  try {
    const templates = await loadTemplates();

    if (templates.length === 0) {
      return {
        status: 'empty',
        replyText: EMPTY_TEMPLATE_REPLY,
        selectedTemplate: null,
        selectedMenuNumber: null,
        shouldSaveUnmatched: false,
        nextState: { ...userState },
      };
    }

    const selectedMenuNumber = parseSelectedMenuNumber(messageText);

    if (selectedMenuNumber !== null) {
      const selectedTemplate = getTemplateByMenuNumber(templates, selectedMenuNumber);

      if (selectedTemplate) {
        return {
          status: 'selected',
          replyText: buildSelectionReply({ template: selectedTemplate, selectedMenuNumber }),
          selectedTemplate,
          selectedMenuNumber,
          shouldSaveUnmatched: false,
          nextState: {
            hasSeenMenu: true,
            expectsMenuSelection: true,
            lastMenuShownAt: userState.lastMenuShownAt,
            lastSelectedMenuNumber: selectedMenuNumber,
            lastSelectedTemplateId: selectedTemplate.id,
          },
        };
      }

      return {
        status: 'invalid_selection',
        replyText: buildInvalidSelectionReply(templates),
        selectedTemplate: null,
        selectedMenuNumber,
        shouldSaveUnmatched: false,
        nextState: {
          hasSeenMenu: true,
          expectsMenuSelection: true,
          lastMenuShownAt: new Date().toISOString(),
          lastSelectedMenuNumber: userState.lastSelectedMenuNumber,
          lastSelectedTemplateId: userState.lastSelectedTemplateId,
        },
      };
    }

    const menuRequested = isMenuRequest(messageText);

    if (!userState.hasSeenMenu) {
      return {
        status: 'welcome_menu',
        replyText: buildMenuMessage({
          contactName,
          templates,
          variant: 'welcome',
        }),
        selectedTemplate: null,
        selectedMenuNumber: null,
        shouldSaveUnmatched: !menuRequested,
        nextState: {
          hasSeenMenu: true,
          expectsMenuSelection: true,
          lastMenuShownAt: new Date().toISOString(),
          lastSelectedMenuNumber: userState.lastSelectedMenuNumber,
          lastSelectedTemplateId: userState.lastSelectedTemplateId,
        },
      };
    }

    if (menuRequested) {
      return {
        status: 'menu',
        replyText: buildMenuMessage({ templates, variant: 'menu' }),
        selectedTemplate: null,
        selectedMenuNumber: null,
        shouldSaveUnmatched: false,
        nextState: {
          hasSeenMenu: true,
          expectsMenuSelection: true,
          lastMenuShownAt: new Date().toISOString(),
          lastSelectedMenuNumber: userState.lastSelectedMenuNumber,
          lastSelectedTemplateId: userState.lastSelectedTemplateId,
        },
      };
    }

    return {
      status: 'menu_redirect',
      replyText: buildRedirectToMenuReply(templates),
      selectedTemplate: null,
      selectedMenuNumber: null,
      shouldSaveUnmatched: true,
      nextState: {
        hasSeenMenu: true,
        expectsMenuSelection: true,
        lastMenuShownAt: new Date().toISOString(),
        lastSelectedMenuNumber: userState.lastSelectedMenuNumber,
        lastSelectedTemplateId: userState.lastSelectedTemplateId,
      },
    };
  } catch (error) {
    console.error('Gagal membaca template pertanyaan:', error.message);

    return {
      status: 'template_error',
      replyText: TEMPLATE_ERROR_REPLY,
      selectedTemplate: null,
      selectedMenuNumber: null,
      shouldSaveUnmatched: false,
      nextState: { ...userState },
    };
  }
}

async function saveUserConversation({
  userRecord,
  message,
  contactName,
  replyData,
}) {
  const userFile = createUserFilePath(message.from);
  const now = new Date().toISOString();
  const updatedUserRecord = {
    ...userRecord,
    chatId: message.from,
    contactName: contactName || userRecord.contactName || null,
    lastSeenAt: now,
    state: {
      ...DEFAULT_USER_STATE,
      ...(userRecord.state || {}),
      ...(replyData.nextState || {}),
    },
    messages: Array.isArray(userRecord.messages) ? [...userRecord.messages] : [],
  };

  updatedUserRecord.messages.push({
    messageId: message.id?._serialized || null,
    text: message.body,
    normalizedText: normalizeText(message.body),
    receivedAt: now,
    whatsappTimestamp: message.timestamp || null,
    selectedTemplateId: replyData.selectedTemplate?.id || null,
    selectedMenuNumber: replyData.selectedMenuNumber || null,
    replyText: replyData.replyText,
    status: replyData.status,
  });

  await fs.writeJson(userFile, updatedUserRecord, { spaces: 2 });
}

async function saveUnmatchedQuestion({ message, contactName }) {
  const now = new Date().toISOString();
  let payload = [];

  if (await fs.pathExists(UNMATCHED_FILE)) {
    try {
      const currentData = await fs.readJson(UNMATCHED_FILE);

      if (Array.isArray(currentData)) {
        payload = currentData;
      }
    } catch (error) {
      console.error('Gagal membaca file unmatched questions, file akan dibuat ulang.');
    }
  }

  payload.push({
    chatId: message.from,
    contactName: contactName || null,
    text: message.body,
    normalizedText: normalizeText(message.body),
    receivedAt: now,
  });

  await fs.writeJson(UNMATCHED_FILE, payload, { spaces: 2 });
}

async function resolveContactName(message) {
  try {
    const contact = await message.getContact();

    return (
      contact.pushname ||
      contact.name ||
      contact.shortName ||
      contact.id?.user ||
      null
    );
  } catch (error) {
    return null;
  }
}

async function handleIncomingMessage(message) {
  if (message.fromMe) {
    return;
  }

  if (message.from === 'status@broadcast') {
    return;
  }

  if (message.type !== 'chat') {
    return;
  }

  if (!message.body || !message.body.trim()) {
    return;
  }

  if (message.from.endsWith('@g.us')) {
    return;
  }

  const contactName = await resolveContactName(message);
  const userRecord = await loadUserRecord(message.from, contactName);

  console.log(`[MSG] ${contactName || message.from}: ${message.body}`);

  const replyData = await getReplyData({
    messageText: message.body,
    contactName,
    userState: userRecord.state,
  });

  await message.reply(replyData.replyText);

  await saveUserConversation({
    userRecord,
    message,
    contactName,
    replyData,
  });

  if (replyData.shouldSaveUnmatched) {
    await saveUnmatchedQuestion({ message, contactName });
  }
}

function createClient() {
  const { Client, LocalAuth } = getWhatsAppModule();

  return new Client({
    authStrategy: new LocalAuth({
      clientId: process.env.WA_CLIENT_ID || 'local-bot',
      dataPath: SESSIONS_DIR,
    }),
    puppeteer: {
      headless: process.env.WA_HEADLESS === 'true',
    },
    qrMaxRetries: 0,
  });
}

function registerClientEvents(client) {
  client.on('qr', (qr) => {
    console.log('\nScan QR ini dari WhatsApp > Linked devices > Link a device.\n');
    getQrModule().generate(qr, { small: true });
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`[Loading ${percent}%] ${message}`);
  });

  client.on('authenticated', () => {
    console.log('Autentikasi WhatsApp berhasil.');
  });

  client.on('ready', () => {
    const connectedId =
      client.info?.wid?._serialized || client.info?.wid?.user || 'unknown';

    console.log(`Bot siap digunakan sebagai ${connectedId}.`);
    console.log(`Template pertanyaan: ${TEMPLATE_FILE}`);
    console.log(`Data user tersimpan di: ${USERS_DIR}`);
    console.log(`Session WhatsApp tersimpan di: ${SESSIONS_DIR}`);
  });

  client.on('auth_failure', (message) => {
    console.error('Autentikasi gagal:', message);
  });

  client.on('disconnected', (reason) => {
    console.warn('Client terputus:', reason);
  });

  client.on('message', (message) => {
    handleIncomingMessage(message).catch((error) => {
      console.error('Gagal memproses pesan masuk:', error);
    });
  });
}

async function shutdown(client, signal) {
  console.log(`Menerima ${signal}, bot akan ditutup...`);

  try {
    await client.destroy();
  } catch (error) {
    console.error('Gagal menutup client dengan bersih:', error.message);
  } finally {
    process.exit(0);
  }
}

async function bootstrap() {
  await ensureBaseFiles();

  const client = createClient();
  registerClientEvents(client);

  await client.initialize();

  return client;
}

if (require.main === module) {
  bootstrap()
    .then((client) => {
      process.on('SIGINT', () => {
        shutdown(client, 'SIGINT');
      });

      process.on('SIGTERM', () => {
        shutdown(client, 'SIGTERM');
      });
    })
    .catch((error) => {
      console.error('Bot gagal dijalankan:', error);
      process.exit(1);
    });
}

module.exports = {
  bootstrap,
  buildMenuMessage,
  createClient,
  ensureBaseFiles,
  getReplyData,
  normalizeText,
  parseSelectedMenuNumber,
};
