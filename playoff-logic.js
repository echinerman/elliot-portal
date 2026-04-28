export const PLAYOFF_PAYMENT_STATUSES = ['unpaid', 'partial', 'paid', 'waived'];
export const PLAYOFF_PICK_VISIBILITY = {
    AFTER_LOCK: 'after-lock',
    ALWAYS: 'always',
    ADMIN_ONLY: 'admin-only'
};
export const PLAYOFF_PAYOUT_TEMPLATE = [
    { place_key: '1st', label: '1st', share: 0.6364 },
    { place_key: '2nd', label: '2nd', share: 0.2273 },
    { place_key: '3rd', label: '3rd', share: 0.0909 },
    { place_key: 'pity', label: 'Pity', share: 0.0454 }
];
const NHL_TEAM_LOGO_BASE_URL = 'https://assets.nhle.com/logos/nhl/svg';
const NHL_TEAM_PRIMARY_COLORS = {
    ANA: '#F47A38',
    BOS: '#FFB81C',
    BUF: '#003087',
    CAR: '#CE1126',
    COL: '#6F263D',
    DAL: '#006847',
    EDM: '#041E42',
    LAK: '#111111',
    MIN: '#154734',
    MTL: '#AF1E2D',
    OTT: '#000000',
    PHI: '#F74902',
    PIT: '#000000',
    TBL: '#002868',
    UTA: '#6CACE3',
    VGK: '#B4975A'
};
const NHL_TEAM_LOGO_OVERRIDES = {
    TBL: {
        light: 'https://cdn.brandfetch.io/idzkS0hq1D/theme/light/logo.svg?c=1dxbfHSJFAPEGdCLU4o5B'
    }
};

