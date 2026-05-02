const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN = process.env.TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = 'Opendesk';
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 минут (поменяй на 5 * 60 * 1000 для прода)
// ──────────────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(TOKEN, { polling: true });
const subscribers = new Set();

// Храним водителей которые уже в статусе READY
// Ключ: driver name, Значение: время когда впервые увидели READY
const readySince = new Map();

/**
 * Скачивает лист из Google Sheets как CSV
 */
async function fetchSheetData() {
	const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;
	const response = await axios.get(url, { timeout: 10000 });
	const csv = response.data;

	return csv
		.split('\n')
		.map((line) =>
			line
				.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
				.map((cell) => cell.replace(/^"|"$/g, '').trim()),
		);
}

/**
 * Ищет строки со статусом READY
 */
async function findReadyDrivers() {
	const rows = await fetchSheetData();
	const readyEntries = [];
	const headerRow = rows[0] || [];

	rows.forEach((row, rowIndex) => {
		if (rowIndex === 0) return;

		row.forEach((cell, colIndex) => {
			if (cell.toLowerCase() === 'ready') {
				readyEntries.push({
					driver: row[2] || '—',
					company: row[0] || '—',
					dispatcher: row[1] || '—',
					phone: row[3] || '—',
					date: headerRow[colIndex] || `Col ${colIndex + 1}`,
				});
			}
		});
	});

	return readyEntries;
}

/**
 * Форматирует время в виде "2:00 PM"
 */
function formatTime(date) {
	return date.toLocaleTimeString('en-US', {
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
	});
}

/**
 * Основная проверка — находит НОВЫХ водителей в READY и уведомляет
 */
async function checkAndNotify() {
	if (subscribers.size === 0) {
		console.log(
			`[${new Date().toLocaleTimeString()}] No subscribers, skipping.`,
		);
		return;
	}

	console.log(`[${new Date().toLocaleTimeString()}] Checking Google Sheets...`);

	let currentReady;
	try {
		currentReady = await findReadyDrivers();
	} catch (err) {
		console.error('❌ Sheet read error:', err.message);
		return;
	}

	const now = new Date();
	const currentDriverNames = new Set(currentReady.map((e) => e.driver));

	// Убираем тех кто вышел из READY
	for (const name of readySince.keys()) {
		if (!currentDriverNames.has(name)) {
			readySince.delete(name);
			console.log(`➖ No longer READY: ${name}`);
		}
	}

	// Находим НОВЫХ в READY (кого ещё не было в readySince)
	const newReady = currentReady.filter((e) => !readySince.has(e.driver));

	// Запоминаем время для новых
	for (const entry of newReady) {
		readySince.set(entry.driver, now);
		console.log(`➕ New READY: ${entry.driver} at ${formatTime(now)}`);
	}

	// Если новых нет — не спамим
	if (newReady.length === 0) {
		console.log('✅ No new READY drivers.');
		return;
	}

	// Отправляем уведомление только про новых
	for (const entry of newReady) {
		const since = readySince.get(entry.driver);
		const message = `🚛 *${entry.driver}* is READY since *${formatTime(since)}*`;

		for (const chatId of subscribers) {
			try {
				await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
			} catch (err) {
				console.error(`❌ Send error to ${chatId}:`, err.message);
				if (err.response?.body?.error_code === 403) {
					subscribers.delete(chatId);
				}
			}
		}
	}

	console.log(`✅ Notified about ${newReady.length} new READY driver(s).`);
}

// ─── КОМАНДЫ ──────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
	const chatId = msg.chat.id;
	const name = msg.from.first_name || 'friend';
	subscribers.add(chatId);
	console.log(`➕ Subscribed: ${name} (${chatId})`);

	bot.sendMessage(
		chatId,
		`👋 Hi *${name}*!\n\n` +
			`✅ You're subscribed to *READY* status alerts.\n` +
			`Bot checks Google Sheet every *2 minutes* and notifies only when a driver becomes READY.\n\n` +
			`Commands:\n` +
			`/check — check right now\n` +
			`/ready — list currently READY drivers\n` +
			`/stop — unsubscribe\n` +
			`/status — bot status`,
		{ parse_mode: 'Markdown' },
	);
});

bot.onText(/\/stop/, (msg) => {
	subscribers.delete(msg.chat.id);
	bot.sendMessage(
		msg.chat.id,
		'🔕 Unsubscribed. Send /start to subscribe again.',
	);
});

// /check — ручная проверка (показывает всех текущих READY)
bot.onText(/\/check/, async (msg) => {
	const chatId = msg.chat.id;
	await bot.sendMessage(chatId, '🔍 Checking Google Sheet...');
	try {
		const entries = await findReadyDrivers();
		if (entries.length === 0) {
			await bot.sendMessage(
				chatId,
				'✅ No drivers with READY status right now.',
			);
			return;
		}

		for (const e of entries) {
			const since = readySince.get(e.driver);
			const sinceText = since ? ` since *${formatTime(since)}*` : '';
			await bot.sendMessage(
				chatId,
				`🚛 *${e.driver}* is READY${sinceText}\n` +
					`🏢 Company: ${e.company}\n` +
					`👤 Dispatcher: ${e.dispatcher}\n` +
					`📞 Phone: ${e.phone}\n` +
					`📅 Date: ${e.date}`,
				{ parse_mode: 'Markdown' },
			);
		}
	} catch (err) {
		await bot.sendMessage(chatId, `⚠️ Error: ${err.message}`);
	}
});

// /ready — список кто сейчас в READY с временем
bot.onText(/\/ready/, (msg) => {
	const chatId = msg.chat.id;
	if (readySince.size === 0) {
		bot.sendMessage(chatId, '✅ No drivers currently tracked as READY.');
		return;
	}

	let text = `🚛 *Currently READY (${readySince.size}):*\n\n`;
	for (const [driver, since] of readySince.entries()) {
		text += `• *${driver}* — since ${formatTime(since)}\n`;
	}
	bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, (msg) => {
	const chatId = msg.chat.id;
	bot.sendMessage(
		chatId,
		`📊 *Bot Status*\n\n` +
			`👤 You: ${subscribers.has(chatId) ? '✅ subscribed' : '❌ not subscribed'}\n` +
			`👥 Total subscribers: ${subscribers.size}\n` +
			`🚛 Tracked READY drivers: ${readySince.size}\n` +
			`📋 Sheet: \`${SHEET_NAME}\`\n` +
			`⏱ Interval: every 2 minutes`,
		{ parse_mode: 'Markdown' },
	);
});

// ─── HTTP чтобы Render не засыпал ─────────────────────────────────────────────
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

// ─── ЗАПУСК ───────────────────────────────────────────────────────────────────
console.log('🚀 Truck READY Bot started');
console.log(`📋 Sheet: ${SHEET_NAME}`);
console.log(`⏱ Check interval: 2 minutes\n`);

// Первая проверка сразу при старте
checkAndNotify();
setInterval(checkAndNotify, CHECK_INTERVAL_MS);
