const STORE_KEY = "poryadochny-gadget-eu-finance-v1";
const TODAY = new Date().toISOString().slice(0, 10);

const accountBlueprints = [
  { id: "euro-card", name: "Карта евро" },
  { id: "euro-cash", name: "Наличные евро" },
];

const statusLabels = {
  bought: "Выкуплен",
  in_transit: "В доставке",
  arrived: "Прибыл",
};

const defaultState = {
  schemaVersion: 2,
  accounts: accountBlueprints.map((account) => ({
    ...account,
    currency: "EUR",
    balance: 0,
    rate: 100,
  })),
  operations: [],
  goods: [],
  lots: [],
  arrivals: [],
};

let state = loadState();
let operationFilter = "all";
let goodsFilter = "all";
let goodsSearch = "";
let expandedLotIds = new Set();
let applyingRemoteState = false;
let cloudReady = false;
let cloudSaveTimer = null;
let cloudListenerReady = false;
let lastLocalMutationAt = 0;

const els = {
  authScreen: document.querySelector("#auth-screen"),
  authForm: document.querySelector("#auth-form"),
  authError: document.querySelector("#auth-error"),
  logoutButton: document.querySelector("#logout-button"),
  viewTitle: document.querySelector("#view-title"),
  saveState: document.querySelector("#save-state"),
  accountsSummary: document.querySelector("#accounts-summary"),
  accountsEditor: document.querySelector("#accounts-editor"),
  accountTotalList: document.querySelector("#account-total-list"),
  soonGoods: document.querySelector("#soon-goods"),
  operationAccount: document.querySelector("#operation-account"),
  operationsTable: document.querySelector("#operations-table"),
  batchForm: document.querySelector("#goods-batch-form"),
  batchList: document.querySelector("#batch-list"),
  batchRowTemplate: document.querySelector("#batch-row-template"),
  goodsList: document.querySelector("#goods-list"),
  goodsCount: document.querySelector("#goods-count"),
  statusSummary: document.querySelector("#status-summary"),
  arrivalForm: document.querySelector("#arrival-form"),
  arrivalList: document.querySelector("#arrival-list"),
  arrivalRowTemplate: document.querySelector("#arrival-row-template"),
  arrivalPending: document.querySelector("#arrival-pending"),
  arrivalPendingCount: document.querySelector("#arrival-pending-count"),
  arrivalLog: document.querySelector("#arrival-log"),
  arrivalCount: document.querySelector("#arrival-count"),
};

function loadState() {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return structuredClone(defaultState);

  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return structuredClone(defaultState);
  }
}

function normalizeState(data) {
  const rawAccounts = Array.isArray(data.accounts) ? data.accounts : [];
  const oldEuroAccounts = rawAccounts.filter((account) => account.currency === "EUR");

  const accounts = accountBlueprints.map((blueprint, index) => {
    const matched =
      rawAccounts.find((account) => account.id === blueprint.id) ||
      rawAccounts.find((account) => String(account.name || "").toLowerCase() === blueprint.name.toLowerCase()) ||
      oldEuroAccounts[index];

    return {
      ...blueprint,
      currency: "EUR",
      balance: num(matched?.balance),
      rate: num(matched?.rate) || 100,
    };
  });

  const accountIds = new Set(accounts.map((account) => account.id));

  const goods = Array.isArray(data.goods) ? data.goods.map(normalizeGoodsItem) : [];
  assignMissingSkus(goods);
  const rawLots = Array.isArray(data.lots) ? data.lots.map(normalizeLot) : [];
  const migrated = migrateLotsToCurrentRules(goods, rawLots, num(data.schemaVersion));

  return {
    schemaVersion: 2,
    accounts,
    operations: Array.isArray(data.operations)
      ? data.operations.map((operation) => ({
          id: operation.id || crypto.randomUUID(),
          type: operation.type === "expense" ? "expense" : "income",
          date: operation.date || TODAY,
          accountId: accountIds.has(operation.accountId) ? operation.accountId : accounts[0].id,
          amount: num(operation.amount),
          rate: num(operation.rate) || accounts[0].rate,
          note: String(operation.note || ""),
        }))
      : [],
    goods: migrated.goods,
    lots: migrated.lots,
    arrivals: Array.isArray(data.arrivals)
      ? data.arrivals.map((arrival) => ({
          id: arrival.id || crypto.randomUUID(),
          goodsId: arrival.goodsId || "",
          date: arrival.date || TODAY,
          note: String(arrival.note || ""),
          deliveryEur: num(arrival.deliveryEur),
          deliveryRate: num(arrival.deliveryRate) || 100,
          deliveryRub: num(arrival.deliveryRub),
          photos: normalizePhotos(arrival.photos),
        }))
      : [],
  };
}

function normalizeGoodsItem(item) {
  const statusMap = {
    ordered: "bought",
    bought: "bought",
    customs: "in_transit",
    in_transit: "in_transit",
    arrived: "arrived",
  };

  const priceRate = num(item.priceRate || item.rate) || 100;
  const extraRate = num(item.extraRate || item.rate) || 100;

  return {
    id: item.id || crypto.randomUUID(),
    purchaseDate: item.purchaseDate || item.eta || TODAY,
    name: String(item.name || "").trim(),
    color: String(item.color || "").trim(),
    carrier: String(item.carrier || "").trim(),
    spec: String(item.spec || item.characteristic || "").trim(),
    priceEur: num(item.priceEur) || num(item.priceRub) / priceRate,
    priceRate,
    extraEur: num(item.extraEur || item.deliveryEur) || num(item.deliveryRub) / extraRate,
    extraRate,
    status: statusMap[item.status] || "bought",
    arrivedAt: item.arrivedAt || (item.status === "arrived" ? TODAY : ""),
    deliveryEur: num(item.deliveryEur),
    deliveryRate: num(item.deliveryRate) || extraRate,
    deliveryRub: num(item.deliveryRub),
    sku: String(item.sku || ""),
    lotId: String(item.lotId || ""),
    photos: normalizePhotos(item.photos),
  };
}

function normalizeLot(lot) {
  return {
    id: lot.id || crypto.randomUUID(),
    name: String(lot.name || "Лот").trim(),
    createdAt: lot.createdAt || TODAY,
    photos: normalizePhotos(lot.photos),
  };
}

function migrateLotsToCurrentRules(goods, lots, schemaVersion) {
  if (schemaVersion >= 2) {
    return { goods, lots };
  }

  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  const groups = new Map();

  goods.forEach((item) => {
    const oldLot = lotById.get(item.lotId);
    const groupKey = oldLot?.createdAt || item.purchaseDate || TODAY;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        id: crypto.randomUUID(),
        createdAt: groupKey,
        names: [],
        photos: [],
        items: [],
      });
    }

    const group = groups.get(groupKey);
    group.items.push(item);
    if (item.name) group.names.push(item.name);
    group.photos.push(...normalizePhotos(oldLot?.photos));
    group.photos.push(...normalizePhotos(item.photos));
  });

  const nextLots = [...groups.values()].map((group) => ({
    id: group.id,
    name: makeLotName(group.names),
    createdAt: group.createdAt,
    photos: uniquePhotos(group.photos),
  }));

  const nextGoods = goods.map((item) => {
    const oldLot = lotById.get(item.lotId);
    const groupKey = oldLot?.createdAt || item.purchaseDate || TODAY;
    const group = groups.get(groupKey);
    return {
      ...item,
      lotId: group?.id || item.lotId,
      photos: [],
    };
  });

  return { goods: nextGoods, lots: nextLots };
}