// Official 2026 Round 1 pairings captured from NHL.com bracket/lookahead pages on April 16, 2026.
const OFFICIAL_PLAYOFF_BRACKETS = {
    2026: {
        round1: [
            {
                id: 'r1-east-atlantic',
                official_key: '2026-round-1-east-atlantic',
                conference: 'Eastern Conference',
                bracket_group: 'Atlantic',
                sort_order: 1,
                matchup_label: 'Atlantic 1 vs Wild Card 1',
                home_team_id: 'BUF',
                home_team_name: 'Buffalo Sabres',
                home_team_seed_label: 'A1',
                away_team_id: 'BOS',
                away_team_name: 'Boston Bruins',
                away_team_seed_label: 'WC1'
            },
            {
                id: 'r1-east-atlantic-2-3',
                official_key: '2026-round-1-east-atlantic-2-3',
                conference: 'Eastern Conference',
                bracket_group: 'Atlantic',
                sort_order: 2,
                matchup_label: 'Atlantic 2 vs Atlantic 3',
                home_team_id: 'TBL',
                home_team_name: 'Tampa Bay Lightning',
                home_team_seed_label: 'A2',
                away_team_id: 'MTL',
                away_team_name: 'Montreal Canadiens',
                away_team_seed_label: 'A3'
            },
            {
                id: 'r1-east-metro',
                official_key: '2026-round-1-east-metro',
                conference: 'Eastern Conference',
                bracket_group: 'Metropolitan',
                sort_order: 3,
                matchup_label: 'Metro 1 vs Wild Card 2',
                home_team_id: 'CAR',
                home_team_name: 'Carolina Hurricanes',
                home_team_seed_label: 'M1',
                away_team_id: 'OTT',
                away_team_name: 'Ottawa Senators',
                away_team_seed_label: 'WC2'
            },
            {
                id: 'r1-east-metro-2-3',
                official_key: '2026-round-1-east-metro-2-3',
                conference: 'Eastern Conference',
                bracket_group: 'Metropolitan',
                sort_order: 4,
                matchup_label: 'Metro 2 vs Metro 3',
                home_team_id: 'PIT',
                home_team_name: 'Pittsburgh Penguins',
                home_team_seed_label: 'M2',
                away_team_id: 'PHI',
                away_team_name: 'Philadelphia Flyers',
                away_team_seed_label: 'M3'
            },
            {
                id: 'r1-west-central',
                official_key: '2026-round-1-west-central',
                conference: 'Western Conference',
                bracket_group: 'Central',
                sort_order: 5,
                matchup_label: 'Central 1 vs Wild Card 2',
                home_team_id: 'COL',
                home_team_name: 'Colorado Avalanche',
                home_team_seed_label: 'C1',
                away_team_id: 'LAK',
                away_team_name: 'Los Angeles Kings',
                away_team_seed_label: 'WC2'
            },
            {
                id: 'r1-west-central-2-3',
                official_key: '2026-round-1-west-central-2-3',
                conference: 'Western Conference',
                bracket_group: 'Central',
                sort_order: 6,
                matchup_label: 'Central 2 vs Central 3',
                home_team_id: 'DAL',
                home_team_name: 'Dallas Stars',
                home_team_seed_label: 'C2',
                away_team_id: 'MIN',
                away_team_name: 'Minnesota Wild',
                away_team_seed_label: 'C3'
            },
            {
                id: 'r1-west-pacific',
                official_key: '2026-round-1-west-pacific',
                conference: 'Western Conference',
                bracket_group: 'Pacific',
                sort_order: 7,
                matchup_label: 'Pacific 1 vs Wild Card 1',
                home_team_id: 'VGK',
                home_team_name: 'Vegas Golden Knights',
                home_team_seed_label: 'P1',
                away_team_id: 'UTA',
                away_team_name: 'Utah Mammoth',
                away_team_seed_label: 'WC1'
            },
            {
                id: 'r1-west-pacific-2-3',
                official_key: '2026-round-1-west-pacific-2-3',
                conference: 'Western Conference',
                bracket_group: 'Pacific',
                sort_order: 8,
                matchup_label: 'Pacific 2 vs Pacific 3',
                home_team_id: 'EDM',
                home_team_name: 'Edmonton Oilers',
                home_team_seed_label: 'P2',
                away_team_id: 'ANA',
                away_team_name: 'Anaheim Ducks',
                away_team_seed_label: 'P3'
            }
        ]
    }
};

export function normalizeTeamCode(teamId = '') {
    return String(teamId || '').trim().toUpperCase();
}

export function getTeamLogoUrl(teamId = '', variant = 'dark') {
    const code = normalizeTeamCode(teamId);
    if (!code) {
        return '';
    }

    const safeVariant = variant === 'light' ? 'light' : 'dark';
    const override = NHL_TEAM_LOGO_OVERRIDES[code]?.[safeVariant];
    if (override) {
        return override;
    }
    return `${NHL_TEAM_LOGO_BASE_URL}/${code}_${safeVariant}.svg`;
}

export function getTeamPrimaryColor(teamId = '') {
    return NHL_TEAM_PRIMARY_COLORS[normalizeTeamCode(teamId)] || '#0F172A';
}

export function normalizePlayoffSeries(series = {}) {
    const homeTeamId = normalizeTeamCode(series.home_team_id);
    const awayTeamId = normalizeTeamCode(series.away_team_id);
    return {
        ...series,
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        home_team_logo_dark: series.home_team_logo_dark || getTeamLogoUrl(homeTeamId, 'dark'),
        home_team_logo_light: series.home_team_logo_light || getTeamLogoUrl(homeTeamId, 'light'),
        away_team_logo_dark: series.away_team_logo_dark || getTeamLogoUrl(awayTeamId, 'dark'),
        away_team_logo_light: series.away_team_logo_light || getTeamLogoUrl(awayTeamId, 'light'),
        home_team_primary_color: series.home_team_primary_color || getTeamPrimaryColor(homeTeamId),
        away_team_primary_color: series.away_team_primary_color || getTeamPrimaryColor(awayTeamId),
        live_home_wins: Number(series.live_home_wins || 0),
        live_away_wins: Number(series.live_away_wins || 0)
    };
}

