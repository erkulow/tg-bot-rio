const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN = process.env.TOKEN; // из Render Environment
const SHEET_ID = process.env.SHEET_ID; // ID Google таблицы
const SHEET_NAME = 'tg-bot-rio'; // имя листа
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 минут
// ──────────────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(TOKEN, { polling: true });
const subscribers = new Set();

/**
 * Скачивает лист из Google Sheets как CSV и парсит его
 * Таблица должна быть открыта "Все у кого есть ссылка - могут просматривать"
 */
async function fetchSheetData() {
	const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;

	const response = await axios.get(url, { timeout: 10000 });
	const csv = response.data;

	// Парсим CSV вручную (без библиотек)
	const rows = csv.split('\n').map((line) => {
		// Убираем кавычки и разбиваем по запятым
		return line
			.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
			.map((cell) => cell.replace(/^"|"$/g, '').trim());
	});

	return rows;
}

/**
 * Ищет строки со статусом READY
 */
async function findReadyDrivers() {
	const rows = await fetchSheetData();
	const readyEntries = [];
	const headerRow = rows[0] || [];

	rows.forEach((row, rowIndex) => {
		if (rowIndex === 0) return; // пропускаем заголовок

		row.forEach((cell, colIndex) => {
			if (cell.toLowerCase() === 'ready') {
				const company = row[0] || '—';
				const dispatcher = row[1] || '—';
				const driver = row[2] || '—';
				const phone = row[3] || '—';
				const dateHeader = headerRow[colIndex] || `Колонка ${colIndex + 1}`;

				readyEntries.push({
					row: rowIndex + 1,
					date: dateHeader,
					company,
					dispatcher,
					driver,
					phone,
				});
			}
		});
	});

	return readyEntries;
}

/**
 * Форматирует сообщение
 */
function formatMessage(entries) {
	if (entries.length === 0) {
		return `✅ *Нет водителей со статусом READY*\n\n🕐 _${new Date().toLocaleString('ru-RU')}_`;
	}

	const lines = [`🚛 *READY: найдено ${entries.length} шт.*\n`];

	entries.forEach((e, i) => {
		lines.push(
			`*${i + 1}. ${e.driver}*\n` +
				`   🏢 Компания: ${e.company}\n` +
				`   👤 Диспетчер: ${e.dispatcher}\n` +
				`   📞 Телефон: ${e.phone}\n` +
				`   📅 Дата: ${e.date}\n`,
		);
	});

	lines.push(`🕐 _${new Date().toLocaleString('ru-RU')}_`);
	return lines.join('\n');
}

/**
 * Проверяет и отправляет всем подписчикам
 */
async function checkAndNotify() {
	if (subscribers.size === 0) {
		console.log(
			`[${new Date().toLocaleTimeString()}] Нет подписчиков, пропускаю.`,
		);
		return;
	}

	console.log(`[${new Date().toLocaleTimeString()}] Проверяю Google Sheets...`);

	let message;
	try {
		const entries = await findReadyDrivers();
		message = formatMessage(entries);
		console.log(`✅ READY найдено: ${entries.length}`);
	} catch (err) {
		console.error('❌ Ошибка чтения таблицы:', err.message);
		message = `⚠️ Не удалось прочитать таблицу: ${err.message}`;
	}

	for (const chatId of subscribers) {
		try {
			await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
		} catch (err) {
			console.error(`❌ Ошибка отправки ${chatId}:`, err.message);
			if (err.response?.body?.error_code === 403) {
				subscribers.delete(chatId);
			}
		}
	}
}

// ─── КОМАНДЫ ──────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
	const chatId = msg.chat.id;
	const name = msg.from.first_name || 'друг';
	subscribers.add(chatId);
	console.log(`➕ Подписался: ${name} (${chatId})`);

	bot.sendMessage(
		chatId,
		`👋 Привет, *${name}*!\n\n` +
			`✅ Ты подписан на уведомления о статусе *READY*.\n` +
			`Бот проверяет Google Таблицу каждые *5 минут*.\n\n` +
			`Команды:\n` +
			`/check — проверить прямо сейчас\n` +
			`/stop — отписаться\n` +
			`/status — статус бота`,
		{ parse_mode: 'Markdown' },
	);
});

bot.onText(/\/stop/, (msg) => {
	subscribers.delete(msg.chat.id);
	bot.sendMessage(
		msg.chat.id,
		'🔕 Ты отписан. Напиши /start чтобы подписаться снова.',
	);
});

bot.onText(/\/check/, async (msg) => {
	const chatId = msg.chat.id;
	await bot.sendMessage(chatId, '🔍 Проверяю Google Таблицу...');
	try {
		const entries = await findReadyDrivers();
		await bot.sendMessage(chatId, formatMessage(entries), {
			parse_mode: 'Markdown',
		});
	} catch (err) {
		await bot.sendMessage(chatId, `⚠️ Ошибка: ${err.message}`);
	}
});

bot.onText(/\/status/, (msg) => {
	const chatId = msg.chat.id;
	bot.sendMessage(
		chatId,
		`📊 *Статус бота*\n\n` +
			`👤 Ты: ${subscribers.has(chatId) ? '✅ подписан' : '❌ не подписан'}\n` +
			`👥 Всего подписчиков: ${subscribers.size}\n` +
			`📋 Лист: \`${SHEET_NAME}\`\n` +
			`⏱ Интервал: каждые 5 минут`,
		{ parse_mode: 'Markdown' },
	);
});

// ─── HTTP сервер чтобы Render не засыпал ──────────────────────────────────────
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

// ─── ЗАПУСК ───────────────────────────────────────────────────────────────────
console.log('🚀 Truck List Bot запущен (Google Sheets)');
console.log(`📋 Лист: ${SHEET_NAME}`);
console.log(`⏱ Проверка каждые 5 минут\n`);

setInterval(checkAndNotify, CHECK_INTERVAL_MS);
