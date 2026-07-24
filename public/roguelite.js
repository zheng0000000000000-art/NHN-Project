let session = null;

const $ = (selector) => document.querySelector(selector);
const money = (value) => `${Math.round(Number(value) || 0).toLocaleString('ko-KR')} G`;
const percent = (value) => `${Number(value || 0).toFixed(1)}%`;

$('#new-game').addEventListener('click', async () => {
  try {
    const payload = await api('/api/balance/play/sessions', {
      method: 'POST',
      body: { seed: Date.now() },
    });
    session = payload.session;
    render();
  } catch (error) {
    showError(error);
  }
});

$('#buy-appraisal').addEventListener('click', () => act('BUY_APPRAISAL'));
$('#buy-demand').addEventListener('click', () => act('BUY_DEMAND'));
$('#pass').addEventListener('click', () => act('PASS'));
$('#guide-toggle').addEventListener('click', () => {
  const body = $('#guide-body');
  const collapsed = !body.classList.contains('hidden');
  body.classList.toggle('hidden', collapsed);
  $('#guide-toggle').textContent = collapsed ? '설명 펼치기' : '설명 접기';
  $('#guide-toggle').setAttribute('aria-expanded', String(!collapsed));
});
$('#bid-form').addEventListener('submit', (event) => {
  event.preventDefault();
  act('BID', { amount: Number($('#bid-amount').value) });
});

async function act(type, details = {}) {
  if (!session) return;
  setBusy(true);
  try {
    const payload = await api(`/api/balance/play/sessions/${encodeURIComponent(session.id)}/actions`, {
      method: 'POST',
      body: { type, ...details },
    });
    session = payload.session;
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
}

function render() {
  $('#empty-state').classList.toggle('hidden', Boolean(session));
  $('#game').classList.toggle('hidden', !session);
  if (!session) return;
  const economy = session.economy;
  $('#cash').textContent = money(economy.cash);
  $('#roi').textContent = `수익률 ${percent(economy.roiPercent)}`;
  $('#info-spend').textContent = money(economy.informationSpent);
  $('#wins').textContent = `${economy.wins}회`;
  $('#profit').textContent = `실현손익 ${money(economy.realizedProfit)}`;
  $('#progress').textContent = `${session.progress.completed} / ${session.progress.total} 물건`;

  if (session.currentLot) {
    const lot = session.currentLot;
    $('#day').textContent = `${lot.day}일차`;
    $('#lot-slot').textContent = `LOT ${lot.index}`;
    $('#lot-title').textContent = `${lot.gradeId.toUpperCase()} · ${lot.category}`;
    $('#start-bid').textContent = money(lot.startBid);
    $('#blind-estimate').textContent = money(lot.blindEstimate);
    reveal('#appraisal-estimate', lot.appraisalEstimate, money);
    reveal('#demand-estimate', lot.demandEstimate, (value) => `× ${Number(value).toFixed(2)}`);
    $('#appraisal-price').textContent = `${money(lot.informationPrices.appraisal)} 지불`;
    $('#demand-price').textContent = `${money(lot.informationPrices.demand)} 지불`;
    $('#buy-appraisal').disabled = lot.revealed.includes('appraisal');
    $('#buy-demand').disabled = lot.revealed.includes('demand');
    const valueEstimate = lot.appraisalEstimate ?? lot.blindEstimate;
    const demandEstimate = lot.demandEstimate ?? 1.05;
    const estimatedNetSale = valueEstimate * demandEstimate * (1 - session.rules.saleFeeRate);
    const breakEvenBid = Math.max(0, Math.floor(estimatedNetSale / 100) * 100);
    $('#decision-helper').innerHTML = `<b>현재 관측으로 계산한 손익분기 입찰가: ${money(breakEvenBid)}</b><br>추정 가치 × 수요 배율 × 수수료 차감으로 계산한 참고값입니다. 오차가 있으므로 그대로 정답은 아닙니다.`;
    $('#bid-amount').value = Math.max(lot.startBid, breakEvenBid);
  } else {
    $('#day').textContent = '종료';
    $('#lot-title').textContent = '세션 완료';
    $('#lot-slot').textContent = percent(session.result?.roiPercent);
    $('#bid-form').querySelectorAll('button,input').forEach((element) => { element.disabled = true; });
    $('#buy-appraisal').disabled = true;
    $('#buy-demand').disabled = true;
  }

  $('#decisions').innerHTML = session.recentDecisions.length
    ? session.recentDecisions.map(decisionRow).join('')
    : '<div class="decision-row"><span>-</span><span>대기</span><span>첫 판단이 여기에 기록됩니다.</span><span></span></div>';
  renderLastOutcome();
  $('#error').textContent = '';
}

function renderLastOutcome() {
  const decision = session.recentDecisions.find((item) => item.type === 'BID' || item.type === 'PASS');
  const target = $('#last-outcome');
  if (!decision) {
    target.className = 'outcome hidden';
    return;
  }
  if (decision.type === 'PASS') {
    target.className = 'outcome';
    target.innerHTML = `<b>직전 결과: 패스</b><br>자산 변화 없이 다음 물건으로 넘어갔습니다.`;
    return;
  }
  if (!decision.won) {
    target.className = 'outcome loss';
    target.innerHTML = `<b>직전 결과: 유찰</b><br>최대 ${money(decision.bid)}를 냈지만 경쟁선 ${money(decision.clearingPrice)}보다 낮았습니다. 제출액은 지불되지 않습니다.`;
    return;
  }
  target.className = `outcome ${decision.profit >= 0 ? 'win' : 'loss'}`;
  target.innerHTML = `<b>직전 결과: ${money(decision.price)}에 낙찰 · 손익 ${money(decision.profit)}</b><br>최대 입찰가 전액이 아니라 숨겨진 경쟁선 가격을 지불했고, 수수료를 뺀 ${money(decision.netSale)}에 즉시 재판매했습니다.`;
}

function decisionRow(decision) {
  if (decision.type.startsWith('BUY_')) {
    return `<div class="decision-row"><span>LOT ${decision.lot}</span><b>정보</b><span>${decision.type === 'BUY_APPRAISAL' ? '감정' : '수요'} 정보 구매</span><span>-${money(decision.cost)}</span></div>`;
  }
  const outcome = decision.type === 'PASS' ? 'PASS' : decision.won ? '낙찰' : '유찰';
  const detail = decision.type === 'PASS' ? '입찰하지 않음' : `제출 ${money(decision.bid)} · 낙찰선 ${money(decision.clearingPrice)}`;
  return `<div class="decision-row"><span>LOT ${decision.lot}</span><b class="${decision.won ? 'win' : 'loss'}">${outcome}</b><span>${detail}</span><span>${decision.won ? money(decision.profit) : ''}</span></div>`;
}

function reveal(selector, value, formatter) {
  const element = $(selector);
  element.textContent = value == null ? '정보 필요' : formatter(value);
  element.classList.toggle('locked', value == null);
}

function setBusy(busy) {
  document.querySelectorAll('#game button, #game input').forEach((element) => { element.disabled = busy; });
}

function showError(error) {
  if (error.status === 401) {
    window.location.href = '/';
    return;
  }
  $('#error').textContent = error.message;
}

async function api(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json', 'X-Team-Loop-Client': 'web' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