function makeLotName(names) {
  const uniqueNames = [...new Set(names.filter(Boolean))];
  if (!uniqueNames.length) return "Лот";
  if (uniqueNames.length === 1) return uniqueNames[0];
  return `Лот: ${uniqueNames.slice(0, 3).join(", ")}${uniqueNames.length > 3 ? ` +${uniqueNames.length - 3}` : ""}`;
}

function uniquePhotos(photos) {
  const seen = new Set();
  return normalizePhotos(photos).filter((photo) => {
    const key = photo.path || photo.src;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizePhotos(photos) {
  if (!Array.isArray(photos)) return [];
  return photos
    .filter((photo) => photo && photo.src)
    .map((photo) => ({
      id: photo.id || crypto.randomUUID(),
      src: String(photo.src),
      path: String(photo.path || ""),
      name: String(photo.name || "Фото"),
      addedAt: photo.addedAt || TODAY,
    }));
}

function clonePhotos(photos) {
  return normalizePhotos(photos).map((photo) => ({
    ...photo,
    id: crypto.randomUUID(),
  }));
}

function getLot(lotId) {
  return state.lots?.find((lot) => lot.id === lotId);
}

function getGoodsPhotos(item) {
  const ownPhotos = normalizePhotos(item.photos).map((photo) => ({ ...photo, source: "goods" }));
  const lotPhotos = normalizePhotos(getLot(item.lotId)?.photos).map((photo) => ({ ...photo, source: "lot" }));
  return [...ownPhotos, ...lotPhotos];
}

function findGoodsPhoto(item, photoId) {
  return getGoodsPhotos(item).find((photo) => photo.id === photoId);
}

function getLotLabel(lotId) {
  const lot = getLot(lotId);
  return lot?.name || "Без лота";
}

function getFallbackLotKey(item) {
  return [
    item.purchaseDate,
    item.name,
    item.color,
    item.carrier,
    item.spec,
    num(item.priceEur),
    num(item.priceRate),
    num(item.extraEur),
    num(item.extraRate),
  ]
    .map((part) => String(part || "").toLowerCase())
    .join("|");
}

function assignMissingSkus(goods) {
  const used = new Set(goods.map((item) => item.sku).filter(Boolean));
  let next = nextSkuNumber(goods);
  goods.forEach((item) => {
    if (item.sku) return;
    do {
      item.sku = makeSku(next);
      next += 1;
    } while (used.has(item.sku));
    used.add(item.sku);
  });
}

function nextSkuNumber(goods = state.goods) {
  return (
    goods.reduce((max, item) => {
      const match = String(item.sku || "").match(/^PG-(\d+)$/);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1
  );
}

function makeSku(number) {
  return `PG-${String(number).padStart(4, "0")}`;
}

function persistLocalState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function saveState() {
  const locallySaved = persistLocalState();
  setSaveStatus(cloudReady ? "сохранено в облаке" : "сохранено локально");
  if (!locallySaved && !cloudReady) {
    setSaveStatus("не хватает памяти");
  }
  if (cloudReady && !applyingRemoteState) queueCloudSave();
  window.setTimeout(() => {
    setSaveStatus(cloudReady ? "облако активно" : "локально");
  }, 900);
}

function setSaveStatus(text) {
  els.saveState.textContent = text;
}

function queueCloudSave() {
  window.clearTimeout(cloudSaveTimer);
  cloudSaveTimer = window.setTimeout(async () => {
    try {
      setSaveStatus("синхронизация");
      await window.cloudStore.save(state);
      setSaveStatus("облако активно");
    } catch {
      setSaveStatus("ошибка облака");
    }
  }, 450);
}

async function saveCloudNow() {
  if (!cloudReady || applyingRemoteState) return true;
  window.clearTimeout(cloudSaveTimer);
  try {
    setSaveStatus("синхронизация");
    await window.cloudStore.save(state);
    setSaveStatus("облако активно");
    return true;
  } catch (error) {
    console.error(error);
    setSaveStatus("ошибка облака");
    return false;
  }
}

async function initCloudSync() {
  if (!window.cloudStore?.isConfigured()) {
    setSaveStatus("локально");
    showAuthScreen(false);
    return;
  }

  try {
    setSaveStatus("подключение");
    const result = await window.cloudStore.init();
    if (!result.ok) {
      setSaveStatus("локально");
      showAuthScreen(false);
      return;
    }

    if (window.cloudStore.requiresAuth()) {
      const user = await window.cloudStore.getUser();
      if (!user) {
        cloudReady = false;
        showAuthScreen(true);
        setSaveStatus("нужен вход");
        return;
      }
      showAuthScreen(false);
    }

    cloudReady = true;
    setSaveStatus("облако активно");
    const remoteState = await window.cloudStore.load();
    if (remoteState) {
      const needsMigration = num(remoteState.schemaVersion) < 2;
      state = normalizeState(remoteState);
      persistLocalState();
      render();
      if (needsMigration) {
        await window.cloudStore.save(state);
      }
    } else {
      await window.cloudStore.save(state);
    }

    if (!cloudListenerReady) {
      cloudListenerReady = true;
      window.cloudStore.onRemoteState(
        (remoteState) => {
          const normalizedRemoteState = normalizeState(remoteState);
          const hasFreshLocalGoods =
            Date.now() - lastLocalMutationAt < 10000 &&
            normalizedRemoteState.goods.length < state.goods.length;
          if (hasFreshLocalGoods) {
            saveCloudNow();
            return;
          }
          applyingRemoteState = true;
          state = normalizedRemoteState;
          persistLocalState();
          render();
          applyingRemoteState = false;
          setSaveStatus("обновлено из облака");
          window.setTimeout(() => setSaveStatus("облако активно"), 900);
        },
        () => setSaveStatus("ошибка облака"),
      );
    }

  } catch {
    cloudReady = false;
    setSaveStatus("локально");
  }
}

function showAuthScreen(show) {
  els.authScreen?.classList.toggle("hidden", !show);
  els.logoutButton?.classList.toggle("hidden", show || !window.cloudStore?.requiresAuth());
  if (!show && els.authError) els.authError.textContent = "";
}

function money(value, currency = "RUB") {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "RUB" ? 0 : 2,
  }).format(Number(value) || 0);
}

function num(value) {
  return Number(value) || 0;
}

function inputValue(value) {
  return escapeHtml(value ?? "");
}

function accountRub(account) {
  return num(account.balance) * num(account.rate);
}

function goodsPriceRub(item) {
  return num(item.priceEur) * (num(item.priceRate) || 0);
}

function goodsExtraRub(item) {
  return num(item.extraEur) * (num(item.extraRate) || 0);
}

function goodsDeliveryRub(item) {
  if (num(item.deliveryRub)) return num(item.deliveryRub);
  return num(item.deliveryEur) * (num(item.deliveryRate) || 0);
}

function goodsRub(item) {
  return goodsPriceRub(item) + goodsExtraRub(item) + goodsDeliveryRub(item);
}

function goodsEur(item) {
  const deliveryRate = num(item.deliveryRate) || getAverageAccountRate() || 1;
  const deliveryEur = num(item.deliveryEur) || num(item.deliveryRub) / deliveryRate;
  return num(item.priceEur) + num(item.extraEur) + deliveryEur;
}

function averageGoodsRate(goods = state.goods) {
  const totalEur = goods.reduce((sum, item) => sum + goodsEur(item), 0);
  const totalRub = goods.reduce((sum, item) => sum + goodsRub(item), 0);
  return totalEur ? totalRub / totalEur : 0;
}

function getAccountName(id) {
  return state.accounts.find((account) => account.id === id)?.name || "Карта евро";
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(
    new Date(`${value}T12:00:00`),
  );
}

function emptyNode(text = "Добавьте первую запись через форму выше.") {
  const node = document.querySelector("#empty-template").content.firstElementChild.cloneNode(true);
  node.querySelector("span").textContent = text;
  return node;
}

function render() {
  renderMetrics();
  renderAccounts();
  renderAccountSelects();
  renderOperations();
  renderGoods();
  renderArrivals();
}

function renderMetrics() {
  const cardAccount = state.accounts.find((account) => account.id === "euro-card") || state.accounts[0];
  const cashAccount = state.accounts.find((account) => account.id === "euro-cash") || state.accounts[1] || state.accounts[0];
  const goodsRubTotal = state.goods.reduce((sum, item) => sum + goodsRub(item), 0);
  const goodsEurTotal = state.goods.reduce((sum, item) => sum + goodsEur(item), 0);
  const goodsRate = averageGoodsRate();
  const activeGoods = state.goods.filter((item) => item.status !== "arrived").slice(0, 5);

  document.querySelector("#metric-card-rub").textContent = money(accountRub(cardAccount));
  document.querySelector("#metric-card-eur").textContent = `${money(cardAccount?.balance, "EUR")} · курс ${num(cardAccount?.rate).toFixed(2)}`;
  document.querySelector("#metric-cash-rub").textContent = money(accountRub(cashAccount));
  document.querySelector("#metric-cash-eur").textContent = `${money(cashAccount?.balance, "EUR")} · курс ${num(cashAccount?.rate).toFixed(2)}`;
  document.querySelector("#metric-goods-rub").textContent = money(goodsRubTotal);
  document.querySelector("#metric-goods-eur").textContent = `${money(goodsEurTotal, "EUR")} · средний курс ${goodsRate.toFixed(2)}`;
  document.querySelector("#metric-goods-count").textContent = state.goods.length;
  document.querySelector("#metric-goods-count-money").textContent = `${money(goodsRubTotal)} · ${money(goodsEurTotal, "EUR")}`;

  els.soonGoods.replaceChildren(
    ...(activeGoods.length ? activeGoods.map(renderMiniGoods) : [emptyNode("Товары появятся здесь после ввода партии.")]),
  );
}

function renderAccounts() {
  els.accountsSummary.replaceChildren(
    ...state.accounts.map((account) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td><strong>${escapeHtml(account.name)}</strong></td>
        <td>${money(account.balance, "EUR")}</td>
        <td>${num(account.rate).toFixed(2)}</td>
        <td><strong>${money(accountRub(account))}</strong></td>
      `;
      return row;
    }),
  );

  els.accountTotalList.replaceChildren(
    ...state.accounts.map((account) => {
      const card = document.createElement("article");
      card.className = "mini-card";
      card.innerHTML = `
        <div class="mini-row">
          <strong>${escapeHtml(account.name)}</strong>
          <span>${num(account.rate).toFixed(2)} ₽/€</span>
        </div>
        <div class="mini-row">
          <span>${money(account.balance, "EUR")}</span>
          <strong>${money(accountRub(account))}</strong>
        </div>
      `;
      return card;
    }),
  );

  els.accountsEditor.replaceChildren(
    ...state.accounts.map((account) => {
      const card = document.createElement("article");
      card.className = "account-editor-card";
      card.innerHTML = `
        <div class="panel-head">
          <h3>${escapeHtml(account.name)}</h3>
          <span class="muted" data-account-rub="${account.id}">${money(accountRub(account))}</span>
        </div>
        <div class="inline-fields">
          <label>
            Сумма в евро
            <input name="balance-${account.id}" type="number" step="0.01" min="0" value="${num(account.balance)}" data-account-input="${account.id}" />
          </label>
          <label>
            Курс
            <input name="rate-${account.id}" type="number" step="0.01" min="0" value="${num(account.rate)}" data-account-input="${account.id}" />
          </label>
        </div>
      `;
      return card;
    }),
  );
}

function renderAccountSelects() {
  const options = state.accounts.map((account) => {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = `${account.name} · EUR`;
    return option;
  });

  els.operationAccount.replaceChildren(...options);
}

function renderOperations() {
  const rows = state.operations
    .filter((op) => operationFilter === "all" || op.type === operationFilter)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((op) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${formatDate(op.date)}</td>
        <td>${op.type === "income" ? "Приход" : "Расход"}</td>
        <td>${escapeHtml(getAccountName(op.accountId))}</td>
        <td><strong>${money(op.amount, "EUR")}</strong></td>
        <td>${money(num(op.amount) * (num(op.rate) || 0))}</td>
        <td>${escapeHtml(op.note || "")}</td>
        <td><button class="delete-button" type="button" data-delete-operation="${op.id}" title="Удалить">×</button></td>
      `;
      return row;
    });

  els.operationsTable.replaceChildren(...(rows.length ? rows : []));
}

function renderGoods() {
  const query = goodsSearch.trim().toLowerCase();
  const filtered = state.goods
    .filter((item) => goodsFilter === "all" || item.status === goodsFilter)
    .filter((item) => {
      if (!query) return true;
      return [item.sku, item.name, item.color, item.spec, item.carrier, getLotLabel(item.lotId)]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => {
      if (a.status === "arrived" && b.status !== "arrived") return 1;
      if (a.status !== "arrived" && b.status === "arrived") return -1;
      return b.purchaseDate.localeCompare(a.purchaseDate);
    });

  const totalRub = filtered.reduce((sum, item) => sum + goodsRub(item), 0);
  const totalEur = filtered.reduce((sum, item) => sum + goodsEur(item), 0);

  document.querySelector("#goods-total-rub").textContent = money(totalRub);
  document.querySelector("#goods-total-eur").textContent = money(totalEur, "EUR");
  const groups = groupGoodsByLot(filtered);
  els.goodsCount.textContent = `${filtered.length} ${plural(filtered.length, ["позиция", "позиции", "позиций"])} · ${
    groups.length
  } ${plural(groups.length, ["лот", "лота", "лотов"])}`;
  els.goodsList.replaceChildren(
    ...(groups.length ? groups.map(renderLotGroup) : [emptyNode("Начните ввод партии, чтобы быстро занести несколько товаров.")]),
  );
  renderStatusSummary();
}

function groupGoodsByLot(items) {
  const groups = new Map();
  items.forEach((item) => {
    const fallbackKey = getFallbackLotKey(item);
    const key = item.lotId || `fallback-${fallbackKey}`;
    if (!groups.has(key)) {
      const lot = getLot(item.lotId);
      groups.set(key, {
        id: key,
        lotId: item.lotId || "",
        title: lot?.name || item.name || "Без названия",
        createdAt: lot?.createdAt || item.purchaseDate || TODAY,
        photos: lot?.photos?.length ? lot.photos : item.photos || [],
        items: [],
      });
    }
    groups.get(key).items.push(item);
  });

  const sorted = [...groups.values()].sort((a, b) => {
    const dateA = a.items.reduce((latest, item) => (item.purchaseDate > latest ? item.purchaseDate : latest), a.createdAt);
    const dateB = b.items.reduce((latest, item) => (item.purchaseDate > latest ? item.purchaseDate : latest), b.createdAt);
    return dateB.localeCompare(dateA);
  });

  if (sorted.length && !sorted.some((group) => expandedLotIds.has(group.id))) {
    expandedLotIds.add(sorted[0].id);
  }

  return sorted;
}

function renderLotGroup(group) {
  const card = document.createElement("article");
  const isExpanded = expandedLotIds.has(group.id);
  const totalRub = group.items.reduce((sum, item) => sum + goodsRub(item), 0);
  const totalEur = group.items.reduce((sum, item) => sum + goodsEur(item), 0);
  const latestDate = group.items.reduce((latest, item) => (item.purchaseDate > latest ? item.purchaseDate : latest), group.createdAt);
  const statuses = Object.keys(statusLabels)
    .map((status) => {
      const count = group.items.filter((item) => item.status === status).length;
      return count ? `<span class="status ${status}">${statusLabels[status]} · ${count}</span>` : "";
    })
    .join("");
  card.className = `lot-card${isExpanded ? " open" : ""}`;
  card.innerHTML = `
    <button class="lot-head" type="button" data-toggle-lot="${escapeHtml(group.id)}" aria-expanded="${isExpanded}">
      <div class="lot-main">
        <span class="lot-kicker">Лот · ${formatDate(latestDate)}</span>
        <strong>${escapeHtml(group.title)}</strong>
        <span>${group.items.length} ${plural(group.items.length, ["товар", "товара", "товаров"])} · ${money(totalRub)} · ${money(
          totalEur,
          "EUR",
        )}</span>
      </div>
      <div class="lot-side">
        <div class="lot-statuses">${statuses}</div>
        <span class="lot-toggle">${isExpanded ? "Свернуть" : "Открыть"}</span>
      </div>
    </button>
    ${renderLotPreviewPhotos(group.photos)}
    ${
      isExpanded
        ? `<div class="lot-items">${group.items.map((item) => renderGoodsCard(item).outerHTML).join("")}</div>`
        : ""
    }
  `;
  return card;
}

function renderLotPreviewPhotos(photos = []) {
  const normalized = normalizePhotos(photos).slice(0, 4);
  if (!normalized.length) return "";
  return `
    <div class="lot-photos">
      ${normalized
        .map(
          (photo) => `
            <img src="${escapeHtml(photo.src)}" alt="Фото лота" />
          `,
        )
        .join("")}
    </div>
  `;
}

function renderStatusSummary() {
  const counts = Object.keys(statusLabels).map((status) => ({
    status,
    count: state.goods.filter((item) => item.status === status).length,
  }));

  els.statusSummary.replaceChildren(
    ...counts.map((item) => {
      const row = document.createElement("div");
      row.className = "status-row";
      row.innerHTML = `
        <span class="status ${item.status}">${statusLabels[item.status]}</span>
        <strong>${item.count}</strong>
      `;
      return row;
    }),
  );
}

function renderMiniGoods(item) {
  const card = document.createElement("article");
  card.className = "mini-card";
  card.innerHTML = `
    <div class="mini-row">
      <strong>${escapeHtml(item.sku)} · ${escapeHtml(item.name)}</strong>
      <span class="status ${item.status}">${statusLabels[item.status]}</span>
    </div>
    <div class="mini-row">
      <span>${escapeHtml([item.color, item.spec].filter(Boolean).join(" · ") || "без характеристики")}</span>
      <strong>${money(goodsRub(item))}</strong>
    </div>
  `;
  return card;
}

function renderGoodsCard(item) {
  const card = document.createElement("article");
  card.className = "goods-card";
  card.innerHTML = `
    <div class="goods-card-head">
      <div>
        <div class="sku-line">${escapeHtml(item.sku)}</div>
        <strong>${escapeHtml(item.name)}</strong>
        <div class="goods-subtitle">${escapeHtml([item.color, item.spec].filter(Boolean).join(" · ") || "характеристика не указана")}</div>
      </div>
      <span class="status ${item.status}">${statusLabels[item.status]}</span>
    </div>
    <div class="goods-meta">
      <span>Дата покупки: ${formatDate(item.purchaseDate)}</span>
      <span>Перевозчик: ${escapeHtml(item.carrier || "не указан")}</span>
      ${item.arrivedAt ? `<span>Прибыл: ${formatDate(item.arrivedAt)}</span>` : ""}
    </div>
    <div class="goods-money">
      <div class="money-chip"><span>Цена EUR</span><strong>${money(item.priceEur, "EUR")}</strong></div>
      <div class="money-chip"><span>Курс цены</span><strong>${num(item.priceRate).toFixed(2)}</strong></div>
      <div class="money-chip"><span>Цена RUB</span><strong>${money(goodsPriceRub(item))}</strong></div>
      <div class="money-chip"><span>Доп. затраты EUR</span><strong>${money(item.extraEur, "EUR")}</strong></div>
      <div class="money-chip"><span>Курс затрат</span><strong>${num(item.extraRate).toFixed(2)}</strong></div>
      <div class="money-chip"><span>Затраты RUB</span><strong>${money(goodsExtraRub(item))}</strong></div>
      <div class="money-chip"><span>Доставка EUR</span><strong>${money(item.deliveryEur, "EUR")}</strong></div>
      <div class="money-chip"><span>Курс доставки</span><strong>${num(item.deliveryRate).toFixed(2)}</strong></div>
      <div class="money-chip"><span>Доставка RUB</span><strong>${money(goodsDeliveryRub(item))}</strong></div>
    </div>
    ${renderPhotoGallery(item)}
    <div class="goods-actions">
      <strong>Итого: ${money(goodsRub(item))} · ${money(goodsEur(item), "EUR")}</strong>
      <div class="actions">
        ${
          item.status !== "arrived"
            ? `<button class="arrive-button" type="button" data-arrive-jump="${item.id}">Принять</button>`
            : ""
        }
        <label class="small-button file-button">
          Добавить фото
          <input type="file" accept="image/*,.jpg,.jpeg,.png,.webp" multiple data-add-photo="${item.id}" />
        </label>
        <button class="small-button" type="button" data-edit-goods="${item.id}">Редактировать</button>
        <button class="delete-button" type="button" data-delete-goods="${item.id}" title="Удалить">×</button>
      </div>
    </div>
  `;
  return card;
}

function renderPhotoGallery(item) {
  const photos = getGoodsPhotos(item);
  if (!photos.length) return "";
  return `
    <div class="photo-grid">
      ${photos
        .map(
          (photo) => `
            <figure class="photo-thumb">
              <a class="photo-open" href="${escapeHtml(photo.src)}" target="_blank" rel="noopener" data-open-photo="${item.id}:${photo.id}" title="Открыть фото">
                <img src="${escapeHtml(photo.src)}" alt="${escapeHtml(item.sku)}" />
                <span class="photo-broken">Фото нужно добавить заново</span>
              </a>
              <button class="photo-remove" type="button" data-remove-photo="${item.id}:${photo.id}" title="Удалить фото">×</button>
            </figure>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderArrivals() {
  const pending = state.goods
    .filter((item) => item.status === "in_transit")
    .sort((a, b) => a.sku.localeCompare(b.sku));

  els.arrivalPending.replaceChildren(
    ...(pending.length ? pending.slice(0, 8).map(renderMiniGoods) : [emptyNode("Нет товаров со статусом «В доставке».")]),
  );
  els.arrivalPendingCount.textContent = `${pending.length} ${plural(pending.length, ["позиция", "позиции", "позиций"])}`;
  els.arrivalList.querySelectorAll(".batch-row").forEach(populateArrivalRowSelect);

  const arrivals = [...state.arrivals].sort((a, b) => b.date.localeCompare(a.date));
  els.arrivalCount.textContent = `${arrivals.length} ${plural(arrivals.length, ["запись", "записи", "записей"])}`;
  els.arrivalLog.replaceChildren(
    ...(arrivals.length ? arrivals.map(renderArrivalCard) : [emptyNode("Журнал заполнится после регистрации первого прибытия.")]),
  );
}

function renderArrivalCard(arrival) {
  const item = state.goods.find((goods) => goods.id === arrival.goodsId);
  const card = document.createElement("article");
  card.className = "arrival-card";
  card.innerHTML = `
    <div class="goods-card-head">
      <div>
        <div class="sku-line">${escapeHtml(item?.sku || "без артикула")}</div>
        <strong>${escapeHtml(item?.name || "Товар удален")}</strong>
        <div class="goods-subtitle">${escapeHtml([item?.color, item?.spec].filter(Boolean).join(" · ") || "характеристика не указана")}</div>
      </div>
      <strong>${formatDate(arrival.date)}</strong>
    </div>
    <div class="goods-money">
      <div class="money-chip"><span>Доставка EUR</span><strong>${money(arrival.deliveryEur, "EUR")}</strong></div>
      <div class="money-chip"><span>Курс доставки</span><strong>${num(arrival.deliveryRate).toFixed(2)}</strong></div>
      <div class="money-chip"><span>Доставка RUB</span><strong>${money(arrival.deliveryRub)}</strong></div>
    </div>
    ${arrival.note ? `<p class="arrival-note">${escapeHtml(arrival.note)}</p>` : ""}
    ${arrival.photos?.length ? renderArrivalPhotos(arrival) : ""}
  `;
  return card;
}

function renderArrivalPhotos(arrival) {
  return `
    <div class="photo-grid">
      ${arrival.photos
        .map(
          (photo) => `
            <figure class="photo-thumb">
              <a class="photo-open" href="${escapeHtml(photo.src)}" target="_blank" rel="noopener" data-open-arrival-photo="${arrival.id}:${photo.id}" title="Открыть фото">
                <img src="${escapeHtml(photo.src)}" alt="Фото прибытия" />
                <span class="photo-broken">Фото нужно добавить заново</span>
              </a>
            </figure>
          `,
        )
        .join("")}
    </div>
  `;
}

function updateAccounts(form) {
  state.accounts = state.accounts.map((account) => ({
    ...account,
    balance: num(form.elements[`balance-${account.id}`]?.value),
    rate: num(form.elements[`rate-${account.id}`]?.value) || 100,
  }));
  commit();
}

function updateAccountPreview(input) {
  const id = input.dataset.accountInput;
  const card = input.closest(".account-editor-card");
  const balance = num(card.querySelector(`[name="balance-${id}"]`)?.value);
  const rate = num(card.querySelector(`[name="rate-${id}"]`)?.value);
  const preview = card.querySelector(`[data-account-rub="${id}"]`);
  if (preview) preview.textContent = money(balance * rate);
}

function addOperation(form) {
  const data = new FormData(form);
  const account = state.accounts.find((item) => item.id === data.get("accountId"));
  if (!account) return;

  const amount = num(data.get("amount"));
  const sign = data.get("type") === "income" ? 1 : -1;
  account.balance = num(account.balance) + amount * sign;
  state.operations.push({
    id: crypto.randomUUID(),
    type: String(data.get("type")),
    date: String(data.get("date")),
    accountId: account.id,
    amount,
    rate: num(account.rate),
    note: String(data.get("note") || "").trim(),
  });
  form.reset();
  form.elements.date.value = TODAY;
  commit();
}

function addBatchRow(values = {}) {
  els.batchForm.classList.remove("hidden");
  const row = els.batchRowTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector('[name="purchaseDate"]').value = values.purchaseDate || TODAY;
  row.querySelector('[name="priceRate"]').value = values.priceRate || getAverageAccountRate();
  row.querySelector('[name="extraRate"]').value = values.extraRate || getAverageAccountRate();
  els.batchList.append(row);
  refreshBatchRows();
  calculateBatchRow(row);
}

function getAverageAccountRate() {
  const rates = state.accounts.map((account) => num(account.rate)).filter(Boolean);
  if (!rates.length) return 100;
  return Number((rates.reduce((sum, rate) => sum + rate, 0) / rates.length).toFixed(2));
}

function calculateBatchRow(row) {
  const priceEur = num(row.querySelector('[name="priceEur"]').value);
  const priceRate = num(row.querySelector('[name="priceRate"]').value);
  const extraEur = num(row.querySelector('[name="extraEur"]').value);
  const extraRate = num(row.querySelector('[name="extraRate"]').value);
  row.querySelector('[name="priceRub"]').value = money(priceEur * priceRate);
  row.querySelector('[name="extraRub"]').value = money(extraEur * extraRate);
}

function refreshBatchRows() {
  els.batchList.querySelectorAll(".batch-row").forEach((row, index) => {
    row.querySelector(".batch-row-title").textContent = `Товар ${index + 1}`;
    const removeButton = row.querySelector("[data-remove-row]");
    removeButton.disabled = els.batchList.children.length === 1;
  });
}

async function addGoodsBatch(form) {
  const rows = [...form.querySelectorAll(".batch-row")];
  let skuNumber = nextSkuNumber();
  const goods = [];
  const batchLotId = crypto.randomUUID();
  const batchLotNames = [];
  const batchLotPhotos = [];
  let batchLotDate = TODAY;

  for (const row of rows) {
    const name = row.querySelector('[name="name"]').value.trim();
    if (!name) continue;

    const quantityInput = row.querySelector('[name="quantity"]');
    const quantityValue = Number.parseInt(quantityInput?.value || "1", 10);
    const quantity = Math.min(Math.max(Number.isFinite(quantityValue) ? quantityValue : 1, 1), 500);
    const lotPhotos = await filesToPhotos(row.querySelector('[name="photos"]').files);
    batchLotNames.push(name);
    batchLotPhotos.push(...lotPhotos);
    const status = row.querySelector('[name="status"]').value;
    const purchaseDate = row.querySelector('[name="purchaseDate"]').value || TODAY;
    if (purchaseDate < batchLotDate) batchLotDate = purchaseDate;
    const baseItem = {
      purchaseDate,
      name,
      color: row.querySelector('[name="color"]').value.trim(),
      carrier: row.querySelector('[name="carrier"]').value.trim(),
      spec: row.querySelector('[name="spec"]').value.trim(),
      priceEur: num(row.querySelector('[name="priceEur"]').value),
      priceRate: num(row.querySelector('[name="priceRate"]').value) || 100,
      extraEur: num(row.querySelector('[name="extraEur"]').value),
      extraRate: num(row.querySelector('[name="extraRate"]').value) || 100,
      status,
      arrivedAt: status === "arrived" ? TODAY : "",
      deliveryEur: 0,
      deliveryRate: getAverageAccountRate(),
      deliveryRub: 0,
      lotId: batchLotId,
    };

    for (let index = 0; index < quantity; index += 1) {
      goods.push({
        id: crypto.randomUUID(),
        sku: makeSku(skuNumber++),
        ...baseItem,
        photos: [],
      });
    }
  }

  if (!goods.length) {
    alert("Заполните хотя бы одно название товара.");
    return;
  }

  const uniqueNames = [...new Set(batchLotNames)];
  const lotName =
    uniqueNames.length === 1
      ? uniqueNames[0]
      : `Лот: ${uniqueNames.slice(0, 3).join(", ")}${uniqueNames.length > 3 ? ` +${uniqueNames.length - 3}` : ""}`;
  state.lots = [
    ...(state.lots || []),
    {
      id: batchLotId,
      name: lotName,
      createdAt: batchLotDate,
      photos: batchLotPhotos,
    },
  ];
  expandedLotIds.add(batchLotId);
  state.goods.push(...goods);
  goodsFilter = "all";
  goodsSearch = "";
  document.querySelector("#goods-status-filter").value = "all";
  document.querySelector("#goods-search").value = "";
  form.reset();
  els.batchList.replaceChildren();
  els.batchForm.classList.add("hidden");
  commit();
  const cloudSaved = await saveCloudNow();
  if (!cloudSaved) {
    alert("Товар появился на экране, но облако не приняло сохранение. Попробуйте сохранить без фото или уменьшить количество фото.");
    return;
  }
  alert(`Добавлено ${goods.length} ${plural(goods.length, ["товар", "товара", "товаров"])}.`);
}

function addArrivalRow(selectedGoodsId = "") {
  els.arrivalForm.classList.remove("hidden");
  const row = els.arrivalRowTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector('[name="arrivalDate"]').value = TODAY;
  row.querySelector('[name="deliveryRate"]').value = getAverageAccountRate();
  els.arrivalList.append(row);
  populateArrivalRowSelect(row, selectedGoodsId);
  refreshArrivalRows();
}

function getArrivalGoodsOptions(selectedGoodsId = "") {
  const selected = state.goods.find((item) => item.id === selectedGoodsId);
  const goods = state.goods
    .filter((item) => item.status === "in_transit" || item.id === selectedGoodsId)
    .sort((a, b) => a.sku.localeCompare(b.sku));
  return selected && !goods.some((item) => item.id === selected.id) ? [selected, ...goods] : goods;
}

function populateArrivalRowSelect(row, selectedGoodsId = row.querySelector('[name="goodsId"]').value) {
  const select = row.querySelector('[name="goodsId"]');
  const options = getArrivalGoodsOptions(selectedGoodsId).map((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.sku} · ${item.name}${item.color ? ` · ${item.color}` : ""}`;
    return option;
  });

  if (!options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Нет товаров в доставке";
    select.replaceChildren(option);
    select.disabled = true;
    return;
  }

  select.replaceChildren(...options);
  select.disabled = false;
  select.value = selectedGoodsId || options[0].value;
}

function calculateArrivalRow(row) {
  const deliveryEur = num(row.querySelector('[name="deliveryEur"]').value);
  const deliveryRate = num(row.querySelector('[name="deliveryRate"]').value);
  const deliveryRub = row.querySelector('[name="deliveryRub"]');
  if (deliveryEur && deliveryRate) {
    deliveryRub.value = Number((deliveryEur * deliveryRate).toFixed(2));
  }
}

function refreshArrivalRows() {
  els.arrivalList.querySelectorAll(".batch-row").forEach((row, index) => {
    row.querySelector(".batch-row-title").textContent = `Прибытие ${index + 1}`;
    const removeButton = row.querySelector("[data-remove-arrival-row]");
    removeButton.disabled = els.arrivalList.children.length === 1;
  });
}

function addArrivalsBatch(form) {
  const rows = [...form.querySelectorAll(".batch-row")];
  const arrivals = rows
    .map((row) => {
      const goodsId = row.querySelector('[name="goodsId"]').value;
      const item = state.goods.find((goods) => goods.id === goodsId);
      if (!item) return null;

      const deliveryRate = num(row.querySelector('[name="deliveryRate"]').value) || getAverageAccountRate();
      const deliveryEur = num(row.querySelector('[name="deliveryEur"]').value);
      const deliveryRub = num(row.querySelector('[name="deliveryRub"]').value) || deliveryEur * deliveryRate;
      const date = row.querySelector('[name="arrivalDate"]').value || TODAY;
      item.status = "arrived";
      item.arrivedAt = date;
      item.deliveryEur = deliveryEur;
      item.deliveryRate = deliveryRate;
      item.deliveryRub = deliveryRub;

      return {
        id: crypto.randomUUID(),
        goodsId: item.id,
        date,
        note: row.querySelector('[name="note"]').value.trim(),
        deliveryEur,
        deliveryRate,
        deliveryRub,
        photos: [],
      };
    })
    .filter(Boolean);

  if (!arrivals.length) {
    alert("Выберите хотя бы один товар в доставке.");
    return;
  }

  state.arrivals.push(...arrivals);
  form.reset();
  els.arrivalList.replaceChildren();
  els.arrivalForm.classList.add("hidden");
  commit();
}

async function filesToPhotos(files) {
  const picked = [...files].filter(isImageFile).slice(0, 8);
  const results = await Promise.allSettled(picked.map(fileToPhoto));
  return results.filter((result) => result.status === "fulfilled").map((result) => result.value);
}

function isImageFile(file) {
  if (file.type?.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name || "");
}

function fileToPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const image = new Image();
      image.addEventListener("load", () => {
        const maxSize = 520;
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.55);
        resolve({
          id: crypto.randomUUID(),
          src: dataUrl,
          path: "",
          name: file.name,
          addedAt: TODAY,
        });
      });
      image.addEventListener("error", reject);
      image.src = String(reader.result);
    });
    reader.addEventListener("error", reject);
    reader.readAsDataURL(file);
  });
}

function openPhotoViewer(src, title = "Фото") {
  if (!src) return;
  const viewer = document.createElement("div");
  viewer.className = "photo-viewer";
  viewer.innerHTML = `
    <button class="photo-viewer-close" type="button" title="Закрыть">×</button>
    <img src="${escapeHtml(src)}" alt="${escapeHtml(title)}" />
    <div class="photo-viewer-error">Это старое фото не открывается. Удалите его и добавьте JPEG заново.</div>
  `;
  const image = viewer.querySelector("img");
  image.addEventListener("error", () => viewer.classList.add("is-broken"));
  image.addEventListener("load", () => viewer.classList.remove("is-broken"));
  viewer.addEventListener("click", (event) => {
    if (event.target === viewer || event.target.closest(".photo-viewer-close")) {
      viewer.remove();
    }
  });
  document.body.append(viewer);
}

async function addPhotosToGoods(goodsId, files) {
  const item = state.goods.find((goods) => goods.id === goodsId);
  if (!item) return;
  const photos = await filesToPhotos(files);
  if (!photos.length) {
    alert("Фото не добавилось. Выберите обычный JPEG/JPG или PNG.");
    return;
  }
  const lot = getLot(item.lotId);
  if (lot) {
    lot.photos = [...(lot.photos || []), ...photos];
  } else {
    item.photos = [...(item.photos || []), ...photos];
  }
  commit();
}

function openGoodsEditor(itemId) {
  const item = state.goods.find((goods) => goods.id === itemId);
  if (!item) return;

  const editor = document.createElement("div");
  editor.className = "edit-viewer";
  editor.innerHTML = `
    <form class="edit-card" id="goods-edit-form" data-goods-id="${item.id}">
      <div class="panel-head">
        <div>
          <p class="eyebrow">${escapeHtml(item.sku)}</p>
          <h3>Редактировать товар</h3>
        </div>
        <button class="delete-button" type="button" data-close-edit title="Закрыть">×</button>
      </div>
      <div class="edit-grid">
        <label>
          Дата покупки
          <input name="purchaseDate" type="date" value="${inputValue(item.purchaseDate || TODAY)}" required />
        </label>
        <label>
          Название
          <input name="name" value="${inputValue(item.name)}" required />
        </label>
        <label>
          Цвет
          <input name="color" value="${inputValue(item.color)}" />
        </label>
        <label>
          Перевозчик
          <input name="carrier" value="${inputValue(item.carrier)}" />
        </label>
        <label class="wide-field">
          Характеристика
          <input name="spec" value="${inputValue(item.spec)}" />
        </label>
        <label>
          Цена EUR
          <input name="priceEur" type="number" step="0.01" min="0" value="${inputValue(item.priceEur)}" data-edit-calc />
        </label>
        <label>
          Курс цены
          <input name="priceRate" type="number" step="0.01" min="0" value="${inputValue(item.priceRate)}" data-edit-calc />
        </label>
        <label>
          Цена RUB
          <input name="priceRub" type="text" readonly value="${money(goodsPriceRub(item))}" />
        </label>
        <label>
          Доп. затраты EUR
          <input name="extraEur" type="number" step="0.01" min="0" value="${inputValue(item.extraEur)}" data-edit-calc />
        </label>
        <label>
          Курс затрат
          <input name="extraRate" type="number" step="0.01" min="0" value="${inputValue(item.extraRate)}" data-edit-calc />
        </label>
        <label>
          Затраты RUB
          <input name="extraRub" type="text" readonly value="${money(goodsExtraRub(item))}" />
        </label>
        <label>
          Статус
          <select name="status">
            <option value="bought" ${item.status === "bought" ? "selected" : ""}>Выкуплен</option>
            <option value="in_transit" ${item.status === "in_transit" ? "selected" : ""}>В доставке</option>
            <option value="arrived" ${item.status === "arrived" ? "selected" : ""}>Прибыл</option>
          </select>
        </label>
        <label>
          Дата прибытия
          <input name="arrivedAt" type="date" value="${inputValue(item.arrivedAt)}" />
        </label>
        <label>
          Доставка EUR
          <input name="deliveryEur" type="number" step="0.01" min="0" value="${inputValue(item.deliveryEur)}" data-edit-calc />
        </label>
        <label>
          Курс доставки
          <input name="deliveryRate" type="number" step="0.01" min="0" value="${inputValue(item.deliveryRate)}" data-edit-calc />
        </label>
        <label>
          Доставка RUB
          <input name="deliveryRub" type="number" step="0.01" min="0" value="${inputValue(item.deliveryRub)}" />
        </label>
        <label class="wide-field">
          Добавить фото
          <input name="photos" type="file" accept="image/*" multiple />
          <small>Можно выбрать несколько фото сразу.</small>
        </label>
      </div>
      <div class="goods-actions">
        <strong id="edit-total">${money(goodsRub(item))} · ${money(goodsEur(item), "EUR")}</strong>
        <div class="actions">
          <button class="small-button" type="button" data-close-edit>Отмена</button>
          <button class="primary-button" type="submit">Сохранить</button>
        </div>
      </div>
    </form>
  `;
  editor.addEventListener("click", (event) => {
    if (event.target === editor || event.target.closest("[data-close-edit]")) {
      editor.remove();
    }
  });
  document.body.append(editor);
}

function calculateEditForm(form) {
  const priceRub = num(form.elements.priceEur.value) * num(form.elements.priceRate.value);
  const extraRub = num(form.elements.extraEur.value) * num(form.elements.extraRate.value);
  const deliveryEurRub = num(form.elements.deliveryEur.value) * num(form.elements.deliveryRate.value);
  const deliveryRub = num(form.elements.deliveryRub.value) || deliveryEurRub;
  form.elements.priceRub.value = money(priceRub);
  form.elements.extraRub.value = money(extraRub);
  form.querySelector("#edit-total").textContent = `${money(priceRub + extraRub + deliveryRub)} · ${money(
    num(form.elements.priceEur.value) + num(form.elements.extraEur.value) + num(form.elements.deliveryEur.value),
    "EUR",
  )}`;
}

async function saveGoodsEdit(form) {
  const item = state.goods.find((goods) => goods.id === form.dataset.goodsId);
  if (!item) return;

  const status = form.elements.status.value;
  const addedPhotos = await filesToPhotos(form.elements.photos.files);
  item.purchaseDate = form.elements.purchaseDate.value || TODAY;
  item.name = form.elements.name.value.trim();
  item.color = form.elements.color.value.trim();
  item.carrier = form.elements.carrier.value.trim();
  item.spec = form.elements.spec.value.trim();
  item.priceEur = num(form.elements.priceEur.value);
  item.priceRate = num(form.elements.priceRate.value) || 100;
  item.extraEur = num(form.elements.extraEur.value);
  item.extraRate = num(form.elements.extraRate.value) || 100;
  item.status = status;
  item.arrivedAt = form.elements.arrivedAt.value || (status === "arrived" ? TODAY : "");
  item.deliveryEur = num(form.elements.deliveryEur.value);
  item.deliveryRate = num(form.elements.deliveryRate.value) || getAverageAccountRate();
  item.deliveryRub = num(form.elements.deliveryRub.value);
  const lot = getLot(item.lotId);
  if (lot) {
    lot.photos = [...(lot.photos || []), ...addedPhotos];
  } else {
    item.photos = [...(item.photos || []), ...addedPhotos];
  }
  form.closest(".edit-viewer")?.remove();
  commit();
}

function commit() {
  if (!applyingRemoteState) {
    lastLocalMutationAt = Date.now();
  }
  render();
  saveState();
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `poryadochny-gadget-eu-finance-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (!Array.isArray(parsed.accounts) || !Array.isArray(parsed.goods) || !Array.isArray(parsed.operations)) {
        throw new Error("bad shape");
      }
      state = normalizeState(parsed);
      commit();
    } catch {
      alert("Не получилось прочитать файл. Нужен JSON, экспортированный из этого приложения.");
    }
  });
  reader.readAsText(file);
}

function plural(count, forms) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-button").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
    button.classList.add("active");
    document.querySelector(`#${button.dataset.view}-view`).classList.add("active");
    els.viewTitle.textContent = button.textContent;
  });
});

