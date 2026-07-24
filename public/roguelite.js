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
    $('#buy-appraisal').disabled = lot.revealed.includes('appraisal');
    $('#buy-demand').disabled = lot.revealed.includes('demand');
    $('#bid-amount').value = Math.max(lot.startBid, Math.round(lot.blindEstimate / 100) * 100);
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
  $('#error').textContent = '';
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