// Returns true if a pick (winner, games) could still be correct given live series state.
export function isPickStillPossible({ pickedWinnerTeamId, pickedGames, series } = {}) {
    if (!series || !pickedWinnerTeamId) return { winnerPossible: false, gamesPossible: false };
    if (series.result_winner_team_id) {
        const winnerPossible = pickedWinnerTeamId === series.result_winner_team_id;
        const gamesPossible = winnerPossible && pickedGames && Number(pickedGames) === Number(series.result_games);
        return { winnerPossible, gamesPossible };
    }
    const homeWins = Number(series.live_home_wins || 0);
    const awayWins = Number(series.live_away_wins || 0);
    const isHomePick = pickedWinnerTeamId === series.home_team_id;
    const isAwayPick = pickedWinnerTeamId === series.away_team_id;
    if (!isHomePick && !isAwayPick) return { winnerPossible: false, gamesPossible: false };
    const winnerPossible = (isHomePick && awayWins < 4) || (isAwayPick && homeWins < 4);
    if (!winnerPossible) return { winnerPossible: false, gamesPossible: false };
    if (!pickedGames) return { winnerPossible, gamesPossible: false };
    const winnerCurrent = isHomePick ? homeWins : awayWins;
    const loserCurrent = isHomePick ? awayWins : homeWins;
    const games = Number(pickedGames);
    const gamesPossible = winnerCurrent <= 4 && loserCurrent <= (games - 4) && games >= 4 && games <= 7;
    return { winnerPossible, gamesPossible };
}

// Sum of points still on the table for a member's picks across unresolved series in the round.
export function computeMemberPotentialPoints(pickEntries = [], seriesById = {}, round = {}) {
    const winnerPts = Number(round.winner_points || 0);
    const gamesPts = Number(round.games_points || 0);
    let total = 0;
    pickEntries.forEach(entry => {
        const series = seriesById[entry.series_id];
        if (!series) return;
        if (series.result_winner_team_id) return;
        const { winnerPossible, gamesPossible } = isPickStillPossible({
            pickedWinnerTeamId: entry.winner_team_id,
            pickedGames: entry.games,
            series
        });
        if (winnerPossible) total += winnerPts;
        if (gamesPossible) total += gamesPts;
    });
    return total;
}

export function buildOfficialRoundOneSeries(seasonYear) {
    const bracket = OFFICIAL_PLAYOFF_BRACKETS[Number(seasonYear)];
    if (!bracket?.round1?.length) {
        return [];
    }

    return bracket.round1.map(series => normalizePlayoffSeries({
        ...series,
        status: 'open',
        notes: 'Official NHL Round 1 matchup synced from the current bracket.'
    }));
}

export function getRoundScoring(roundNumber = 1) {
    const safeRound = Math.max(1, Number(roundNumber) || 1);
    const roundMultiplier = 2 ** (safeRound - 1);
    return {
        round_number: safeRound,
        round_multiplier: roundMultiplier,
        winner_points: 2 * roundMultiplier,
        games_points: 1 * roundMultiplier
    };
}

export function defaultPlayoffPool() {
    return {
        season_label: '',
        entry_fee_default: 20,
        default_payout_mode: 'top-3-plus-pity',
        pick_visibility: PLAYOFF_PICK_VISIBILITY.AFTER_LOCK,
        lock_policy: 'deadline',
        payout_template: defaultPayoutTemplate(),
        suggested_payouts: [],
        finalized_payouts: [],
        status: 'draft',
        description: ''
    };
}

export function defaultPayoutTemplate() {
    return PLAYOFF_PAYOUT_TEMPLATE.map(item => ({ ...item }));
}

