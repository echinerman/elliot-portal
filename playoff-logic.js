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
                winnerCounts[entry.winner_team_id] = (winnerCounts[entry.winner_team_id] || 0) + 1;
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