document.querySelectorAll("[data-view-jump]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector(`[data-view="${button.dataset.viewJump}"]`).click();
  });
});

els.authForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const email = String(data.get("email") || "").trim();
  const password = String(data.get("password") || "");

  try {
    els.authError.textContent = "";
    setSaveStatus("вход");
    await window.cloudStore.signIn(email, password);
    await initCloudSync();
  } catch (error) {
    els.authError.textContent = "Не получилось войти. Проверьте email и пароль.";
    setSaveStatus("нужен вход");
  }
});

els.logoutButton?.addEventListener("click", async () => {
  await window.cloudStore?.signOut();
  cloudReady = false;
  cloudListenerReady = false;
  showAuthScreen(true);
  setSaveStatus("нужен вход");
});

document.querySelector("#accounts-form").addEventListener("submit", (event) => {
  event.preventDefault();
  updateAccounts(event.currentTarget);
});

document.querySelector("#accounts-editor").addEventListener("input", (event) => {
  const input = event.target.closest("[data-account-input]");
  if (input) updateAccountPreview(input);
});

document.querySelector("#operation-form").addEventListener("submit", (event) => {
  event.preventDefault();
  addOperation(event.currentTarget);
});

document.querySelector("#start-batch-button").addEventListener("click", () => {
  if (!els.batchList.children.length) addBatchRow();
  els.batchForm.classList.remove("hidden");
});

