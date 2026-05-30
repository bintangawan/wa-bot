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
  currentPath: [],
  lastMenuShownAt: null,
  lastSelectedMenuNumber: null,
  lastSelectedNodeId: null,
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
    id: 'informasi-umum',
    label: 'Informasi Umum',
    children: [
      {
        id: 'jam-operasional',
        label: 'Jam Operasional',
        intro: 'Pilih jenis jadwal yang ingin kamu lihat.',
        children: [
          {
            id: 'jam-hari-kerja',
            label: 'Hari Kerja',
            answer:
              'Jam operasional kami untuk hari kerja adalah Senin sampai Jumat, pukul 09.00 sampai 17.00 WIB.',
          },
          {
            id: 'jam-akhir-pekan',
            label: 'Akhir Pekan',
            answer:
              'Untuk saat ini layanan akhir pekan masih tutup. Kalau ada perubahan jadwal, kami akan update lagi ya.',
          },
        ],
      },
      {
        id: 'lokasi-toko',
        label: 'Lokasi Toko',
        answer:
          'Toko kami berada di Jalan Contoh No. 123, Jakarta. Kalau perlu titik maps, nanti tinggal dibagikan oleh admin.',
      },
    ],
  },
  {
    id: 'pemesanan',
    label: 'Pemesanan',
    children: [
      {
        id: 'cara-order',
        label: 'Cara Order',
        intro: 'Pilih metode order yang paling sesuai.',
        children: [
          {
            id: 'order-via-whatsapp',
            label: 'Order via WhatsApp',
            answer:
              'Untuk order via WhatsApp, kirim nama produk, jumlah pesanan, dan alamat lengkap. Setelah itu admin akan bantu proses pesanan kamu.',
          },
          {
            id: 'order-ke-toko',
            label: 'Order ke Toko Langsung',
            answer:
              'Kalau mau order langsung, kamu bisa datang ke toko pada jam operasional. Tim kami akan bantu cek stok dan proses pembelian.',
          },
        ],
      },
      {
        id: 'pembayaran',
        label: 'Pembayaran',
        answer:
          'Pembayaran bisa dilakukan melalui transfer bank atau metode lain yang diinformasikan admin saat pesanan diproses.',
      },
    ],
  },
];

const EMPTY_TEMPLATE_REPLY =
  'Menu pertanyaan masih kosong. Isi file questions/templates.json dulu ya, supaya bot bisa menampilkan daftar menu.';
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

function getNodeLabel(node) {
  if (typeof node?.label === 'string' && node.label.trim()) {
    return node.label.trim();
  }

  if (typeof node?.question === 'string' && node.question.trim()) {
    return node.question.trim();
  }

  return 'Tanpa Judul';
}

function normalizeMenuTree(rawItems) {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  return rawItems
    .map((item, index) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const label = getNodeLabel(item);
      const children = normalizeMenuTree(item.children);
      const rawAnswer =
        typeof item.answer === 'string' && item.answer.trim()
          ? item.answer.trim()
          : null;
      const intro =
        typeof item.intro === 'string' && item.intro.trim()
          ? item.intro.trim()
          : children.length > 0
            ? rawAnswer
            : null;
      const answer = children.length === 0 ? rawAnswer : null;

      if (!label || (!answer && children.length === 0)) {
        return null;
      }

      return {
        id: item.id || `menu-${index + 1}`,
        label,
        intro,
        answer,
        order: Number.isInteger(item.order) ? item.order : index + 1,
        children,
      };
    })
    .filter(Boolean)
    .sort((firstItem, secondItem) => firstItem.order - secondItem.order);
}

function createUserFilePath(chatId) {
  return path.join(USERS_DIR, `${sanitizeFileName(chatId)}.json`);
}

