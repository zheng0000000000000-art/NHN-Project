const months = [
  { id: 1, name: "1월", season: "겨울" },
  { id: 2, name: "2월", season: "봄" },
  { id: 3, name: "3월", season: "봄" },
  { id: 4, name: "4월", season: "여름" },
  { id: 5, name: "5월", season: "여름" },
  { id: 6, name: "6월", season: "겨울" }
];

const blueprints = [
  ["광", "빛"],
  ["띠", "붉음"],
  ["열", "동물"],
  ["피", "일반"]
];

const stageTargets = [900, 1450, 2200];

const stageRules = [
  {
    id: "first",
    name: "첫 판",
    description: "AI가 아직 당신의 빌드를 읽는 중입니다.",
    applyScore(score) {
      return score;
    }
  },
  {
    id: "light-price",
    name: "빛의 대가",
    description: "광 족보 점수가 오르지만 GO 실패 위험도 커집니다.",
    applyScore(score, state) {
      return score + countByKind(state.captured, "광") * 55;
    }
  },
  {
    id: "greed-table",
    name: "탐욕의 장",
    description: "GO 배수가 더 커지고 STOP 목표도 높아집니다.",
    applyScore(score, state) {
      return Math.round(score * (1 + state.go * 0.12));
    }
  },
  {
    id: "weed-field",
    name: "잡초밭",
    description: "피가 많아졌지만 잡화점과 설중화가 더 강해집니다.",
    applyScore(score, state) {
      return score + countByKind(state.captured, "피") * 35;
    }
  },
  {
    id: "sealed-middle",
    name: "중월 봉인",
    description: "AI가 3월과 4월을 더 자주 걷어가 연속 월을 흔듭니다.",
    applyScore(score) {
      return score;
    }
  },
  {
    id: "mirror-dealer",
    name: "거울 딜러",
    description: "가장 자주 먹은 종류가 다음 점수 계산에 보너스로 반사됩니다.",
    applyScore(score, state) {
      const top = topKind(state.captured);
      return score + (top ? top.count * 45 : 0);
    }
  }
];

const comboCatalog = [
  {
    id: "three-lights",
    name: "삼광",
    score: 300,
    target: 3,
    describe: "광 3장",
    progress: cards => countByKind(cards, "광")
  },
  {
    id: "spring-line",
    name: "봄의 행렬",
    score: 180,
    target: 4,
    describe: "봄 속성 패 4장",
    progress: cards => cards.filter(card => card.season === "봄").length
  },
  {
    id: "twin-month",
    name: "쌍월",
    score: 220,
    target: 2,
    describe: "같은 월 2장 세트 2개",
    progress: cards => monthPairs(cards)
  },
  {
    id: "red-ribbon",
    name: "붉은 띠",
    score: 250,
    target: 3,
    describe: "붉은 띠 3장",
    progress: cards => cards.filter(card => card.kind === "띠" && card.traits.includes("붉음")).length
  },
  {
    id: "empty-branch",
    name: "빈 가지",
    multiplier: 1.5,
    target: 1,
    describe: "피를 2장 이하로 보유",
    progress: cards => (countByKind(cards, "피") <= 2 && cards.length >= 4 ? 1 : 0)
  },
  {
    id: "six-run",
    name: "육화연속",
    score: 320,
    target: 4,
    describe: "연속된 월 4종 획득",
    progress: cards => longestMonthRun(cards)
  },
  {
    id: "market",
    name: "잡화점",
    score: 160,
    target: 4,
    describe: "광·열·띠·피 각각 1장",
    progress: cards => new Set(cards.map(card => card.kind)).size
  },
  {
    id: "solo-light",
    name: "독광",
    score: 200,
    target: 1,
    describe: "광을 정확히 1장만 보유",
    progress: cards => (countByKind(cards, "광") === 1 && cards.length >= 4 ? 1 : 0)
  },
  {
    id: "snow-flower",
    name: "설중화",
    score: 240,
    target: 4,
    describe: "겨울 패와 봄 패 각각 2장",
    progress: cards => Math.min(2, cards.filter(card => card.season === "겨울").length) + Math.min(2, cards.filter(card => card.season === "봄").length)
  },
  {
    id: "no-moon",
    name: "무월",
    multiplier: 1.8,
    target: 1,
    describe: "같은 월을 중복해서 먹지 않음",
    progress: cards => (cards.length >= 5 && new Set(cards.map(card => card.month)).size === cards.length ? 1 : 0)
  },
  {
    id: "animal-call",
    name: "짐승 부름",
    score: 210,
    target: 3,
    describe: "동물 특성 3장",
    progress: cards => cards.filter(card => card.traits.includes("동물")).length
  },
  {
    id: "winter-lamp",
    name: "겨울 등불",
    score: 260,
    target: 3,
    describe: "겨울 패 3장과 광 1장",
    progress: cards => Math.min(3, cards.filter(card => card.season === "겨울").length) + (countByKind(cards, "광") ? 1 : 0),
    completeAt: 4
  }
];