document.querySelector("#add-goods-row").addEventListener("click", () => addBatchRow());

els.batchList.addEventListener("input", (event) => {
  if (event.target.closest("[data-calc]")) {
    calculateBatchRow(event.target.closest(".batch-row"));
  }
});

els.batchList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-row]");
  if (!button || els.batchList.children.length <= 1) return;
  button.closest(".batch-row").remove();
  refreshBatchRows();
});

document.querySelector("#goods-batch-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const previousText = submitButton?.textContent || "";
  try {
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Сохраняю...";
    }
    await addGoodsBatch(form);
  } catch (error) {
    console.error(error);
    alert("Партия не сохранилась. Попробуйте добавить без фото или пришлите мне скрин ошибки.");
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = previousText;
    }
  }
});

document.querySelector("#start-arrival-button").addEventListener("click", () => {
  if (!els.arrivalList.children.length) addArrivalRow();
  els.arrivalForm.classList.remove("hidden");
});

document.querySelector("#add-arrival-row").addEventListener("click", () => addArrivalRow());

els.arrivalList.addEventListener("input", (event) => {
  if (event.target.closest("[data-arrival-calc]")) {
    calculateArrivalRow(event.target.closest(".batch-row"));
  }
});

els.arrivalList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-arrival-row]");
  if (!button || els.arrivalList.children.length <= 1) return;
  button.closest(".batch-row").remove();
  refreshArrivalRows();
});

