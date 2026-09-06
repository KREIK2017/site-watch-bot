import { getChatLanguage } from "./currency";
import type { Env } from "./types";

export const SUPPORTED_LANGUAGES = ["uk", "ru", "en"] as const;
export type Lang = (typeof SUPPORTED_LANGUAGES)[number];

const DEFAULT_LANG: Lang = "uk";

export function isLang(value: string): value is Lang {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

export async function getChatLang(env: Env, chatId: number): Promise<Lang> {
  const raw = await getChatLanguage(env, chatId);
  return raw && isLang(raw) ? raw : DEFAULT_LANG;
}

type Vars = Record<string, string | number>;

function format(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

// Every key must exist for every language — the `satisfies` check below turns
// a missing translation into a compile error instead of a silent fallback.
const STRINGS = {
  uk: {
    welcome:
      "<b>Site Watch Bot</b>\nСлідкую за сайтами і повідомляю про зміни ціни, наявності, статусу сторінки чи вмісту.\n\nКористуйся кнопками знизу або команда <code>/help</code> для повної довідки.",
    help: "<b>Site Watch Bot</b>\nСлідкую за сайтами і повідомляю про зміни ціни, наявності, статусу чи вмісту сторінки.\n\n<b>Команди:</b>\n/watch &lt;url&gt; — почати стежити\n/list — мої сайти (тисни ⚙️ #id, щоб керувати конкретним)\n/check &lt;id&gt; — перевірити зараз\n/history &lt;id&gt; — історія цін/наявності\n/rename &lt;id&gt; &lt;назва&gt; — перейменувати\n/pause &lt;id&gt; — призупинити перевірки\n/resume &lt;id&gt; — відновити перевірки\n/unwatch &lt;id&gt; — прибрати зі списку\n/currency — обрати валюту показу цін\n/language — обрати мову бота\n/help — ця довідка\n\n<b>Приклади:</b>\n<code>/watch https://example.com/product</code>\n<code>/watch https://store.steampowered.com/app/12345/GameName</code>\n\nМожна просто вставити посилання в чат без команди — теж спрацює.",
    askLanguage: "Якою мовою спілкуватись?",
    askCurrency: "В якій валюті показувати ціни?",
    languageSet: "Мова: {name} ✅",
    currencySet: "Валюта: {code} ✅",
    watchUsage:
      "Вкажи посилання: <code>/watch https://example.com</code>\nЩоб стежити за конкретним товаром, додай CSS-селектор: <code>/watch https://example.com/product .price</code>",
    alreadyWatching: "Вже стежу за цим сайтом (id {id}).",
    limitReached: "Досягнуто ліміту {max} сайтів на чат. Прибери щось непотрібне через /list, щоб додати нове.",
    watchAdded: "✅ Стежу за {link} (id {id})",
    elementLabel: "Елемент: {selector}",
    statusLabel: "Статус: {status}",
    priceLabel: "Ціна: {price}",
    stockLabel: "Наявність: {stock}",
    valueLabel: "Значення: {value}",
    techInfoHeader: "🔧 <b>Технічна інформація</b>",
    responseTime: "⏱ Відповідь: {time}",
    pageSize: "📦 Розмір сторінки: {size}",
    platform: "🧩 Платформа: {platform}",
    hosting: "☁️ Хостинг/CDN: {hosting}",
    securityHeaders: "🔒 Заголовки безпеки: {headers}",
    emptyList: "Список порожній. Додай сайт: <code>/watch https://example.com</code>",
    pausedBadge: "⏸ на паузі",
    pausedNote: "⏸ На паузі — перевірки не виконуються",
    idUsage: "Вкажи id зі списку: <code>{example}</code>",
    unwatchDone: "Прибрав id {id} зі списку.",
    notFoundActive: "Не знайшов активний watch з id {id}.",
    notFoundAny: "Не знайшов watch з id {id}.",
    renameUsage: "Формат: <code>/rename 3 Нова назва</code>",
    renameDone: "Перейменовано id {id} на «{name}».",
    pausedDone: "⏸ Призупинив перевірки для id {id}.",
    resumedDone: "▶️ Відновив перевірки для id {id}.",
    historyEmpty: "Історії ще немає — зачекай на першу зафіксовану зміну.",
    unknownCommand: "Не знаю такої команди. /help — список команд.",
    menuMySites: "📋 Мої сайти",
    menuAddSite: "➕ Додати сайт",
    menuHelp: "❓ Допомога",
    addSitePrompt:
      "Надішли посилання на сайт (за бажанням через пробіл додай CSS-селектор товару), напр.:\nhttps://example.com\nhttps://example.com/product .price",
    btnCheck: "🔄 Перевірити",
    btnPause: "⏸ Пауза",
    btnResume: "▶️ Відновити",
    btnDelete: "🗑 Видалити",
    btnWrongPrice: "❔ Не та ціна?",
    btnBack: "⬅️ До списку",
    toastNotFound: "Не знайдено",
    toastStaleButton: "Кнопка застаріла",
    toastStaleButtonRefresh: "Кнопка застаріла, онови список через /list",
    toastChecked: "Перевірено ✅",
    toastRemoved: "Прибрано",
    toastPaused: "⏸ Пауза",
    toastResumed: "▶️ Відновлено",
    toastSaved: "Збережено ✅",
    fixNoCandidates: "Не знайшов інших варіантів на сторінці",
    fixPrompt: "Знайшов кілька можливих значень ціни на {link}. Яке правильне?",
    alertHeader: "🚨 <b>САЙТ ЗМІНИВСЯ</b>",
    changesLabel: "Зміни:",
    changeStatus: "• Статус: {from} → {to}",
    changePrice: "• Ціна: {from} → {to}",
    changeStock: "• Наявність: {from} → {to}",
    changeValue: "• Значення: {from} → {to}",
    contentChanged: "• Вміст сторінки змінився",
    checkErrorAlert: "🚨 <b>{link}</b>\nПроблема при перевірці: {error}",
    statusOnline: "🟢 Онлайн",
    statusRedirect: "🟡 Перенаправлення",
    statusNotFound: "🔴 Сторінку не знайдено (404)",
    statusForbidden: "🔴 Доступ заборонено (403)",
    statusClientError: "🔴 Помилка сторінки ({code})",
    statusServerError: "🔴 Сервер лежить ({code})",
    statusUnreachable: "🔴 Недоступний",
    statusFallback: "Статус {code}",
    stockIn: "В наявності",
    stockOut: "Немає в наявності",
    stockLimited: "Обмежена кількість",
    stockPreorder: "Передзамовлення",
    stockDiscontinued: "Знято з продажу",
  },
  ru: {
    welcome:
      "<b>Site Watch Bot</b>\nСлежу за сайтами и сообщаю об изменениях цены, наличия, статуса страницы или содержимого.\n\nПользуйся кнопками снизу или командой <code>/help</code> для полной справки.",
    help: "<b>Site Watch Bot</b>\nСлежу за сайтами и сообщаю об изменениях цены, наличия, статуса или содержимого страницы.\n\n<b>Команды:</b>\n/watch &lt;url&gt; — начать слежение\n/list — мои сайты (нажми ⚙️ #id для управления)\n/check &lt;id&gt; — проверить сейчас\n/history &lt;id&gt; — история цен/наличия\n/rename &lt;id&gt; &lt;имя&gt; — переименовать\n/pause &lt;id&gt; — приостановить проверки\n/resume &lt;id&gt; — возобновить проверки\n/unwatch &lt;id&gt; — убрать из списка\n/currency — выбрать валюту показа цен\n/language — выбрать язык бота\n/help — эта справка\n\n<b>Примеры:</b>\n<code>/watch https://example.com/product</code>\n<code>/watch https://store.steampowered.com/app/12345/GameName</code>\n\nМожно просто вставить ссылку в чат без команды — тоже сработает.",
    askLanguage: "На каком языке общаться?",
    askCurrency: "В какой валюте показывать цены?",
    languageSet: "Язык: {name} ✅",
    currencySet: "Валюта: {code} ✅",
    watchUsage:
      "Укажи ссылку: <code>/watch https://example.com</code>\nЧтобы следить за конкретным товаром, добавь CSS-селектор: <code>/watch https://example.com/product .price</code>",
    alreadyWatching: "Уже слежу за этим сайтом (id {id}).",
    limitReached: "Достигнут лимит {max} сайтов на чат. Убери что-то ненужное через /list, чтобы добавить новое.",
    watchAdded: "✅ Слежу за {link} (id {id})",
    elementLabel: "Элемент: {selector}",
    statusLabel: "Статус: {status}",
    priceLabel: "Цена: {price}",
    stockLabel: "Наличие: {stock}",
    valueLabel: "Значение: {value}",
    techInfoHeader: "🔧 <b>Техническая информация</b>",
    responseTime: "⏱ Ответ: {time}",
    pageSize: "📦 Размер страницы: {size}",
    platform: "🧩 Платформа: {platform}",
    hosting: "☁️ Хостинг/CDN: {hosting}",
    securityHeaders: "🔒 Заголовки безопасности: {headers}",
    emptyList: "Список пуст. Добавь сайт: <code>/watch https://example.com</code>",
    pausedBadge: "⏸ на паузе",
    pausedNote: "⏸ На паузе — проверки не выполняются",
    idUsage: "Укажи id из списка: <code>{example}</code>",
    unwatchDone: "Убрал id {id} из списка.",
    notFoundActive: "Не нашёл активный watch с id {id}.",
    notFoundAny: "Не нашёл watch с id {id}.",
    renameUsage: "Формат: <code>/rename 3 Новое имя</code>",
    renameDone: "Переименовал id {id} в «{name}».",
    pausedDone: "⏸ Приостановил проверки для id {id}.",
    resumedDone: "▶️ Возобновил проверки для id {id}.",
    historyEmpty: "Истории пока нет — жди первое зафиксированное изменение.",
    unknownCommand: "Не знаю такой команды. /help — список команд.",
    menuMySites: "📋 Мои сайты",
    menuAddSite: "➕ Добавить сайт",
    menuHelp: "❓ Помощь",
    addSitePrompt:
      "Пришли ссылку на сайт (по желанию через пробел добавь CSS-селектор товара), напр.:\nhttps://example.com\nhttps://example.com/product .price",
    btnCheck: "🔄 Проверить",
    btnPause: "⏸ Пауза",
    btnResume: "▶️ Возобновить",
    btnDelete: "🗑 Удалить",
    btnWrongPrice: "❔ Не та цена?",
    btnBack: "⬅️ К списку",
    toastNotFound: "Не найдено",
    toastStaleButton: "Кнопка устарела",
    toastStaleButtonRefresh: "Кнопка устарела, обнови список через /list",
    toastChecked: "Проверено ✅",
    toastRemoved: "Убрано",
    toastPaused: "⏸ Пауза",
    toastResumed: "▶️ Возобновлено",
    toastSaved: "Сохранено ✅",
    fixNoCandidates: "Не нашёл других вариантов на странице",
    fixPrompt: "Нашёл несколько возможных значений цены на {link}. Какое правильное?",
    alertHeader: "🚨 <b>САЙТ ИЗМЕНИЛСЯ</b>",
    changesLabel: "Изменения:",
    changeStatus: "• Статус: {from} → {to}",
    changePrice: "• Цена: {from} → {to}",
    changeStock: "• Наличие: {from} → {to}",
    changeValue: "• Значение: {from} → {to}",
    contentChanged: "• Содержимое страницы изменилось",
    checkErrorAlert: "🚨 <b>{link}</b>\nПроблема при проверке: {error}",
    statusOnline: "🟢 Онлайн",
    statusRedirect: "🟡 Перенаправление",
    statusNotFound: "🔴 Страница не найдена (404)",
    statusForbidden: "🔴 Доступ запрещён (403)",
    statusClientError: "🔴 Ошибка страницы ({code})",
    statusServerError: "🔴 Сервер лежит ({code})",
    statusUnreachable: "🔴 Недоступен",
    statusFallback: "Статус {code}",
    stockIn: "В наличии",
    stockOut: "Нет в наличии",
    stockLimited: "Ограниченное количество",
    stockPreorder: "Предзаказ",
    stockDiscontinued: "Снято с продажи",
  },
  en: {
    welcome:
      "<b>Site Watch Bot</b>\nI watch sites and let you know about price, stock, status or content changes.\n\nUse the buttons below or <code>/help</code> for the full guide.",
    help: "<b>Site Watch Bot</b>\nI watch sites and let you know about price, stock, status or content changes.\n\n<b>Commands:</b>\n/watch &lt;url&gt; — start watching\n/list — your sites (tap ⚙️ #id to manage one)\n/check &lt;id&gt; — check right now\n/history &lt;id&gt; — price/stock history\n/rename &lt;id&gt; &lt;name&gt; — rename\n/pause &lt;id&gt; — pause checks\n/resume &lt;id&gt; — resume checks\n/unwatch &lt;id&gt; — remove\n/currency — choose display currency\n/language — choose bot language\n/help — this help\n\n<b>Examples:</b>\n<code>/watch https://example.com/product</code>\n<code>/watch https://store.steampowered.com/app/12345/GameName</code>\n\nJust pasting a link without a command also works.",
    askLanguage: "Which language should I use?",
    askCurrency: "Which currency should prices be shown in?",
    languageSet: "Language: {name} ✅",
    currencySet: "Currency: {code} ✅",
    watchUsage:
      "Give me a link: <code>/watch https://example.com</code>\nTo watch one specific product, add a CSS selector: <code>/watch https://example.com/product .price</code>",
    alreadyWatching: "Already watching this site (id {id}).",
    limitReached: "Reached the limit of {max} sites per chat. Remove something via /list to add a new one.",
    watchAdded: "✅ Watching {link} (id {id})",
    elementLabel: "Element: {selector}",
    statusLabel: "Status: {status}",
    priceLabel: "Price: {price}",
    stockLabel: "Stock: {stock}",
    valueLabel: "Value: {value}",
    techInfoHeader: "🔧 <b>Technical info</b>",
    responseTime: "⏱ Response: {time}",
    pageSize: "📦 Page size: {size}",
    platform: "🧩 Platform: {platform}",
    hosting: "☁️ Hosting/CDN: {hosting}",
    securityHeaders: "🔒 Security headers: {headers}",
    emptyList: "The list is empty. Add a site: <code>/watch https://example.com</code>",
    pausedBadge: "⏸ paused",
    pausedNote: "⏸ Paused — checks are not running",
    idUsage: "Give the id from the list: <code>{example}</code>",
    unwatchDone: "Removed id {id} from the list.",
    notFoundActive: "No active watch with id {id}.",
    notFoundAny: "No watch with id {id}.",
    renameUsage: "Format: <code>/rename 3 New name</code>",
    renameDone: "Renamed id {id} to “{name}”.",
    pausedDone: "⏸ Paused checks for id {id}.",
    resumedDone: "▶️ Resumed checks for id {id}.",
    historyEmpty: "No history yet — wait for the first recorded change.",
    unknownCommand: "I don't know that command. /help — command list.",
    menuMySites: "📋 My sites",
    menuAddSite: "➕ Add site",
    menuHelp: "❓ Help",
    addSitePrompt:
      "Send me a link to the site (optionally add a CSS selector after a space), e.g.:\nhttps://example.com\nhttps://example.com/product .price",
    btnCheck: "🔄 Check",
    btnPause: "⏸ Pause",
    btnResume: "▶️ Resume",
    btnDelete: "🗑 Delete",
    btnWrongPrice: "❔ Wrong price?",
    btnBack: "⬅️ Back to list",
    toastNotFound: "Not found",
    toastStaleButton: "This button is stale",
    toastStaleButtonRefresh: "This button is stale, refresh via /list",
    toastChecked: "Checked ✅",
    toastRemoved: "Removed",
    toastPaused: "⏸ Paused",
    toastResumed: "▶️ Resumed",
    toastSaved: "Saved ✅",
    fixNoCandidates: "Found no other values on the page",
    fixPrompt: "Found several possible price values on {link}. Which one is right?",
    alertHeader: "🚨 <b>SITE CHANGED</b>",
    changesLabel: "Changes:",
    changeStatus: "• Status: {from} → {to}",
    changePrice: "• Price: {from} → {to}",
    changeStock: "• Stock: {from} → {to}",
    changeValue: "• Value: {from} → {to}",
    contentChanged: "• Page content changed",
    checkErrorAlert: "🚨 <b>{link}</b>\nProblem while checking: {error}",
    statusOnline: "🟢 Online",
    statusRedirect: "🟡 Redirect",
    statusNotFound: "🔴 Page not found (404)",
    statusForbidden: "🔴 Access denied (403)",
    statusClientError: "🔴 Page error ({code})",
    statusServerError: "🔴 Server down ({code})",
    statusUnreachable: "🔴 Unreachable",
    statusFallback: "Status {code}",
    stockIn: "In stock",
    stockOut: "Out of stock",
    stockLimited: "Limited availability",
    stockPreorder: "Pre-order",
    stockDiscontinued: "Discontinued",
  },
} satisfies Record<Lang, Record<string, string>>;

export type MessageKey = keyof (typeof STRINGS)["uk"];

export function t(lang: Lang, key: MessageKey, vars?: Vars): string {
  return format(STRINGS[lang][key], vars);
}

export const LANGUAGE_NAMES: Record<Lang, string> = {
  uk: "Українська",
  ru: "Русский",
  en: "English",
};

// Internal, language-agnostic stock codes — extractStock/mapAvailability
// return these instead of localized text so the stored value doesn't depend
// on whatever language happened to be active at check time. Localize only
// at display time via localizeStock.
export const STOCK_IN = "in_stock";
export const STOCK_OUT = "out_of_stock";
export const STOCK_LIMITED = "limited";
export const STOCK_PREORDER = "preorder";
export const STOCK_DISCONTINUED = "discontinued";

const STOCK_KEY_BY_CODE: Record<string, MessageKey> = {
  [STOCK_IN]: "stockIn",
  [STOCK_OUT]: "stockOut",
  [STOCK_LIMITED]: "stockLimited",
  [STOCK_PREORDER]: "stockPreorder",
  [STOCK_DISCONTINUED]: "stockDiscontinued",
};

export function localizeStock(code: string | null, lang: Lang): string | null {
  if (!code) return null;
  const key = STOCK_KEY_BY_CODE[code];
  return key ? t(lang, key) : code;
}

const STATUS_KEY_BY_RANGE = (status: number): MessageKey => {
  if (status >= 200 && status < 300) return "statusOnline";
  if (status >= 300 && status < 400) return "statusRedirect";
  if (status === 404) return "statusNotFound";
  if (status === 403) return "statusForbidden";
  if (status >= 400 && status < 500) return "statusClientError";
  if (status >= 500) return "statusServerError";
  return "statusFallback";
};

// HTTP status codes mean nothing to a non-technical user, so every place
// that shows a status shows this instead of the raw number.
export function humanizeStatus(status: number | null, lang: Lang): string {
  if (status === null) return t(lang, "statusUnreachable");
  return t(lang, STATUS_KEY_BY_RANGE(status), { code: status });
}