async function resolveExistingUserFilePath(chatId, legacyChatIds = []) {
  const primaryFile = createUserFilePath(chatId);

  if (await fs.pathExists(primaryFile)) {
    return primaryFile;
  }

  for (const legacyChatId of legacyChatIds) {
    if (!legacyChatId || legacyChatId === chatId) {
      continue;
    }

    const legacyFile = createUserFilePath(legacyChatId);

    if (await fs.pathExists(legacyFile)) {
      return legacyFile;
    }
  }

  return primaryFile;
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

function sanitizePath(tree, rawPath) {
  if (!Array.isArray(rawPath)) {
    return [];
  }

  const safePath = [];
  let currentItems = tree;

  for (const rawIndex of rawPath) {
    if (!Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= currentItems.length) {
      return [];
    }

    const currentNode = currentItems[rawIndex];

    if (!currentNode || !Array.isArray(currentNode.children) || currentNode.children.length === 0) {
      return [];
    }

    safePath.push(rawIndex);
    currentItems = currentNode.children;
  }

  return safePath;
}

function getNodeByPath(tree, rawPath) {
  if (!Array.isArray(rawPath) || rawPath.length === 0) {
    return null;
  }

  let currentItems = tree;
  let currentNode = null;

  for (const rawIndex of rawPath) {
    if (!Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= currentItems.length) {
      return null;
    }

    currentNode = currentItems[rawIndex];
    currentItems = currentNode.children || [];
  }

  return currentNode;
}

function getMenuItems(tree, rawPath) {
  const safePath = sanitizePath(tree, rawPath);

  if (safePath.length === 0) {
    return tree;
  }

  return getNodeByPath(tree, safePath)?.children || [];
}

function getPathLabels(tree, rawPath) {
  if (!Array.isArray(rawPath)) {
    return [];
  }

  const labels = [];
  let currentItems = tree;

  for (const rawIndex of rawPath) {
    if (!Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= currentItems.length) {
      return [];
    }

    const currentNode = currentItems[rawIndex];
    labels.push(getNodeLabel(currentNode));
    currentItems = currentNode.children || [];
  }

  return labels;
}

function formatMenuList(items, includeBackToMain) {
  const lines = items.map((item, index) => `${index + 1}. ${getNodeLabel(item)}`);

  if (includeBackToMain) {
    lines.push('0. Kembali ke menu utama');
  }

  return lines.join('\n');
}

function buildMenuMessage({ contactName, tree, path = [], variant = 'menu', leadText = null }) {
  const safePath = sanitizePath(tree, path);
  const currentNode = getNodeByPath(tree, safePath);
  const items = getMenuItems(tree, safePath);
  const depth = safePath.length;
  const breadcrumb = getPathLabels(tree, safePath).join(' > ');
  const firstName = getFirstName(contactName);
  const lines = [];

  if (leadText) {
    lines.push(leadText);
    lines.push('');
  }

  if (variant === 'welcome') {
    lines.push(firstName ? `Halo ${firstName}!` : 'Halo!');
    lines.push('Silakan pilih menu utama yang ingin kamu lihat:');
  } else if (depth === 0) {
    lines.push('Silakan pilih menu utama yang tersedia:');
  } else {
    lines.push(`Kamu sedang berada di: ${breadcrumb}`);
  }

  if (currentNode?.intro) {
    lines.push('');
    lines.push(currentNode.intro);
  }

  lines.push('');
  lines.push(formatMenuList(items, depth > 0));
  lines.push('');

  if (depth > 0) {
    lines.push('Balas dengan angka pilihan, atau ketik 0 untuk kembali ke menu utama.');
  } else {
    lines.push('Balas dengan angka pilihan.');
  }

  lines.push('Ketik MENU kapan saja kalau mau mulai lagi dari menu utama.');

  return lines.join('\n');
}

function buildAnswerReply({ tree, currentPath, selectedNode, selectedMenuNumber }) {
  const selectedPath = [...currentPath, selectedMenuNumber - 1];
  const breadcrumb = getPathLabels(tree, selectedPath).join(' > ');
  const lines = [
    `Pilihan ${selectedMenuNumber}: ${breadcrumb}`,
    '',
    selectedNode.answer,
    '',
  ];

  if (currentPath.length > 0) {
    lines.push('Balas angka lain dari submenu ini, atau ketik 0 untuk kembali ke menu utama.');
  } else {
    lines.push('Balas angka lain dari menu utama, atau ketik MENU untuk melihat daftar lagi.');
  }

  return lines.join('\n');
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

  return normalizeMenuTree(rawTemplates);
}

async function loadUserRecord(chatId, contactName, legacyChatIds = []) {
  const userFile = await resolveExistingUserFilePath(chatId, legacyChatIds);

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

async function getReplyData({ messageText, contactName, userState }) {
  try {
    const tree = await loadTemplates();

    if (tree.length === 0) {
      return {
        status: 'empty',
        replyText: EMPTY_TEMPLATE_REPLY,
        selectedNode: null,
        selectedMenuNumber: null,
        shouldSaveUnmatched: false,
        nextState: { ...userState, currentPath: [] },
        activePath: [],
        activePathLabels: [],
      };
    }

    const now = new Date().toISOString();
    const currentPath = sanitizePath(tree, userState.currentPath);
    const selectedMenuNumber = parseSelectedMenuNumber(messageText);
    const menuRequested = isMenuRequest(messageText);

    if (!userState.hasSeenMenu) {
      return {
        status: 'welcome_menu',
        replyText: buildMenuMessage({
          contactName,
          tree,
          path: [],
          variant: 'welcome',
        }),
        selectedNode: null,
        selectedMenuNumber: null,
        shouldSaveUnmatched: !menuRequested && selectedMenuNumber === null,
        nextState: {
          hasSeenMenu: true,
          currentPath: [],
          lastMenuShownAt: now,
          lastSelectedMenuNumber: userState.lastSelectedMenuNumber,
          lastSelectedNodeId: userState.lastSelectedNodeId,
        },
        activePath: [],
        activePathLabels: [],
      };
    }

    if (menuRequested) {
      return {
        status: 'main_menu',
        replyText: buildMenuMessage({
          contactName,
          tree,
          path: [],
          variant: 'menu',
        }),
        selectedNode: null,
        selectedMenuNumber: null,
        shouldSaveUnmatched: false,
        nextState: {
          hasSeenMenu: true,
          currentPath: [],
          lastMenuShownAt: now,
          lastSelectedMenuNumber: userState.lastSelectedMenuNumber,
          lastSelectedNodeId: userState.lastSelectedNodeId,
        },
        activePath: [],
        activePathLabels: [],
      };
    }

    if (selectedMenuNumber === 0) {
      return {
        status: 'back_to_main',
        replyText: buildMenuMessage({
          contactName,
          tree,
          path: [],
          variant: 'menu',
          leadText:
            currentPath.length > 0
              ? 'Siap, kamu sudah kembali ke menu utama.'
              : 'Kamu sudah berada di menu utama.',
        }),
        selectedNode: null,
        selectedMenuNumber,
        shouldSaveUnmatched: false,
        nextState: {
          hasSeenMenu: true,
          currentPath: [],
          lastMenuShownAt: now,
          lastSelectedMenuNumber: userState.lastSelectedMenuNumber,
          lastSelectedNodeId: userState.lastSelectedNodeId,
        },
        activePath: [],
        activePathLabels: [],
      };
    }

    if (selectedMenuNumber !== null) {
      const currentItems = getMenuItems(tree, currentPath);
      const selectedNode = currentItems[selectedMenuNumber - 1] || null;

      if (!selectedNode) {
        return {
          status: 'invalid_selection',
          replyText: buildMenuMessage({
            contactName,
            tree,
            path: currentPath,
            variant: 'menu',
            leadText: 'Nomor itu belum ada di daftar. Coba pilih angka yang tersedia ya.',
          }),
          selectedNode: null,
          selectedMenuNumber,
          shouldSaveUnmatched: false,
          nextState: {
            hasSeenMenu: true,
            currentPath,
            lastMenuShownAt: now,
            lastSelectedMenuNumber: userState.lastSelectedMenuNumber,
            lastSelectedNodeId: userState.lastSelectedNodeId,
          },
          activePath: currentPath,
          activePathLabels: getPathLabels(tree, currentPath),
        };
      }

      if (selectedNode.children.length > 0) {
        const nextPath = [...currentPath, selectedMenuNumber - 1];

        return {
          status: 'submenu',
          replyText: buildMenuMessage({
            contactName,
            tree,
            path: nextPath,
            variant: 'menu',
          }),
          selectedNode,
          selectedMenuNumber,
          shouldSaveUnmatched: false,
          nextState: {
            hasSeenMenu: true,
            currentPath: nextPath,
            lastMenuShownAt: now,
            lastSelectedMenuNumber: selectedMenuNumber,
            lastSelectedNodeId: selectedNode.id,
          },
          activePath: nextPath,
          activePathLabels: getPathLabels(tree, nextPath),
          selectedPath: nextPath,
          selectedPathLabels: getPathLabels(tree, nextPath),
        };
      }

      return {
        status: 'answer',
        replyText: buildAnswerReply({
          tree,
          currentPath,
          selectedNode,
          selectedMenuNumber,
        }),
        selectedNode,
        selectedMenuNumber,
        shouldSaveUnmatched: false,
        nextState: {
          hasSeenMenu: true,
          currentPath,
          lastMenuShownAt: userState.lastMenuShownAt,
          lastSelectedMenuNumber: selectedMenuNumber,
          lastSelectedNodeId: selectedNode.id,
        },
        activePath: currentPath,
        activePathLabels: getPathLabels(tree, currentPath),
        selectedPath: [...currentPath, selectedMenuNumber - 1],
        selectedPathLabels: getPathLabels(tree, [...currentPath, selectedMenuNumber - 1]),
      };
    }

    return {
      status: 'menu_redirect',
      replyText: buildMenuMessage({
        contactName,
        tree,
        path: currentPath,
        variant: 'menu',
        leadText: 'Untuk lanjut, balas dengan angka dari menu yang sedang aktif ya.',
      }),
      selectedNode: null,
      selectedMenuNumber: null,
      shouldSaveUnmatched: true,
      nextState: {
        hasSeenMenu: true,
        currentPath,
        lastMenuShownAt: now,
        lastSelectedMenuNumber: userState.lastSelectedMenuNumber,
        lastSelectedNodeId: userState.lastSelectedNodeId,
      },
      activePath: currentPath,
      activePathLabels: getPathLabels(tree, currentPath),
    };
  } catch (error) {
    console.error('Gagal membaca template pertanyaan:', error.message);

    return {
      status: 'template_error',
      replyText: TEMPLATE_ERROR_REPLY,
      selectedNode: null,
      selectedMenuNumber: null,
      shouldSaveUnmatched: false,
      nextState: {
        ...DEFAULT_USER_STATE,
        ...userState,
      },
      activePath: Array.isArray(userState.currentPath) ? userState.currentPath : [],
      activePathLabels: [],
    };
  }
}

async function saveUserConversation({
  userRecord,
  message,
  chatId,
  contactName,
  replyData,
}) {
  const effectiveChatId = chatId || message.from;
  const userFile = createUserFilePath(effectiveChatId);
  const now = new Date().toISOString();
  const updatedUserRecord = {
    ...userRecord,
    chatId: effectiveChatId,
    contactName: contactName || userRecord.contactName || null,
    createdAt: userRecord.createdAt || now,
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
    sourceChatId: message.from,
    text: message.body,
    normalizedText: normalizeText(message.body),
    receivedAt: now,
    whatsappTimestamp: message.timestamp || null,
    selectedNodeId: replyData.selectedNode?.id || null,
    selectedMenuNumber: replyData.selectedMenuNumber ?? null,
    activePath: Array.isArray(replyData.activePath) ? replyData.activePath : [],
    activePathLabels: Array.isArray(replyData.activePathLabels)
      ? replyData.activePathLabels
      : [],
    selectedPath: Array.isArray(replyData.selectedPath) ? replyData.selectedPath : [],
    selectedPathLabels: Array.isArray(replyData.selectedPathLabels)
      ? replyData.selectedPathLabels
      : [],
    replyText: replyData.replyText,
    status: replyData.status,
  });

  await fs.writeJson(userFile, updatedUserRecord, { spaces: 2 });
}

async function saveUnmatchedQuestion({ message, chatId, contactName, activePathLabels }) {
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
    chatId: chatId || message.from,
    sourceChatId: message.from,
    contactName: contactName || null,
    text: message.body,
    normalizedText: normalizeText(message.body),
    activePathLabels: Array.isArray(activePathLabels) ? activePathLabels : [],
    receivedAt: now,
  });

  await fs.writeJson(UNMATCHED_FILE, payload, { spaces: 2 });
}