document.querySelector("#arrival-form").addEventListener("submit", (event) => {
  event.preventDefault();
  addArrivalsBatch(event.currentTarget);
});

document.querySelector("#operation-filter").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  operationFilter = button.dataset.filter;
  document.querySelectorAll("#operation-filter button").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  renderOperations();
});

document.querySelector("#goods-status-filter").addEventListener("change", (event) => {
  goodsFilter = event.target.value;
  renderGoods();
});

document.querySelector("#goods-search").addEventListener("input", (event) => {
  goodsSearch = event.target.value;
  renderGoods();
});

document.addEventListener("click", (event) => {
  const toggleLot = event.target.closest("[data-toggle-lot]");
  if (toggleLot) {
    const lotId = toggleLot.dataset.toggleLot;
    if (expandedLotIds.has(lotId)) {
      expandedLotIds.delete(lotId);
    } else {
      expandedLotIds.add(lotId);
    }
    renderGoods();
  }

  const arriveJump = event.target.closest("[data-arrive-jump]");
  if (arriveJump) {
    document.querySelector('[data-view="arrivals"]').click();
    if (!els.arrivalList.children.length) {
      addArrivalRow(arriveJump.dataset.arriveJump);
    } else {
      populateArrivalRowSelect(els.arrivalList.querySelector(".batch-row"), arriveJump.dataset.arriveJump);
    }
    els.arrivalForm.classList.remove("hidden");
  }

  const editGoods = event.target.closest("[data-edit-goods]");
  if (editGoods) {
    openGoodsEditor(editGoods.dataset.editGoods);
  }

  const deleteGoods = event.target.closest("[data-delete-goods]");
  if (deleteGoods && confirm("Удалить товар?")) {
    state.goods = state.goods.filter((item) => item.id !== deleteGoods.dataset.deleteGoods);
    state.arrivals = state.arrivals.filter((arrival) => arrival.goodsId !== deleteGoods.dataset.deleteGoods);
    commit();
  }

  const removePhoto = event.target.closest("[data-remove-photo]");
  if (removePhoto) {
    const [goodsId, photoId] = removePhoto.dataset.removePhoto.split(":");
    const item = state.goods.find((goods) => goods.id === goodsId);
    if (item) {
      item.photos = (item.photos || []).filter((photo) => photo.id !== photoId);
      const lot = getLot(item.lotId);
      if (lot) {
        lot.photos = (lot.photos || []).filter((photo) => photo.id !== photoId);
      }
      commit();
    }
  }

  const openPhoto = event.target.closest("[data-open-photo]");
  if (openPhoto) {
    event.preventDefault();
    const [goodsId, photoId] = openPhoto.dataset.openPhoto.split(":");
    const item = state.goods.find((goods) => goods.id === goodsId);
    const photo = item ? findGoodsPhoto(item, photoId) : null;
    openPhotoViewer(photo?.src, item?.sku || "Фото товара");
  }

  const openArrivalPhoto = event.target.closest("[data-open-arrival-photo]");
  if (openArrivalPhoto) {
    event.preventDefault();
    const [arrivalId, photoId] = openArrivalPhoto.dataset.openArrivalPhoto.split(":");
    const arrival = state.arrivals.find((entry) => entry.id === arrivalId);
    const photo = arrival?.photos?.find((entry) => entry.id === photoId);
    openPhotoViewer(photo?.src, "Фото прибытия");
  }

  const deleteOperation = event.target.closest("[data-delete-operation]");
  if (deleteOperation && confirm("Удалить операцию? Остаток счета не изменится автоматически.")) {
    state.operations = state.operations.filter((item) => item.id !== deleteOperation.dataset.deleteOperation);
    commit();
  }
});