const relicCatalog = [
  {
    id: "calendar",
    name: "뒤집힌 달력",
    description: "산패 맨 위 3장을 확인합니다.",
    use(state) {
      const preview = state.deck.slice(0, 3).map(cardLabel).join(", ") || "산패 없음";
      log(`달력 확인: ${preview}`);
    }
  },
  {
    id: "vase",
    name: "빈 화병",
    description: "피가 2장 이하라면 이번 점수에 +180.",
    use(state) {
      state.relicBonus += countByKind(state.captured, "피") <= 2 ? 180 : 40;
      log("빈 화병 보너스가 점수 계산에 더해졌습니다.");
      updateScore();
    }
  },
  {
    id: "dealer",
    name: "취한 딜러",
    description: "산패 한 장을 즉시 먹거나 바닥에 둡니다.",
    use(state) {
      const drawn = state.deck.shift();
      if (!drawn) {
        log("산패가 비어 있습니다.");
        return;
      }
      const match = state.floor.find(card => card.month === drawn.month);
      if (match) {
        captureCards([drawn, match]);
        state.floor = state.floor.filter(card => card.id !== match.id);
        log(`취한 딜러가 ${cardLabel(drawn)}로 ${cardLabel(match)}를 먹었습니다.`);
      } else {
        state.floor.push(drawn);
        log(`취한 딜러가 ${cardLabel(drawn)}를 바닥에 깔았습니다.`);
      }
      updateScore();
    }
  }
];

const els = {
  hand: document.querySelector("#hand"),
  floor: document.querySelector("#floor"),
  captured: document.querySelector("#captured"),
  combos: document.querySelector("#combos"),
  relics: document.querySelector("#relics"),
  log: document.querySelector("#log"),
  stage: document.querySelector("#stage-label"),
  target: document.querySelector("#target-label"),
  score: document.querySelector("#score-label"),
  banked: document.querySelector("#banked-label"),
  go: document.querySelector("#go-label"),
  deck: document.querySelector("#deck-label"),
  turn: document.querySelector("#turn-label"),
  ruleName: document.querySelector("#rule-name"),
  ruleDescription: document.querySelector("#rule-description"),
  aiRead: document.querySelector("#ai-read"),
  comboCount: document.querySelector("#combo-count"),
  capturedCount: document.querySelector("#captured-count"),
  decision: document.querySelector("#decision"),
  decisionTitle: document.querySelector("#decision-title"),
  stageResult: document.querySelector("#stage-result"),
  resultTitle: document.querySelector("#result-title"),
  resultCopy: document.querySelector("#result-copy"),
  nextStage: document.querySelector("#next-stage")
};

let state;

document.querySelector("#new-run").addEventListener("click", newRun);
document.querySelector("#stop-button").addEventListener("click", stopStage);
document.querySelector("#go-button").addEventListener("click", chooseGo);
els.nextStage.addEventListener("click", nextStage);

newRun();

function newRun() {
  state = {
    stage: 1,
    turn: 1,
    deck: [],
    hand: [],
    floor: [],
    captured: [],
    banked: 0,
    score: 0,
    go: 0,
    pendingDecision: false,
    selectedHandId: null,
    relicBonus: 0,
    usedRelics: new Set(),
    tendencies: {
      light: 0,
      spring: 0,
      go: 0,
      junkAvoid: 0
    },
    combos: comboCatalog.slice(0, 5),
    relics: relicCatalog,
    rule: stageRules[0],
    completeComboIds: new Set(),
    log: []
  };
  els.stageResult.classList.add("hidden");
  els.nextStage.disabled = false;
  setupStage();
  log("런 시작. 손패에서 한 장을 내세요.");
  render();
}

