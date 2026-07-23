export function simulateCombat(gameData, { seed = 42, runs = 500 } = {}) {
  const baseline = structuredClone(gameData);
  const random = seededRandom(seed);
  const player = baseline.player ?? {};
  const rooms = Array.isArray(baseline.rooms) ? baseline.rooms : [];
  const attempts = Array(rooms.length).fill(0);
  const deaths = Array(rooms.length).fill(0);
  const hpSums = Array(rooms.length).fill(0);
  const rewards = [];
  let completions = 0;
  let progressedRoomTotal = 0;

  for (let run = 0; run < Math.max(0, runs); run += 1) {
    let hp = integer(player.maxHp, 100);
    let rewardTotal = 0;
    let progressedRooms = 0;
    let survived = true;
    for (let roomIndex = 0; roomIndex < rooms.length; roomIndex += 1) {
      attempts[roomIndex] += 1;
      const outcome = simulateRoom({ hp, maxHp: integer(player.maxHp, 100), attack: integer(player.attack, 10) }, rooms[roomIndex], random);
      hpSums[roomIndex] += outcome.remainingHp;
      rewardTotal += outcome.rewardGained;
      if (!outcome.survived) {
        deaths[roomIndex] += 1;
        survived = false;
        break;
      }
      hp = outcome.remainingHp;
      progressedRooms += 1;
    }
    if (survived) completions += 1;
    progressedRoomTotal += progressedRooms;
    rewards.push(rewardTotal);
  }

  const divisor = runs > 0 ? runs : 1;
  const rewardMean = rewards.reduce((sum, value) => sum + value, 0) / Math.max(1, rewards.length);
  const rewardVariance = rewards.reduce((sum, value) => sum + ((value - rewardMean) ** 2), 0) / Math.max(1, rewards.length);
  return {
    completionRate: completions / divisor * 100,
    roomReachRates: attempts.map((value) => value / divisor * 100),
    roomDeathRates: deaths.map((value, index) => attempts[index] ? value / attempts[index] * 100 : 0),
    averageHpPerRoom: hpSums.map((value, index) => attempts[index] ? value / attempts[index] : 0),
    rewardPerRunMean: rewardMean,
    rewardPerRunStdDev: Math.sqrt(rewardVariance),
    averageProgressedRooms: progressedRoomTotal / divisor,
  };
}

export function combatMetric(metricId, result) {
  if (metricId === 'completionRate') return result.completionRate;
  if (metricId === 'avgRewardPerRun') return result.rewardPerRunMean;
  const match = /^room(\d+)(ReachRate|DeathRate)$/.exec(metricId);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return match[2] === 'ReachRate' ? result.roomReachRates[index] ?? 0 : result.roomDeathRates[index] ?? 0;
}

function simulateRoom(player, room, random) {
  let hp = player.hp;
  const enemies = room?.enemies ?? {};
  for (let enemyIndex = 0; enemyIndex < integer(enemies.count, 0); enemyIndex += 1) {
    let enemyHp = integer(enemies.hp, 0);
    while (enemyHp > 0) {
      enemyHp -= Math.round(player.attack * randomInteger(random, 80, 120) / 100);
      if (enemyHp <= 0) break;
      hp -= Math.round(integer(enemies.attack, 0) * randomInteger(random, 80, 120) / 100);
      if (hp <= 0) return { survived: false, remainingHp: 0, rewardGained: 0 };
    }
  }
  const reward = room?.rewards ?? {};
  let rewardGained = 0;
  if (random() < number(reward.commonDropRate, 0)) {
    rewardGained = integer(reward.healAmount, 0);
    hp = Math.min(player.maxHp, hp + rewardGained);
  }
  return { survived: true, remainingHp: hp, rewardGained };
}

function seededRandom(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function randomInteger(random, minimum, maximum) {
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function integer(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? Math.round(candidate) : fallback;
}

function number(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : fallback;
}