export function normalizePayoutTemplate(template = []) {
    if (!Array.isArray(template) || template.length === 0) {
        return defaultPayoutTemplate();
    }

    return template.map((item, index) => ({
        place_key: item.place_key || PLAYOFF_PAYOUT_TEMPLATE[index]?.place_key || `place-${index + 1}`,
        label: item.label || item.place_key || PLAYOFF_PAYOUT_TEMPLATE[index]?.label || `Place ${index + 1}`,
        share: Number(item.share || 0)
    }));
}

export function normalizePlayoffPool(pool = {}) {
    return {
        ...defaultPlayoffPool(),
        ...pool,
        entry_fee_default: Number(pool.entry_fee_default ?? 20) || 20,
        payout_template: normalizePayoutTemplate(pool.payout_template),
        suggested_payouts: normalizePayoutRecords(pool.suggested_payouts),
        finalized_payouts: normalizePayoutRecords(pool.finalized_payouts)
    };
}

export function defaultPlayoffMember(sharedUser = {}, pool = {}) {
    const entryFee = Number(pool.entry_fee_default ?? 20) || 20;
    return {
        uid: sharedUser.id || sharedUser.uid || '',
        display_name: sharedUser.full_name || '',
        email: sharedUser.email || '',
        team_name: '',
        payment_status: 'unpaid',
        eligible_for_payout: false,
        late_payment_flag: false,
        amount_due: entryFee,
        amount_paid: 0,
        amount_remaining: entryFee,
        paid_at: '',
        payment_method: '',
        payment_notes: '',
        team_name_history: [],
        points_total: 0,
        round_points: 0,
        round_history: [],
        payout_amount: 0,
        payout_place: '',
        updated_at: ''
    };
}

export function normalizePlayoffMember(member = {}, pool = {}) {
    const base = defaultPlayoffMember({}, pool);
    const amountDue = Number(member.amount_due ?? base.amount_due) || 0;
    const amountPaid = Number(member.amount_paid ?? 0) || 0;
    const paymentStatus = derivePaymentStatus({
        amount_due: amountDue,
        amount_paid: amountPaid,
        payment_status: member.payment_status
    });

    return {
        ...base,
        ...member,
        payment_status: paymentStatus,
        amount_due: amountDue,
        amount_paid: amountPaid,
        amount_remaining: Math.max(0, roundCurrency(amountDue - amountPaid)),
        eligible_for_payout: Boolean(member.eligible_for_payout ?? (paymentStatus === 'paid' || paymentStatus === 'waived')),
        late_payment_flag: Boolean(member.late_payment_flag),
        team_name_history: Array.isArray(member.team_name_history) ? member.team_name_history.map(item => ({
            team_name: item.team_name || '',
            changed_at: item.changed_at || '',
            source: item.source || 'portal'
        })).filter(item => item.team_name) : [],
        points_total: Number(member.points_total || 0),
        round_points: Number(member.round_points || 0),
        payout_amount: Number(member.payout_amount || 0),
        round_history: Array.isArray(member.round_history) ? member.round_history.map(item => ({
            round_id: item.round_id || '',
            round_name: item.round_name || '',
            round_number: Number(item.round_number || 0),
            points: Number(item.points || 0)
        })) : []
    };
}

export function defaultPaymentRecord(memberUid = '', pool = {}) {
    const amountDue = Number(pool.entry_fee_default ?? 20) || 20;
    return {
        member_uid: memberUid,
        amount_due: amountDue,
        amount_paid: 0,
        status: 'unpaid',
        paid_at: '',
        method: '',
        notes: '',
        late_payment_flag: false,
        eligible_for_payout: false
    };
}