document.addEventListener("input", (event) => {
  if (event.target.closest("[data-edit-calc]")) {
    calculateEditForm(event.target.closest("#goods-edit-form"));
  }
});

document.addEventListener("submit", async (event) => {
  if (!event.target.matches("#goods-edit-form")) return;
  event.preventDefault();
  await saveGoodsEdit(event.target);
});

document.addEventListener("change", async (event) => {
  const addPhotoInput = event.target.closest("[data-add-photo]");
  if (!addPhotoInput) return;
  await addPhotosToGoods(addPhotoInput.dataset.addPhoto, addPhotoInput.files);
  addPhotoInput.value = "";
});

document.addEventListener(
  "error",
  (event) => {
    const image = event.target;
    if (image instanceof HTMLImageElement && image.closest(".photo-thumb")) {
      image.closest(".photo-thumb").classList.add("is-broken");
    }
  },
  true,
);

document.querySelector("#export-button").addEventListener("click", exportData);
document.querySelector("#settings-export").addEventListener("click", exportData);
document.querySelector("#import-file").addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) importData(file);
  event.target.value = "";
});

document.querySelector("#reset-demo").addEventListener("click", () => {
  if (confirm("Сбросить данные к пустому шаблону?")) {
    state = structuredClone(defaultState);
    commit();
  }
});

document.querySelector("#operation-form").elements.date.value = TODAY;
state = normalizeState(state);
saveState();
render();
initCloudSync();