function setupStage() {
  state.turn = 1;
  state.go = 0;
  state.score = 0;
  state.relicBonus = 0;
  state.pendingDecision = false;
  state.selectedHandId = null;
  state.usedRelics.clear();
  state.completeComboIds = new Set();
  state.deck = shuffle(createDeck());
  state.hand = drawMany(5);
  state.floor = drawMany(6);
  state.captured = [];
  state.rule = chooseRule();
}

function createDeck() {
  return months.flatMap(month => blueprints.map(([kind, trait], index) => ({
    id: `${month.id}-${kind}-${index}-${Math.random().toString(16).slice(2)}`,
    month: month.id,
    monthName: month.name,
    season: month.season,
    kind,
    traits: trait === "일반" ? [month.season, trait] : [month.season, trait]
  })));
}

function drawMany(count) {
  return Array.from({ length: count }, () => state.deck.shift()).filter(Boolean);
}

function playCard(cardId) {
  if (state.pendingDecision || els.stageResult.classList.contains("hidden") === false) return;
  const handCard = state.hand.find(card => card.id === cardId);
  if (!handCard) return;
  const matches = state.floor.filter(card => card.month === handCard.month);
  state.hand = state.hand.filter(card => card.id !== cardId);

  if (matches.length) {
    const floorPick = chooseBestMatch(matches);
    state.floor = state.floor.filter(card => card.id !== floorPick.id);
    captureCards([handCard, floorPick]);
    log(`${cardLabel(handCard)}로 ${cardLabel(floorPick)} 획득.`);
  } else {
    state.floor.push(handCard);
    log(`${cardLabel(handCard)}${particle(handCard.kind)} 바닥에 놓았습니다.`);
  }

  drawFromDeck();
  aiTurn();
  state.hand.push(...drawMany(1));
  state.turn += 1;
  updateScore();
  maybeEndByExhaustion();
  render();
}

function drawFromDeck() {
  const drawn = state.deck.shift();
  if (!drawn) return;
  const match = state.floor.find(card => card.month === drawn.month);
  if (match) {
    state.floor = state.floor.filter(card => card.id !== match.id);
    captureCards([drawn, match]);
    log(`산패 ${cardLabel(drawn)}가 ${cardLabel(match)}와 맞아 추가 획득.`);
  } else {
    state.floor.push(drawn);
    log(`산패 ${cardLabel(drawn)} 공개. 바닥에 놓였습니다.`);
  }
}

function aiTurn() {
  if (!state.floor.length || !state.deck.length) return;
  const priorities = aiPriorities();
  const target = state.floor
    .slice()
    .sort((a, b) => priorities.indexOf(b.kind) - priorities.indexOf(a.kind))[0];
  const pressure = state.go + state.stage - 1;
  if (!target || Math.random() > 0.42 + pressure * 0.08) return;
  state.floor = state.floor.filter(card => card.id !== target.id);
  log(`AI 딜러가 ${cardLabel(target)}${particle(target.kind)} 걷어가 핵심 패를 견제했습니다.`);
}

function aiPriorities() {
  if (state.tendencies.light >= Math.max(state.tendencies.spring, 2)) return ["피", "열", "띠", "광"];
  if (state.tendencies.spring >= 2) return ["광", "피", "띠", "열"];
  return ["피", "띠", "열", "광"];
}

function captureCards(cards) {
  state.captured.push(...cards);
  state.tendencies.light += cards.filter(card => card.kind === "광").length;
  state.tendencies.spring += cards.filter(card => card.season === "봄").length;
  state.tendencies.junkAvoid = countByKind(state.captured, "피") <= 2 ? state.tendencies.junkAvoid + 1 : 0;
}