export function normalizePaymentRecord(payment = {}, member = {}, pool = {}) {
    const base = defaultPaymentRecord(member.uid || payment.member_uid || '', pool);
    const amountDue = Number(payment.amount_due ?? member.amount_due ?? base.amount_due) || 0;
    const amountPaid = Number(payment.amount_paid ?? member.amount_paid ?? 0) || 0;
    const status = derivePaymentStatus({
        amount_due: amountDue,
        amount_paid: amountPaid,
        payment_status: payment.status || member.payment_status
    });

    return {
        ...base,
        ...payment,
        member_uid: payment.member_uid || member.uid || '',
        amount_due: amountDue,
        amount_paid: amountPaid,
        status,
        late_payment_flag: Boolean(payment.late_payment_flag ?? member.late_payment_flag),
        eligible_for_payout: Boolean(payment.eligible_for_payout ?? member.eligible_for_payout ?? (status === 'paid' || status === 'waived'))
    };
}

export function defaultPlayoffRound(roundNumber = 1) {
    const scoring = getRoundScoring(roundNumber);
    return {
        name: `Round ${scoring.round_number}`,
        round_number: scoring.round_number,
        sort_order: scoring.round_number,
        status: 'draft',
        pick_deadline: '',
        lock_at: '',
        ...scoring
    };
}

export function normalizePlayoffRound(round = {}) {
    const scoring = getRoundScoring(round.round_number || round.sort_order || 1);
    return {
        ...defaultPlayoffRound(scoring.round_number),
        ...round,
        round_number: Number(round.round_number || scoring.round_number),
        sort_order: Number(round.sort_order || round.round_number || scoring.round_number),
        winner_points: Number(round.winner_points ?? scoring.winner_points),
        games_points: Number(round.games_points ?? scoring.games_points),
        round_multiplier: Number(round.round_multiplier ?? scoring.round_multiplier),
        lock_at: round.lock_at || round.pick_deadline || '',
        pick_deadline: round.pick_deadline || round.lock_at || ''
    };
}

export function defaultPickEntry(seriesId = '') {
    return {
        series_id: seriesId,
        winner_team_id: '',
        games: 0,
        submitted_at: '',
        updated_at: '',
        winner_points_awarded: 0,
        games_points_awarded: 0,
        series_points_total: 0,
        winner_eligibility: true,
        games_eligibility: true,
        eligibility_reason: ''
    };
}

export function normalizePickEntry(entry = {}) {
    return {
        ...defaultPickEntry(entry.series_id || ''),
        ...entry,
        games: Number(entry.games || 0),
        winner_points_awarded: Number(entry.winner_points_awarded || 0),
        games_points_awarded: Number(entry.games_points_awarded || 0),
        series_points_total: Number(entry.series_points_total || 0),
        winner_eligibility: entry.winner_eligibility !== false,
        games_eligibility: entry.games_eligibility !== false
    };
}

export function normalizePickDoc(pick = {}) {
    return {
        ...pick,
        entries: Array.isArray(pick.entries) ? pick.entries.map(normalizePickEntry) : [],
        round_total: Number(pick.round_total || 0)
    };
}

export function buildDraftFromEntries(entries = []) {
    const draft = {};
    entries.forEach(entry => {
        draft[entry.series_id] = {
            winner_team_id: entry.winner_team_id || '',
            games: entry.games || ''
        };
    });
    return draft;
}

export function pickCurrentRound(rounds = []) {
    return rounds.find(round => ['open', 'active', 'live'].includes(String(round.status || '').toLowerCase()))
        || rounds.find(round => ['locked'].includes(String(round.status || '').toLowerCase()))
        || rounds[0]
        || null;
}

export function isRoundLocked(round = {}) {
    if (!round) return true;
    const status = String(round.status || '').toLowerCase();
    if (['locked', 'complete', 'completed'].includes(status)) return true;
    const lockAt = round.lock_at || round.pick_deadline;
    if (!lockAt) return false;
    return new Date(lockAt).getTime() < Date.now();
}