async function resolveContactName(message) {
  try {
    const contact = await message.getContact();

    return contact.pushname || contact.name || contact.shortName || contact.id?.user || null;
  } catch (error) {
    return null;
  }
}

async function resolveStableChatId(message) {
  const incomingChatId = message.from;

  if (!incomingChatId || !incomingChatId.endsWith('@lid')) {
    return incomingChatId;
  }

  try {
    const mappings = await message.client.getContactLidAndPhone([incomingChatId]);
    const stableChatId = mappings?.[0]?.pn;

    return stableChatId || incomingChatId;
  } catch (error) {
    console.warn(`Gagal menormalkan chat ID ${incomingChatId}: ${error.message}`);
    return incomingChatId;
  }
}

async function replyToIncomingMessage(message, chatId, replyText) {
  if (!chatId || chatId === message.from) {
    await message.reply(replyText);
    return;
  }

  await message.client.sendMessage(chatId, replyText);
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
  const stableChatId = await resolveStableChatId(message);
  const userRecord = await loadUserRecord(stableChatId, contactName, [message.from]);

  console.log(
    `[MSG] ${contactName || stableChatId}: ${message.body} (${message.from}${
      stableChatId !== message.from ? ` -> ${stableChatId}` : ''
    })`,
  );

  const replyData = await getReplyData({
    messageText: message.body,
    contactName,
    userState: userRecord.state,
  });

  await replyToIncomingMessage(message, stableChatId, replyData.replyText);

  await saveUserConversation({
    userRecord,
    message,
    chatId: stableChatId,
    contactName,
    replyData,
  });

  if (replyData.shouldSaveUnmatched) {
    await saveUnmatchedQuestion({
      message,
      chatId: stableChatId,
      contactName,
      activePathLabels: replyData.activePathLabels,
    });
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
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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
  getMenuItems,
  getPathLabels,
  getReplyData,
  normalizeMenuTree,
  normalizeText,
  parseSelectedMenuNumber,
  sanitizePath,
};