function updateScore() {
  const evaluation = evaluateCombos();
  const base = evaluation.base + state.relicBonus;
  let multiplier = evaluation.multiplier * (1 + state.go * goStep());
  if (evaluation.completed.length >= 3) multiplier *= 1.4;
  state.score = Math.round(state.rule.applyScore(base * multiplier, state));

  const newlyComplete = evaluation.completed.filter(combo => !state.completeComboIds.has(combo.id));
  if (newlyComplete.length) {
    newlyComplete.forEach(combo => state.completeComboIds.add(combo.id));
    state.pendingDecision = true;
    els.score.classList.remove("score-pop");
    requestAnimationFrame(() => els.score.classList.add("score-pop"));
    log(`족보 완성: ${newlyComplete.map(combo => combo.name).join(", ")}.`);
  }
}

function evaluateCombos() {
  return state.combos.reduce((result, combo) => {
    const target = combo.completeAt || combo.target;
    const progress = Math.min(target, combo.progress(state.captured));
    if (progress >= target) {
      result.completed.push(combo);
      if (combo.multiplier) result.multiplier *= combo.multiplier;
      if (combo.score) result.base += combo.score;
    }
    result.progress.set(combo.id, { current: progress, target });
    return result;
  }, { completed: [], base: 0, multiplier: 1, progress: new Map() });
}

function chooseGo() {
  state.go += 1;
  state.tendencies.go += 1;
  state.pendingDecision = false;
  log(`GO ${state.go}. 배수 상승, AI 압박 증가.`);
  render();
}

function stopStage() {
  state.banked += state.score;
  const target = adjustedTarget();
  const cleared = state.score >= target;
  els.stageResult.classList.remove("hidden");
  els.resultTitle.textContent = cleared ? "스테이지 클리어" : "점수 부족";
  els.resultCopy.textContent = cleared
    ? `이번 판 ${state.score.toLocaleString()}점 확정. AI가 다음 변칙을 준비합니다.`
    : `${target.toLocaleString()}점이 필요했지만 ${state.score.toLocaleString()}점에서 멈췄습니다. 새 런으로 재도전하세요.`;
  els.nextStage.disabled = !cleared;
  state.pendingDecision = false;
  render();
}

function nextStage() {
  if (state.stage >= 3) {
    els.resultTitle.textContent = "런 클리어";
    els.resultCopy.textContent = `총 ${state.banked.toLocaleString()}점. AI 딜러의 3스테이지를 돌파했습니다.`;
    els.nextStage.disabled = true;
    return;
  }
  state.stage += 1;
  setupStage();
  els.stageResult.classList.add("hidden");
  log(`${state.stage}스테이지 진입. AI 변칙: ${state.rule.name}.`);
  render();
}

function maybeEndByExhaustion() {
  if (state.hand.length || state.deck.length) return;
  log("더 낼 패가 없어 자동 STOP.");
  stopStage();
}

function chooseRule() {
  if (state.stage === 1) return stageRules[0];
  if (state.tendencies.go >= 1) return stageRules[2];
  if (state.tendencies.light >= 3) return stageRules[1];
  if (state.tendencies.spring >= 4) return stageRules[4];
  if (state.tendencies.junkAvoid >= 3) return stageRules[3];
  return stageRules[state.stage + 1] || stageRules[5];
}

function adjustedTarget() {
  const base = stageTargets[state.stage - 1];
  return state.rule.id === "greed-table" ? Math.round(base * 1.12) : base;
}

function goStep() {
  return state.rule.id === "greed-table" ? 0.65 : 0.38;
}

function render() {
  els.stage.textContent = `${state.stage} / 3`;
  els.target.textContent = adjustedTarget().toLocaleString();
  els.score.textContent = state.score.toLocaleString();
  els.banked.textContent = state.banked.toLocaleString();
  els.go.textContent = state.go;
  els.deck.textContent = state.deck.length;
  els.turn.textContent = `턴 ${state.turn}`;
  els.ruleName.textContent = state.rule.name;
  els.ruleDescription.textContent = state.rule.description;
  els.aiRead.textContent = aiReadText();
  renderCards(els.hand, state.hand, true);
  renderCards(els.floor, state.floor, false);
  renderCards(els.captured, state.captured.slice().reverse(), false, true);
  renderCombos();
  renderRelics();
  renderLog();
  els.capturedCount.textContent = `${state.captured.length}장`;
  els.decision.classList.toggle("hidden", !state.pendingDecision);
  els.decisionTitle.textContent = `${state.score.toLocaleString()}점 달성`;
}