export function isRoundRevealed(round = {}, pool = {}) {
    if (!round) return false;
    if (pool.pick_visibility === PLAYOFF_PICK_VISIBILITY.ALWAYS) return true;
    if (pool.pick_visibility === PLAYOFF_PICK_VISIBILITY.ADMIN_ONLY) return false;
    return isRoundLocked(round);
}

export function derivePaymentStatus({ amount_due = 0, amount_paid = 0, payment_status = '' } = {}) {
    const requested = String(payment_status || '').toLowerCase();
    if (requested === 'waived') return 'waived';
    if (requested === 'paid' && amount_paid >= amount_due) return 'paid';
    if (amount_paid >= amount_due && amount_due > 0) return 'paid';
    if (amount_paid > 0) return 'partial';
    return 'unpaid';
}

export function scorePickEntry(entry, series = {}, round = {}) {
    const normalizedEntry = normalizePickEntry(entry);
    const normalizedRound = normalizePlayoffRound(round);
    const correctWinner = Boolean(
        normalizedEntry.winner_team_id
        && series.result_winner_team_id
        && normalizedEntry.winner_team_id === series.result_winner_team_id
    );
    const exactGames = Boolean(
        normalizedEntry.games
        && series.result_games
        && Number(normalizedEntry.games) === Number(series.result_games)
    );

    const winnerPointsAwarded = correctWinner && normalizedEntry.winner_eligibility !== false
        ? Number(normalizedRound.winner_points || 0)
        : 0;
    const gamesPointsAwarded = exactGames && normalizedEntry.games_eligibility !== false
        ? Number(normalizedRound.games_points || 0)
        : 0;

    return {
        ...normalizedEntry,
        winner_points_awarded: winnerPointsAwarded,
        games_points_awarded: gamesPointsAwarded,
        series_points_total: winnerPointsAwarded + gamesPointsAwarded
    };
}

export function scorePickDocument(pickDoc = {}, seriesList = [], round = {}) {
    const normalizedPick = normalizePickDoc(pickDoc);
    const bySeriesId = Object.fromEntries(seriesList.map(series => [series.id, series]));
    const entries = normalizedPick.entries.map(entry => scorePickEntry(entry, bySeriesId[entry.series_id] || {}, round));
    const roundTotal = entries.reduce((sum, entry) => sum + Number(entry.series_points_total || 0), 0);

    return {
        ...normalizedPick,
        entries,
        round_total: roundTotal
    };
}

export function buildPickDistribution(seriesList = [], pickDocs = []) {
    return seriesList.map(series => {
        const winnerCounts = {};
        const gamesCounts = { 4: 0, 5: 0, 6: 0, 7: 0 };

        pickDocs.forEach(pickDoc => {
            const entry = (pickDoc.entries || []).find(item => item.series_id === series.id);
            if (!entry) return;
            if (entry.winner_team_id) {
                const winnerLabel = entry.winner_team_id === series.home_team_id
                    ? (series.home_team_name || series.home_team_id)
                    : entry.winner_team_id === series.away_team_id
                        ? (series.away_team_name || series.away_team_id)
                        : entry.winner_team_id;
                winnerCounts[winnerLabel] = (winnerCounts[winnerLabel] || 0) + 1;
            }
            if (entry.games) {
                gamesCounts[entry.games] = (gamesCounts[entry.games] || 0) + 1;
            }
        });

        return {
            series_id: series.id,
            matchup_label: series.matchup_label || `${series.home_team_name || series.home_team_id} vs ${series.away_team_name || series.away_team_id}`,
            winner_counts: winnerCounts,
            games_counts: gamesCounts
        };
    });
}

export function buildStandingsTrend(rounds = [], members = []) {
    const orderedRounds = [...rounds].sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0));
    return members.map(member => ({
        member_id: member.id || member.uid,
        display_name: member.team_name || member.display_name || member.email || member.id || 'Member',
        points: orderedRounds.map(round => {
            const historyEntry = (member.round_history || []).find(item => item.round_id === round.id);
            return Number(historyEntry?.points || 0);
        })
    }));
}

export function suggestPayouts({ collectedPot = 0, participantCount = 0, template = [] } = {}) {
    const payoutTemplate = normalizePayoutTemplate(template);
    const safePot = roundCurrency(Number(collectedPot || 0));
    const payouts = payoutTemplate.map(item => ({
        place_key: item.place_key,
        label: item.label,
        share: item.share,
        suggested_amount: roundCurrency(safePot * item.share),
        final_amount: 0,
        manual_override: false,
        notes: participantCount ? `${participantCount} entrants` : ''
    }));

    if (!payouts.length) {
        return [];
    }

    const assigned = roundCurrency(payouts.reduce((sum, item) => sum + item.suggested_amount, 0));
    const remainder = roundCurrency(safePot - assigned);
    payouts[0].suggested_amount = roundCurrency(payouts[0].suggested_amount + remainder);
    return payouts;
}

export function normalizePayoutRecords(records = []) {
    if (!Array.isArray(records)) return [];
    return records.map(item => ({
        place_key: item.place_key || '',
        label: item.label || item.place_key || '',
        share: Number(item.share || 0),
        suggested_amount: Number(item.suggested_amount || 0),
        final_amount: Number(item.final_amount || 0),
        manual_override: Boolean(item.manual_override),
        notes: item.notes || ''
    }));
}

export function mergeFinalizedPayouts(suggested = [], finalized = []) {
    const finalizedMap = Object.fromEntries(normalizePayoutRecords(finalized).map(item => [item.place_key, item]));
    return normalizePayoutRecords(suggested).map(item => {
        const existing = finalizedMap[item.place_key];
        if (!existing) return item;
        return {
            ...item,
            final_amount: Number(existing.final_amount || 0),
            manual_override: Boolean(existing.manual_override),
            notes: existing.notes || item.notes || ''
        };
    });
}

export function computeCollectedPot(payments = [], members = []) {
    if (payments.length) {
        return roundCurrency(payments.reduce((sum, item) => sum + Number(item.amount_paid || 0), 0));
    }
    return roundCurrency(members.reduce((sum, member) => sum + Number(member.amount_paid || 0), 0));
}

export function buildCompactPickLabel(entry = {}, series = {}) {
    if (!entry?.winner_team_id) return '';
    const winnerLabel = entry.winner_team_id === series.home_team_id
        ? (series.home_team_name || entry.winner_team_id)
        : entry.winner_team_id === series.away_team_id
            ? (series.away_team_name || entry.winner_team_id)
            : entry.winner_team_id;
    return `${winnerLabel} (${entry.games || '?'})`;
}

export function buildRoundHistoryEntry(round = {}, points = 0) {
    return {
        round_id: round.id || '',
        round_name: round.name || '',
        round_number: Number(round.round_number || round.sort_order || 0),
        points: Number(points || 0)
    };
}

export function computeMemberTotalsFromScoredPicks(rounds = [], scoredPicksByRound = {}) {
    const orderedRounds = [...rounds].sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0));
    const roundHistory = orderedRounds.map(round => buildRoundHistoryEntry(round, scoredPicksByRound[round.id]?.round_total || 0));
    const pointsTotal = roundHistory.reduce((sum, item) => sum + Number(item.points || 0), 0);
    const lastRound = roundHistory[roundHistory.length - 1];

    return {
        points_total: pointsTotal,
        round_points: Number(lastRound?.points || 0),
        round_history: roundHistory
    };
}

export function sortStandings(members = []) {
    return [...members].sort((left, right) => {
        const pointDiff = Number(right.points_total || 0) - Number(left.points_total || 0);
        if (pointDiff !== 0) return pointDiff;
        return String(left.team_name || left.display_name || left.email || '').localeCompare(
            String(right.team_name || right.display_name || right.email || '')
        );
    });
}

export function roundCurrency(value = 0) {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