function renderCards(container, cards, interactive, mini = false) {
  container.innerHTML = "";
  const playableMonths = new Set(state.hand.map(card => card.month));
  for (const card of cards) {
    const button = document.createElement(interactive ? "button" : "div");
    button.className = `hwato-card${!interactive && playableMonths.has(card.month) && !mini ? " match" : ""}`;
    button.innerHTML = `
      <span class="month">${card.monthName}</span>
      <span class="kind">${card.kind}</span>
      <span class="tags">${card.traits.map(trait => `<i class="tag">${trait}</i>`).join("")}</span>
    `;
    if (interactive) {
      button.type = "button";
      button.addEventListener("click", () => playCard(card.id));
    }
    container.append(button);
  }
}

function renderCombos() {
  const evaluation = evaluateCombos();
  els.comboCount.textContent = `${evaluation.completed.length} 완성`;
  els.combos.innerHTML = "";
  for (const combo of state.combos) {
    const progress = evaluation.progress.get(combo.id);
    const complete = progress.current >= progress.target;
    const item = document.createElement("article");
    item.className = `combo${complete ? " complete" : ""}`;
    const value = combo.score ? `+${combo.score}` : `x${combo.multiplier}`;
    item.innerHTML = `
      <h3>${combo.name} <span>${value}</span></h3>
      <p>${combo.describe} · ${progress.current}/${progress.target}</p>
      <div class="progress" style="--value:${Math.min(100, progress.current / progress.target * 100)}%"><i></i></div>
    `;
    els.combos.append(item);
  }
}

function renderRelics() {
  els.relics.innerHTML = "";
  for (const relic of state.relics) {
    const item = document.createElement("article");
    const used = state.usedRelics.has(relic.id);
    item.className = "relic";
    item.innerHTML = `<h3>${relic.name}</h3><p>${relic.description}</p>`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = used ? "사용함" : "사용";
    button.disabled = used;
    button.addEventListener("click", () => {
      state.usedRelics.add(relic.id);
      relic.use(state);
      render();
    });
    item.append(button);
    els.relics.append(item);
  }
}

function renderLog() {
  els.log.innerHTML = "";
  for (const entry of state.log.slice(-12).reverse()) {
    const item = document.createElement("li");
    item.textContent = entry;
    els.log.append(item);
  }
}

function log(message) {
  state.log.push(message);
}

function cardLabel(card) {
  return `${card.monthName} ${card.kind}`;
}

function particle(word, consonant = "을", vowel = "를") {
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return vowel;
  return (code - 0xac00) % 28 === 0 ? vowel : consonant;
}

function chooseBestMatch(matches) {
  return matches.slice().sort((a, b) => kindWeight(b.kind) - kindWeight(a.kind))[0];
}

function kindWeight(kind) {
  return { "광": 4, "띠": 3, "열": 2, "피": 1 }[kind] || 0;
}

function countByKind(cards, kind) {
  return cards.filter(card => card.kind === kind).length;
}

function monthPairs(cards) {
  const counts = new Map();
  cards.forEach(card => counts.set(card.month, (counts.get(card.month) || 0) + 1));
  return [...counts.values()].filter(count => count >= 2).length;
}

function longestMonthRun(cards) {
  const unique = [...new Set(cards.map(card => card.month))].sort((a, b) => a - b);
  let best = 0;
  let current = 0;
  let previous = 0;
  for (const month of unique) {
    current = month === previous + 1 ? current + 1 : 1;
    previous = month;
    best = Math.max(best, current);
  }
  return best;
}

function topKind(cards) {
  const counts = ["광", "띠", "열", "피"].map(kind => ({ kind, count: countByKind(cards, kind) }));
  return counts.sort((a, b) => b.count - a.count)[0];
}

function aiReadText() {
  if (state.tendencies.go >= 2) return "GO 욕심 감지";
  if (state.tendencies.light >= 3) return "광 중심 빌드 감지";
  if (state.tendencies.spring >= 4) return "봄/연속 월 선호";
  if (state.tendencies.junkAvoid >= 3) return "피 회피 성향";
  return "빌드 관찰 중";
}

function shuffle(items) {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}
