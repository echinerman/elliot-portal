import { CONFIG } from './config.js';
import {
    APP_DEFINITIONS,
    APP_IDS,
    defaultMembership,
    defaultSharedUser,
    escapeHtml,
    formatDate,
    normalizeMembership,
    normalizeStrong8kProfile,
    parseDelimitedList,
    slugify
} from './app-model.js';
import {
    buildCompactPickLabel,
    buildPickDistribution,
    computeCollectedPot,
    computeMemberTotalsFromScoredPicks,
    defaultPaymentRecord,
    defaultPlayoffMember,
    defaultPlayoffRound,
    defaultPayoutTemplate,
    derivePaymentStatus,
    mergeFinalizedPayouts,
    normalizePaymentRecord,
    normalizePlayoffMember,
    normalizePlayoffPool,
    normalizePlayoffRound,
    normalizePickDoc,
    normalizePayoutTemplate,
    scorePickDocument,
    sortStandings,
    suggestPayouts
} from './playoff-logic.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
    addDoc,
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    getFirestore,
    orderBy,
    query,
    setDoc,
    updateDoc
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const firebaseApp = initializeApp(CONFIG.FIREBASE);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

const state = {
    currentUser: null,
    users: [],
    membershipsByUser: {},
    strong8kProfiles: {},
    strong8kProducts: [],
    strong8kConfig: { live_list: [], vod_list: [] },
    pools: [],
    selectedPoolId: '',
    selectedRoundId: '',
    selectedMemberId: '',
    rounds: [],
    series: [],
    poolMembers: [],
    payments: [],
    roundPickDocs: [],
    currentLicenses: [],
    editingProductId: '',
    editingPoolId: '',
    editingRoundId: '',
    editingSeriesId: ''
};

document.addEventListener('DOMContentLoaded', () => {
    bindNavigation();
    bindUserModal();
    bindStrong8kForms();
    bindPlayoffForms();
    byId('admin-signout-btn').addEventListener('click', () => signOut(auth));
    onAuthStateChanged(auth, handleAdminAuth);
});

function byId(id) {
    return document.getElementById(id);
}

function showToast(message, tone = 'default') {
    const toast = byId('toast');
    const icon = byId('toast-icon');
    byId('toast-msg').textContent = message;
    icon.className = tone === 'error'
        ? 'fa-solid fa-circle-exclamation'
        : 'fa-solid fa-circle-check';
    toast.classList.remove('translate-x-full', 'opacity-0');
    setTimeout(() => toast.classList.add('translate-x-full', 'opacity-0'), 3000);
}

async function handleAdminAuth(user) {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    const roleSnap = await getDoc(doc(db, 'roles', user.uid));
    if (!roleSnap.exists() || roleSnap.data().platform_admin !== true) {
        window.location.href = 'index.html';
        return;
    }

    state.currentUser = user;
    byId('admin-email').textContent = user.email;
    await loadAdminData();
}

async function loadAdminData() {
    const userSnap = await getDocs(collection(db, 'users'));
    const users = [];
    userSnap.forEach(item => {
        const data = item.data();
        if (!data.deleted) {
            users.push({ id: item.id, ...defaultSharedUser(data.email || ''), ...data });
        }
    });
    state.users = users.sort((left, right) => (left.full_name || left.email).localeCompare(right.full_name || right.email));

    const membershipEntries = await Promise.all(state.users.map(async user => {
        const membershipsSnap = await getDocs(collection(db, 'users', user.id, 'memberships'));
        const memberships = {};
        membershipsSnap.forEach(item => {
            memberships[item.id] = normalizeMembership(item.id, item.data());
        });
        return [user.id, memberships];
    }));
    state.membershipsByUser = Object.fromEntries(membershipEntries);

    const strong8kSnap = await getDocs(collection(db, 'strong8k_profiles'));
    const profiles = {};
    strong8kSnap.forEach(item => {
        profiles[item.id] = normalizeStrong8kProfile(item.data(), state.users.find(user => user.id === item.id) || {});
    });
    state.strong8kProfiles = profiles;

    const configSnap = await getDoc(doc(db, 'strong8k_config', 'content_options'));
    if (configSnap.exists()) {
        state.strong8kConfig = configSnap.data();
    } else {
        const legacyConfigSnap = await getDoc(doc(db, 'app_config', 'content_options'));
        state.strong8kConfig = legacyConfigSnap.exists() ? legacyConfigSnap.data() : { live_list: [], vod_list: [] };
    }

    const products = [];
    const productSnap = await getDocs(collection(db, 'strong8k_products'));
    if (!productSnap.empty) {
        productSnap.forEach(item => products.push({ id: item.id, ...item.data() }));
    } else {
        const legacyProductSnap = await getDocs(collection(db, 'products'));
        legacyProductSnap.forEach(item => products.push({ id: item.id, ...item.data() }));
    }
    state.strong8kProducts = products.sort((left, right) => Number(left.price || 0) - Number(right.price || 0));

    const poolSnap = await getDocs(collection(db, 'playoff_pools'));
    state.pools = poolSnap.docs
        .map(item => normalizePlayoffPool({ id: item.id, ...item.data() }))
        .sort((left, right) => (left.name || left.id).localeCompare(right.name || right.id));

    if (!state.selectedPoolId && state.pools.length) {
        state.selectedPoolId = state.pools[0].id;
    }

    await loadSelectedPoolData();
    renderAdmin();
}

async function loadSelectedPoolData() {
    if (!state.selectedPoolId) {
        state.rounds = [];
        state.series = [];
        state.poolMembers = [];
        state.payments = [];
        state.roundPickDocs = [];
        state.selectedRoundId = '';
        state.selectedMemberId = '';
        return;
    }

    const roundsSnap = await getDocs(query(collection(db, 'playoff_pools', state.selectedPoolId, 'rounds'), orderBy('sort_order')));
    state.rounds = roundsSnap.docs.map(item => normalizePlayoffRound({ id: item.id, ...item.data() }));
    if (!state.selectedRoundId && state.rounds.length) {
        state.selectedRoundId = state.rounds[0].id;
    }

    if (state.selectedRoundId) {
        const seriesSnap = await getDocs(query(collection(db, 'playoff_pools', state.selectedPoolId, 'rounds', state.selectedRoundId, 'series'), orderBy('sort_order')));
        state.series = seriesSnap.docs.map(item => ({ id: item.id, ...item.data() }));
        const picksSnap = await getDocs(collection(db, 'playoff_pools', state.selectedPoolId, 'rounds', state.selectedRoundId, 'picks'));
        state.roundPickDocs = picksSnap.docs.map(item => normalizePickDoc({ id: item.id, ...item.data() }));
    } else {
        state.series = [];
        state.roundPickDocs = [];
    }

    const membersSnap = await getDocs(collection(db, 'playoff_pools', state.selectedPoolId, 'members'));
    const pool = getSelectedPool();
    state.poolMembers = sortStandings(membersSnap.docs
        .map(item => normalizePlayoffMember({ id: item.id, ...item.data() }, pool)));

    const paymentsSnap = await getDocs(collection(db, 'playoff_pools', state.selectedPoolId, 'payments'));
    state.payments = paymentsSnap.docs.map(item => {
        const member = state.poolMembers.find(poolMember => poolMember.id === item.id || poolMember.uid === item.id) || {};
        return normalizePaymentRecord({ id: item.id, ...item.data() }, member, pool);
    });

    if (!state.selectedMemberId && state.poolMembers.length) {
        state.selectedMemberId = state.poolMembers[0].id;
    }
    if (state.selectedMemberId && !state.poolMembers.some(member => member.id === state.selectedMemberId)) {
        state.selectedMemberId = state.poolMembers[0]?.id || '';
    }
}

function renderAdmin() {
    renderStats();
    renderUsers();
    renderStrong8kSection();
    renderPools();
    renderRounds();
    renderSeries();
    renderPoolMembers();
    renderSelectedPoolMember();
    renderPlayoffReportSummary();
}

function bindNavigation() {
    document.querySelectorAll('[data-tab]').forEach(button => {
        button.addEventListener('click', () => {
            const tabId = button.dataset.tab;
            document.querySelectorAll('[data-tab]').forEach(item => {
                item.classList.toggle('bg-slate-950', item === button);
                item.classList.toggle('text-white', item === button);
                item.classList.toggle('border-slate-950', item === button);
            });
            document.querySelectorAll('[data-panel]').forEach(panel => {
                panel.classList.toggle('hidden', panel.dataset.panel !== tabId);
            });
        });
    });
}

function renderStats() {
    const strong8kCount = state.users.filter(user => state.membershipsByUser[user.id]?.[APP_IDS.STRONG8K]?.status === 'active').length;
    const playoffCount = state.users.filter(user => state.membershipsByUser[user.id]?.[APP_IDS.PLAYOFF]?.status === 'active').length;
    byId('stat-users').textContent = String(state.users.length);
    byId('stat-strong8k').textContent = String(strong8kCount);
    byId('stat-playoff').textContent = String(playoffCount);
    byId('stat-pools').textContent = String(state.pools.length);
}

function renderUsers(filter = '') {
    const tbody = byId('users-table-body');
    tbody.innerHTML = '';
    const queryValue = filter.trim().toLowerCase();
    const users = state.users.filter(user => {
        if (!queryValue) return true;
        return [user.full_name, user.email].some(value => String(value || '').toLowerCase().includes(queryValue));
    });

    users.forEach(user => {
        const memberships = state.membershipsByUser[user.id] || {};
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-100 text-sm';
        row.innerHTML = `
            <td class="px-4 py-4">
                <div class="font-semibold text-slate-950">${escapeHtml(user.full_name || 'No Name')}</div>
                <div class="text-xs text-slate-500">${escapeHtml(user.email || '')}</div>
            </td>
            <td class="px-4 py-4">
                <div class="flex flex-wrap gap-2">
                    ${renderMembershipBadge(memberships[APP_IDS.STRONG8K], APP_DEFINITIONS[APP_IDS.STRONG8K].shortLabel)}
                    ${renderMembershipBadge(memberships[APP_IDS.PLAYOFF], APP_DEFINITIONS[APP_IDS.PLAYOFF].shortLabel)}
                </div>
            </td>
            <td class="px-4 py-4 text-slate-500">${escapeHtml(user.default_app_id || 'Auto')}</td>
            <td class="px-4 py-4 text-right">
                <button type="button" class="rounded-full border border-slate-200 px-4 py-2 text-xs font-bold text-slate-700 transition hover:border-slate-900 hover:text-slate-950" data-edit-user="${user.id}">
                    Edit
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });

    tbody.querySelectorAll('[data-edit-user]').forEach(button => {
        button.addEventListener('click', () => openUserModal(button.dataset.editUser));
    });
}

function renderMembershipBadge(membership, label) {
    if (!membership) {
        return `<span class="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">${label}: none</span>`;
    }

    const statusClass = membership.status === 'active'
        ? 'bg-emerald-100 text-emerald-700'
        : membership.status === 'pending'
            ? 'bg-amber-100 text-amber-700'
            : 'bg-rose-100 text-rose-700';
    return `<span class="rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.2em] ${statusClass}">${label}: ${membership.status}</span>`;
}

function renderStrong8kSection() {
    byId('strong8k-live-list').value = (state.strong8kConfig.live_list || []).join('\n');
    byId('strong8k-vod-list').value = (state.strong8kConfig.vod_list || []).join('\n');

    const tbody = byId('product-table-body');
    tbody.innerHTML = '';
    state.strong8kProducts.forEach(product => {
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-100 text-sm';
        row.innerHTML = `
            <td class="px-4 py-4 font-semibold text-slate-950">${escapeHtml(product.name)}</td>
            <td class="px-4 py-4 text-slate-500">${CONFIG.CURRENCY_SYMBOL}${product.price}</td>
            <td class="px-4 py-4 text-slate-500">${product.credits || 0}</td>
            <td class="px-4 py-4 text-right">
                <button type="button" class="rounded-full border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-slate-900 hover:text-slate-950" data-edit-product="${product.id}">Edit</button>
            </td>
        `;
        tbody.appendChild(row);
    });

    tbody.querySelectorAll('[data-edit-product]').forEach(button => {
        button.addEventListener('click', () => loadProductIntoForm(button.dataset.editProduct));
    });
}

function renderPools() {
    const tbody = byId('pool-table-body');
    tbody.innerHTML = '';
    state.pools.forEach(pool => {
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-100 text-sm';
        row.innerHTML = `
            <td class="px-4 py-4 font-semibold text-slate-950">${escapeHtml(pool.name || pool.id)}</td>
            <td class="px-4 py-4 text-slate-500">${escapeHtml(pool.season_label || '')}</td>
            <td class="px-4 py-4 text-slate-500">${escapeHtml(pool.status || 'draft')}</td>
            <td class="px-4 py-4 text-right">
                <button type="button" class="rounded-full border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-slate-900 hover:text-slate-950" data-select-pool="${pool.id}">
                    ${state.selectedPoolId === pool.id ? 'Selected' : 'Select'}
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });

    tbody.querySelectorAll('[data-select-pool]').forEach(button => {
        button.addEventListener('click', async () => {
            state.selectedPoolId = button.dataset.selectPool;
            state.selectedRoundId = '';
            await loadSelectedPoolData();
            renderAdmin();
            loadPoolIntoForm(state.selectedPoolId);
        });
    });

    if (state.selectedPoolId) {
        loadPoolIntoForm(state.selectedPoolId);
    }
}

function renderRounds() {
    const tbody = byId('round-table-body');
    tbody.innerHTML = '';
    state.rounds.forEach(round => {
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-100 text-sm';
        row.innerHTML = `
            <td class="px-4 py-4 font-semibold text-slate-950">${escapeHtml(round.name || round.id)}</td>
            <td class="px-4 py-4 text-slate-500">${round.sort_order || 0}</td>
            <td class="px-4 py-4 text-slate-500">${escapeHtml(round.status || 'draft')}</td>
            <td class="px-4 py-4 text-slate-500">${formatDate(round.pick_deadline)}</td>
            <td class="px-4 py-4 text-right">
                <button type="button" class="rounded-full border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-slate-900 hover:text-slate-950" data-select-round="${round.id}">
                    ${state.selectedRoundId === round.id ? 'Selected' : 'Select'}
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });

    tbody.querySelectorAll('[data-select-round]').forEach(button => {
        button.addEventListener('click', async () => {
            state.selectedRoundId = button.dataset.selectRound;
            await loadSelectedPoolData();
            renderAdmin();
            loadRoundIntoForm(state.selectedRoundId);
        });
    });

    if (state.selectedRoundId) {
        loadRoundIntoForm(state.selectedRoundId);
    }
}

function renderSeries() {
    const tbody = byId('series-table-body');
    tbody.innerHTML = '';
    state.series.forEach(series => {
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-100 text-sm';
        row.innerHTML = `
            <td class="px-4 py-4 text-slate-500">${series.sort_order || 0}</td>
            <td class="px-4 py-4 font-semibold text-slate-950">${escapeHtml(series.matchup_label || `${series.home_team_name || series.home_team_id} vs ${series.away_team_name || series.away_team_id}`)}</td>
            <td class="px-4 py-4 text-slate-500">${escapeHtml(series.status || 'open')}</td>
            <td class="px-4 py-4 text-slate-500">${escapeHtml(series.result_winner_team_id || '-')}</td>
            <td class="px-4 py-4 text-right">
                <button type="button" class="rounded-full border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-slate-900 hover:text-slate-950" data-edit-series="${series.id}">Edit</button>
            </td>
        `;
        tbody.appendChild(row);
    });

    tbody.querySelectorAll('[data-edit-series]').forEach(button => {
        button.addEventListener('click', () => loadSeriesIntoForm(button.dataset.editSeries));
    });
}

function renderPoolMembers() {
    const tbody = byId('pool-members-body');
    tbody.innerHTML = '';
    state.poolMembers.forEach(member => {
        const payment = getPaymentForMember(member.id);
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-100 text-sm';
        row.innerHTML = `
            <td class="px-4 py-4 font-semibold text-slate-950">${escapeHtml(member.display_name || member.email || member.id)}</td>
            <td class="px-4 py-4 text-slate-500">${escapeHtml(member.team_name || '-')}</td>
            <td class="px-4 py-4 text-slate-500">${escapeHtml(member.email || '')}</td>
            <td class="px-4 py-4 text-slate-500">${escapeHtml((payment?.status || member.payment_status || 'unpaid').toUpperCase())} • ${CONFIG.CURRENCY_SYMBOL}${Number(payment?.amount_paid ?? member.amount_paid ?? 0).toFixed(2)}</td>
            <td class="px-4 py-4 text-slate-500">${member.points_total || 0}</td>
            <td class="px-4 py-4 text-slate-500">${member.round_points || 0}</td>
            <td class="px-4 py-4 text-right">
                <button type="button" class="rounded-full border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-slate-900 hover:text-slate-950" data-edit-pool-member="${member.id}">
                    ${state.selectedMemberId === member.id ? 'Selected' : 'Edit'}
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });

    tbody.querySelectorAll('[data-edit-pool-member]').forEach(button => {
        button.addEventListener('click', () => {
            state.selectedMemberId = button.dataset.editPoolMember;
            renderSelectedPoolMember();
        });
    });
}

function bindUserModal() {
    byId('new-user-btn').addEventListener('click', () => openUserModal());
    byId('user-search').addEventListener('input', event => renderUsers(event.target.value));
    byId('user-modal-close').addEventListener('click', closeUserModal);
    byId('user-modal-cancel').addEventListener('click', closeUserModal);
    byId('archive-user-btn').addEventListener('click', archiveUser);
    byId('member-strong8k-enabled').addEventListener('change', toggleMembershipPanels);
    byId('member-playoff-enabled').addEventListener('change', toggleMembershipPanels);
    byId('add-license-btn').addEventListener('click', () => loadLicenseIntoForm());
    byId('license-form-save').addEventListener('click', saveLicenseLine);
    byId('license-form-cancel').addEventListener('click', clearLicenseForm);
    byId('user-form').addEventListener('submit', saveUser);
}

function openUserModal(userId = '') {
    const user = state.users.find(item => item.id === userId);
    const memberships = user ? (state.membershipsByUser[user.id] || {}) : {};
    const profile = user ? (state.strong8kProfiles[user.id] || normalizeStrong8kProfile({}, user)) : normalizeStrong8kProfile({}, {});
    const hasStrong8kData = Boolean(
        memberships[APP_IDS.STRONG8K]
        || state.strong8kProfiles[user?.id]
        || user?.username_8k
        || (Array.isArray(user?.licenses) && user.licenses.length)
        || user?.domain_8k
        || user?.setup_notes
    );

    byId('user-form').reset();
    byId('user-id').value = user?.id || '';
    byId('user-full-name').value = user?.full_name || '';
    byId('user-email').value = user?.email || '';
    byId('user-default-app').value = user?.default_app_id || '';

    byId('member-strong8k-enabled').checked = hasStrong8kData;
    byId('member-strong8k-role').value = memberships[APP_IDS.STRONG8K]?.role || 'member';
    byId('member-strong8k-status').value = memberships[APP_IDS.STRONG8K]?.status || 'active';
    byId('member-playoff-enabled').checked = Boolean(memberships[APP_IDS.PLAYOFF]);
    byId('member-playoff-role').value = memberships[APP_IDS.PLAYOFF]?.role || 'member';
    byId('member-playoff-status').value = memberships[APP_IDS.PLAYOFF]?.status || 'active';
    byId('member-playoff-pools').value = (memberships[APP_IDS.PLAYOFF]?.pool_ids || []).join(', ');

    byId('strong8k-domain').value = profile.domain_8k || '';
    byId('strong8k-backup-domain').value = profile.domain_8k_backup || '';
    byId('strong8k-credits').value = profile.credits_allocated || 0;
    byId('strong8k-live').value = (profile.live_preferences || []).join(', ');
    byId('strong8k-vod').value = (profile.vod_preferences || []).join(', ');
    byId('strong8k-custom-request').value = profile.custom_request || '';
    byId('strong8k-setup-notes').value = profile.setup_notes || '';
    byId('strong8k-internal-notes').value = profile.internal_notes || '';

    state.currentLicenses = [...(profile.licenses || [])];
    renderLicenseList();
    clearLicenseForm();
    toggleMembershipPanels();
    byId('archive-user-btn').classList.toggle('hidden', !user);
    byId('user-modal').classList.remove('hidden');
}

function closeUserModal() {
    byId('user-modal').classList.add('hidden');
}

function toggleMembershipPanels() {
    byId('strong8k-membership-panel').classList.toggle('hidden', !byId('member-strong8k-enabled').checked);
    byId('playoff-membership-panel').classList.toggle('hidden', !byId('member-playoff-enabled').checked);
}

function renderLicenseList() {
    const tbody = byId('license-table-body');
    tbody.innerHTML = '';

    if (!state.currentLicenses.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-6 text-center text-sm italic text-slate-400">No Strong8K licenses added yet.</td></tr>';
        return;
    }

    state.currentLicenses.forEach((license, index) => {
        const row = document.createElement('tr');
        row.className = 'border-b border-slate-100 text-sm';
        row.innerHTML = `
            <td class="px-4 py-4 font-semibold text-slate-950">${escapeHtml(license.label || `Line ${index + 1}`)}</td>
            <td class="px-4 py-4 text-slate-500">${escapeHtml(license.username_8k || '')}</td>
            <td class="px-4 py-4 text-slate-500">${formatDate(license.expiry_date)}</td>
            <td class="px-4 py-4 text-slate-500">${escapeHtml(license.status || 'Active')}</td>
            <td class="px-4 py-4 text-right">
                <button type="button" class="rounded-full border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-slate-900 hover:text-slate-950" data-license-edit="${index}">Edit</button>
            </td>
        `;
        tbody.appendChild(row);
    });

    tbody.querySelectorAll('[data-license-edit]').forEach(button => {
        button.addEventListener('click', () => loadLicenseIntoForm(Number(button.dataset.licenseEdit)));
    });
}

function loadLicenseIntoForm(index = -1) {
    const license = index >= 0 ? state.currentLicenses[index] : null;
    byId('license-edit-index').value = String(index);
    byId('license-label').value = license?.label || '';
    byId('license-status').value = license?.status || 'Active';
    byId('license-username').value = license?.username_8k || '';
    byId('license-password').value = license?.password_8k || '';
    byId('license-expiry').value = license?.expiry_date || '';
    byId('license-credits').value = license?.credits || 0;
    byId('license-package').value = license?.package_name || '';
    byId('license-price').value = license?.price_paid || '';
    byId('license-date-paid').value = license?.date_paid || '';
    byId('license-m3u').value = license?.m3u_url_8k || '';
    byId('license-epg').value = license?.epg_url_8k || '';
    byId('license-epgenius-key').value = license?.epgenius_key || '';
    byId('license-epgenius-url').value = license?.epgenius_url || '';
}

function clearLicenseForm() {
    byId('license-edit-index').value = '-1';
    [
        'license-label',
        'license-username',
        'license-password',
        'license-expiry',
        'license-credits',
        'license-package',
        'license-price',
        'license-date-paid',
        'license-m3u',
        'license-epg',
        'license-epgenius-key',
        'license-epgenius-url'
    ].forEach(id => {
        byId(id).value = '';
    });
    byId('license-status').value = 'Active';
}

function saveLicenseLine() {
    const editIndex = Number(byId('license-edit-index').value);
    const license = {
        id: editIndex >= 0 ? state.currentLicenses[editIndex].id : crypto.randomUUID(),
        label: byId('license-label').value,
        status: byId('license-status').value,
        username_8k: byId('license-username').value,
        password_8k: byId('license-password').value,
        expiry_date: byId('license-expiry').value,
        credits: Number(byId('license-credits').value || 0),
        package_name: byId('license-package').value,
        price_paid: byId('license-price').value,
        date_paid: byId('license-date-paid').value,
        m3u_url_8k: byId('license-m3u').value,
        epg_url_8k: byId('license-epg').value,
        epgenius_key: byId('license-epgenius-key').value,
        epgenius_url: byId('license-epgenius-url').value,
        history: editIndex >= 0 ? (state.currentLicenses[editIndex].history || []) : []
    };

    if (!license.username_8k || !license.password_8k || !license.expiry_date) {
        showToast('License username, password, and expiry are required', 'error');
        return;
    }

    if (editIndex >= 0) {
        state.currentLicenses[editIndex] = license;
    } else {
        state.currentLicenses.push(license);
    }

    renderLicenseList();
    clearLicenseForm();
}

async function saveUser(event) {
    event.preventDefault();

    const existingId = byId('user-id').value;
    const sharedUser = {
        full_name: byId('user-full-name').value,
        email: byId('user-email').value,
        default_app_id: byId('user-default-app').value || ''
    };

    let userRef;
    if (existingId) {
        userRef = doc(db, 'users', existingId);
        await setDoc(userRef, sharedUser, { merge: true });
    } else {
        userRef = await addDoc(collection(db, 'users'), {
            ...defaultSharedUser(sharedUser.email),
            ...sharedUser
        });
    }

    const userId = userRef.id;
    const previousMemberships = state.membershipsByUser[userId] || {};

    await syncMembership(userId, APP_IDS.STRONG8K, byId('member-strong8k-enabled').checked, {
        app_id: APP_IDS.STRONG8K,
        role: byId('member-strong8k-role').value,
        status: byId('member-strong8k-status').value,
        pool_ids: [],
        invite_code_used: previousMemberships[APP_IDS.STRONG8K]?.invite_code_used || '',
        created_at: previousMemberships[APP_IDS.STRONG8K]?.created_at || new Date().toISOString()
    });

    const playoffPoolIds = parseDelimitedList(byId('member-playoff-pools').value);
    await syncMembership(userId, APP_IDS.PLAYOFF, byId('member-playoff-enabled').checked, {
        app_id: APP_IDS.PLAYOFF,
        role: byId('member-playoff-role').value,
        status: byId('member-playoff-status').value,
        pool_ids: playoffPoolIds,
        invite_code_used: previousMemberships[APP_IDS.PLAYOFF]?.invite_code_used || '',
        created_at: previousMemberships[APP_IDS.PLAYOFF]?.created_at || new Date().toISOString()
    });

    const shouldPersistStrong8k = byId('member-strong8k-enabled').checked
        || state.currentLicenses.length > 0
        || Boolean(
            byId('strong8k-domain').value
            || byId('strong8k-backup-domain').value
            || byId('strong8k-live').value
            || byId('strong8k-vod').value
            || byId('strong8k-custom-request').value
            || byId('strong8k-setup-notes').value
            || byId('strong8k-internal-notes').value
        );

    if (shouldPersistStrong8k) {
        await setDoc(doc(db, 'strong8k_profiles', userId), {
            status: byId('member-strong8k-status').value,
            domain_8k: byId('strong8k-domain').value,
            domain_8k_backup: byId('strong8k-backup-domain').value,
            credits_allocated: Number(byId('strong8k-credits').value || 0),
            live_preferences: parseDelimitedList(byId('strong8k-live').value),
            vod_preferences: parseDelimitedList(byId('strong8k-vod').value),
            custom_request: byId('strong8k-custom-request').value,
            setup_notes: byId('strong8k-setup-notes').value,
            internal_notes: byId('strong8k-internal-notes').value,
            licenses: state.currentLicenses
        }, { merge: true });
    }

    await syncPoolMembers(userId, sharedUser, previousMemberships[APP_IDS.PLAYOFF]?.pool_ids || [], playoffPoolIds);

    closeUserModal();
    showToast('User saved');
    await loadAdminData();
}

async function syncMembership(userId, appId, enabled, membershipData) {
    const membershipRef = doc(db, 'users', userId, 'memberships', appId);
    if (!enabled) {
        await deleteDoc(membershipRef);
        return;
    }

    await setDoc(membershipRef, membershipData, { merge: true });
}

async function syncPoolMembers(userId, sharedUser, previousPoolIds, nextPoolIds) {
    const toRemove = previousPoolIds.filter(poolId => !nextPoolIds.includes(poolId));
    const toUpsert = nextPoolIds;

    for (const poolId of toRemove) {
        await deleteDoc(doc(db, 'playoff_pools', poolId, 'members', userId));
        await deleteDoc(doc(db, 'playoff_pools', poolId, 'payments', userId));
    }

    for (const poolId of toUpsert) {
        const pool = state.pools.find(item => item.id === poolId) || normalizePlayoffPool({ entry_fee_default: CONFIG.PLAYOFF_DEFAULT_ENTRY_FEE });
        const existingMemberSnap = await getDoc(doc(db, 'playoff_pools', poolId, 'members', userId));
        const existingMember = normalizePlayoffMember(existingMemberSnap.exists() ? { id: userId, ...existingMemberSnap.data() } : defaultPlayoffMember(sharedUser, pool), pool);
        const paymentRef = doc(db, 'playoff_pools', poolId, 'payments', userId);
        const existingPaymentSnap = await getDoc(paymentRef);
        const existingPayment = normalizePaymentRecord(existingPaymentSnap.exists() ? existingPaymentSnap.data() : defaultPaymentRecord(userId, pool), existingMember, pool);
        await setDoc(doc(db, 'playoff_pools', poolId, 'members', userId), {
            ...existingMember,
            uid: userId,
            display_name: sharedUser.full_name,
            email: sharedUser.email,
            amount_due: existingMember.amount_due || pool.entry_fee_default || CONFIG.PLAYOFF_DEFAULT_ENTRY_FEE,
            amount_paid: existingMember.amount_paid || 0,
            payment_status: existingMember.payment_status || 'unpaid',
            amount_remaining: Math.max(0, Number((existingMember.amount_due || pool.entry_fee_default || CONFIG.PLAYOFF_DEFAULT_ENTRY_FEE) - (existingMember.amount_paid || 0)))
        }, { merge: true });
        await setDoc(paymentRef, {
            ...existingPayment,
            member_uid: userId,
            amount_due: existingPayment.amount_due || pool.entry_fee_default || CONFIG.PLAYOFF_DEFAULT_ENTRY_FEE,
            amount_paid: existingPayment.amount_paid || 0,
            status: existingPayment.status || 'unpaid'
        }, { merge: true });
    }
}

async function archiveUser() {
    const userId = byId('user-id').value;
    if (!userId) return;
    await updateDoc(doc(db, 'users', userId), { deleted: true });
    closeUserModal();
    showToast('User archived');
    await loadAdminData();
}

function bindStrong8kForms() {
    byId('strong8k-config-form').addEventListener('submit', saveStrong8kConfig);
    byId('product-form').addEventListener('submit', saveStrong8kProduct);
    byId('new-product-btn').addEventListener('click', clearProductForm);
    byId('seed-strong8k-btn').addEventListener('click', seedStrong8kDefaults);
}

async function saveStrong8kConfig(event) {
    event.preventDefault();
    await setDoc(doc(db, 'strong8k_config', 'content_options'), {
        live_list: parseLineList(byId('strong8k-live-list').value),
        vod_list: parseLineList(byId('strong8k-vod-list').value)
    }, { merge: true });
    showToast('Strong8K config saved');
    await loadAdminData();
}

function parseLineList(value) {
    return String(value || '')
        .split(/\r?\n/)
        .map(item => item.trim())
        .filter(Boolean);
}

function loadProductIntoForm(productId) {
    const product = state.strong8kProducts.find(item => item.id === productId);
    if (!product) return;
    state.editingProductId = product.id;
    byId('product-id').value = product.id;
    byId('product-name').value = product.name || '';
    byId('product-price').value = product.price || 0;
    byId('product-credits').value = product.credits || 0;
}

function clearProductForm() {
    state.editingProductId = '';
    byId('product-id').value = '';
    byId('product-name').value = '';
    byId('product-price').value = '0';
    byId('product-credits').value = '0';
}

async function saveStrong8kProduct(event) {
    event.preventDefault();
    const productId = byId('product-id').value || slugify(byId('product-name').value) || crypto.randomUUID();
    await setDoc(doc(db, 'strong8k_products', productId), {
        name: byId('product-name').value,
        price: Number(byId('product-price').value || 0),
        credits: Number(byId('product-credits').value || 0)
    }, { merge: true });
    clearProductForm();
    showToast('Strong8K product saved');
    await loadAdminData();
}

async function seedStrong8kDefaults() {
    await setDoc(doc(db, 'strong8k_config', 'content_options'), {
        live_list: [
            "Elliot's Default (QC + Sports + English)",
            'Quebec Premium (French)',
            'Canada & USA (English)',
            'International (Europe/Latino)',
            'Adult 18+',
            'Other / Custom Request'
        ],
        vod_list: [
            "Elliot's Default (Movies & Series)",
            'French Content Only',
            'English Content Only',
            'International',
            'Adult',
            'None',
            'Other / Custom Request'
        ]
    }, { merge: true });

    const defaults = [
        { id: 'demo_1day', name: 'Demo (1 Day)', price: 0, credits: 0 },
        { id: '1_month', name: '1 Month Access', price: 10, credits: 1 },
        { id: '3_month', name: '3 Months Bundle', price: 25, credits: 3 },
        { id: '6_month', name: '6 Months Deal', price: 40, credits: 6 },
        { id: '12_month', name: '1 Year VIP', price: 60, credits: 12 }
    ];

    for (const product of defaults) {
        await setDoc(doc(db, 'strong8k_products', product.id), product, { merge: true });
    }

    showToast('Strong8K defaults seeded');
    await loadAdminData();
}

function bindPlayoffForms() {
    byId('new-pool-btn').addEventListener('click', clearPoolForm);
    byId('pool-form').addEventListener('submit', savePool);
    byId('new-round-btn').addEventListener('click', clearRoundForm);
    byId('round-form').addEventListener('submit', saveRound);
    byId('new-series-btn').addEventListener('click', clearSeriesForm);
    byId('series-form').addEventListener('submit', saveSeries);
    byId('round-number-input').addEventListener('input', syncRoundScoringDefaults);
    byId('pool-member-form').addEventListener('submit', savePoolMember);
    byId('clear-pool-member-btn').addEventListener('click', clearPoolMemberForm);
    byId('pick-override-form').addEventListener('submit', savePickOverrides);
    byId('reload-pick-overrides-btn').addEventListener('click', renderSelectedPoolMember);
    byId('rescore-round-btn').addEventListener('click', rescoreSelectedRound);
}

function loadPoolIntoForm(poolId) {
    const pool = state.pools.find(item => item.id === poolId);
    if (!pool) return;
    state.editingPoolId = pool.id;
    byId('pool-id').value = pool.id;
    byId('pool-name-input').value = pool.name || '';
    byId('pool-season-input').value = pool.season_label || '';
    byId('pool-status-input').value = pool.status || 'draft';
    byId('pool-entry-fee-input').value = pool.entry_fee_default || CONFIG.PLAYOFF_DEFAULT_ENTRY_FEE;
    byId('pool-pick-visibility-input').value = pool.pick_visibility || 'after-lock';
    byId('pool-lock-policy-input').value = pool.lock_policy || 'deadline';
    byId('pool-description-input').value = pool.description || '';
    byId('pool-payout-template-input').value = formatPayoutTemplate(pool.payout_template || defaultPayoutTemplate());
}

function clearPoolForm() {
    const templateLines = formatPayoutTemplate(defaultPayoutTemplate());
    state.editingPoolId = '';
    byId('pool-id').value = '';
    byId('pool-name-input').value = '';
    byId('pool-season-input').value = '';
    byId('pool-status-input').value = 'draft';
    byId('pool-entry-fee-input').value = String(CONFIG.PLAYOFF_DEFAULT_ENTRY_FEE);
    byId('pool-pick-visibility-input').value = 'after-lock';
    byId('pool-lock-policy-input').value = 'deadline';
    byId('pool-description-input').value = '';
    byId('pool-payout-template-input').value = templateLines;
}

async function savePool(event) {
    event.preventDefault();
    const poolId = byId('pool-id').value || slugify(byId('pool-name-input').value) || crypto.randomUUID();
    const existingPool = state.pools.find(item => item.id === poolId) || normalizePlayoffPool({});
    const payoutTemplate = parsePayoutTemplate(byId('pool-payout-template-input').value);
    const entryFeeDefault = Number(byId('pool-entry-fee-input').value || CONFIG.PLAYOFF_DEFAULT_ENTRY_FEE);
    const updatedPool = normalizePlayoffPool({
        ...existingPool,
        name: byId('pool-name-input').value,
        season_label: byId('pool-season-input').value,
        status: byId('pool-status-input').value,
        description: byId('pool-description-input').value,
        entry_fee_default: entryFeeDefault,
        pick_visibility: byId('pool-pick-visibility-input').value,
        lock_policy: byId('pool-lock-policy-input').value,
        payout_template: payoutTemplate
    });

    await setDoc(doc(db, 'playoff_pools', poolId), {
        ...updatedPool
    }, { merge: true });
    state.selectedPoolId = poolId;
    showToast('Pool saved');
    await loadAdminData();
}

function loadRoundIntoForm(roundId) {
    const round = state.rounds.find(item => item.id === roundId);
    if (!round) return;
    state.editingRoundId = round.id;
    byId('round-id').value = round.id;
    byId('round-name-input').value = round.name || '';
    byId('round-number-input').value = round.round_number || round.sort_order || 1;
    byId('round-order-input').value = round.sort_order || 1;
    byId('round-status-input').value = round.status || 'draft';
    byId('round-deadline-input').value = toDateTimeLocal(round.pick_deadline);
    byId('round-lock-at-input').value = toDateTimeLocal(round.lock_at);
    byId('round-winner-points-input').value = round.winner_points || 0;
    byId('round-games-points-input').value = round.games_points || 0;
}

function clearRoundForm() {
    const defaults = defaultPlayoffRound(1);
    state.editingRoundId = '';
    byId('round-id').value = '';
    byId('round-name-input').value = '';
    byId('round-number-input').value = '1';
    byId('round-order-input').value = '1';
    byId('round-status-input').value = 'draft';
    byId('round-deadline-input').value = '';
    byId('round-lock-at-input').value = '';
    byId('round-winner-points-input').value = String(defaults.winner_points);
    byId('round-games-points-input').value = String(defaults.games_points);
}

async function saveRound(event) {
    event.preventDefault();
    if (!state.selectedPoolId) {
        showToast('Choose or create a pool first', 'error');
        return;
    }

    const roundId = byId('round-id').value || slugify(byId('round-name-input').value) || crypto.randomUUID();
    const roundNumber = Number(byId('round-number-input').value || 1);
    const defaults = defaultPlayoffRound(roundNumber);
    await setDoc(doc(db, 'playoff_pools', state.selectedPoolId, 'rounds', roundId), {
        name: byId('round-name-input').value,
        round_number: roundNumber,
        sort_order: Number(byId('round-order-input').value || 0),
        status: byId('round-status-input').value,
        pick_deadline: byId('round-deadline-input').value ? new Date(byId('round-deadline-input').value).toISOString() : '',
        lock_at: byId('round-lock-at-input').value ? new Date(byId('round-lock-at-input').value).toISOString() : (byId('round-deadline-input').value ? new Date(byId('round-deadline-input').value).toISOString() : ''),
        round_multiplier: defaults.round_multiplier,
        winner_points: Number(byId('round-winner-points-input').value || defaults.winner_points),
        games_points: Number(byId('round-games-points-input').value || defaults.games_points)
    }, { merge: true });
    state.selectedRoundId = roundId;
    showToast('Round saved');
    await loadAdminData();
}

function loadSeriesIntoForm(seriesId) {
    const series = state.series.find(item => item.id === seriesId);
    if (!series) return;
    state.editingSeriesId = series.id;
    byId('series-id').value = series.id;
    byId('series-order-input').value = series.sort_order || 1;
    byId('series-label-input').value = series.matchup_label || '';
    byId('series-home-id-input').value = series.home_team_id || '';
    byId('series-home-name-input').value = series.home_team_name || '';
    byId('series-away-id-input').value = series.away_team_id || '';
    byId('series-away-name-input').value = series.away_team_name || '';
    byId('series-status-input').value = series.status || 'open';
    byId('series-result-winner-input').value = series.result_winner_team_id || '';
    byId('series-result-games-input').value = series.result_games || '';
    byId('series-notes-input').value = series.notes || '';
}

function clearSeriesForm() {
    state.editingSeriesId = '';
    byId('series-id').value = '';
    byId('series-order-input').value = '1';
    byId('series-label-input').value = '';
    byId('series-home-id-input').value = '';
    byId('series-home-name-input').value = '';
    byId('series-away-id-input').value = '';
    byId('series-away-name-input').value = '';
    byId('series-status-input').value = 'open';
    byId('series-result-winner-input').value = '';
    byId('series-result-games-input').value = '';
    byId('series-notes-input').value = '';
}

async function saveSeries(event) {
    event.preventDefault();
    if (!state.selectedPoolId || !state.selectedRoundId) {
        showToast('Choose a pool and round first', 'error');
        return;
    }

    const seriesId = byId('series-id').value || slugify(byId('series-label-input').value) || crypto.randomUUID();
    await setDoc(doc(db, 'playoff_pools', state.selectedPoolId, 'rounds', state.selectedRoundId, 'series', seriesId), {
        sort_order: Number(byId('series-order-input').value || 0),
        matchup_label: byId('series-label-input').value,
        home_team_id: byId('series-home-id-input').value,
        home_team_name: byId('series-home-name-input').value,
        away_team_id: byId('series-away-id-input').value,
        away_team_name: byId('series-away-name-input').value,
        status: byId('series-status-input').value,
        result_winner_team_id: byId('series-result-winner-input').value,
        result_games: Number(byId('series-result-games-input').value || 0),
        notes: byId('series-notes-input').value
    }, { merge: true });
    showToast('Series saved');
    await loadAdminData();
}

function getSelectedPool() {
    return state.pools.find(item => item.id === state.selectedPoolId) || null;
}

function getSelectedRound() {
    return state.rounds.find(item => item.id === state.selectedRoundId) || null;
}

function getSelectedMember() {
    return state.poolMembers.find(item => item.id === state.selectedMemberId) || null;
}

function getPaymentForMember(memberId) {
    return state.payments.find(item => item.id === memberId || item.member_uid === memberId) || null;
}

function syncRoundScoringDefaults() {
    const roundNumber = Number(byId('round-number-input').value || 1);
    const defaults = defaultPlayoffRound(roundNumber);
    byId('round-order-input').value = String(roundNumber);
    byId('round-winner-points-input').value = String(defaults.winner_points);
    byId('round-games-points-input').value = String(defaults.games_points);
    if (!byId('round-name-input').value.trim()) {
        byId('round-name-input').value = defaults.name;
    }
}

function parsePayoutTemplate(value) {
    const parsed = String(value || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const [rawKey, rawShare] = line.split(':');
            return {
                place_key: String(rawKey || '').trim(),
                label: String(rawKey || '').trim(),
                share: Number(String(rawShare || '').trim() || 0)
            };
        })
        .filter(item => item.place_key);

    return normalizePayoutTemplate(parsed.length ? parsed : defaultPayoutTemplate());
}

function formatPayoutTemplate(template = []) {
    return normalizePayoutTemplate(template)
        .map(item => `${item.place_key}: ${item.share}`)
        .join('\n');
}

function clearPoolMemberForm() {
    const pool = getSelectedPool() || normalizePlayoffPool({ entry_fee_default: CONFIG.PLAYOFF_DEFAULT_ENTRY_FEE });
    byId('pool-member-id').value = '';
    byId('pool-member-display-name').value = '';
    byId('pool-member-email').value = '';
    byId('pool-member-team-name').value = '';
    byId('pool-member-payment-status').value = 'unpaid';
    byId('pool-member-amount-due').value = String(pool.entry_fee_default || CONFIG.PLAYOFF_DEFAULT_ENTRY_FEE);
    byId('pool-member-amount-paid').value = '0';
    byId('pool-member-paid-at').value = '';
    byId('pool-member-payment-method').value = '';
    byId('pool-member-late-payment').checked = false;
    byId('pool-member-eligible-payout').checked = false;
    byId('pool-member-payout-place').value = '';
    byId('pool-member-payout-amount').value = '0';
    byId('pool-member-payment-notes').value = '';
}

function renderSelectedPoolMember() {
    const pool = getSelectedPool() || normalizePlayoffPool({ entry_fee_default: CONFIG.PLAYOFF_DEFAULT_ENTRY_FEE });
    const member = getSelectedMember();
    const payment = member ? normalizePaymentRecord(getPaymentForMember(member.id) || {}, member, pool) : null;

    if (!member) {
        clearPoolMemberForm();
        byId('pick-override-list').innerHTML = '<p class="text-sm text-slate-400">Choose a pool member to review their picks and override eligibility.</p>';
        return;
    }

    byId('pool-member-id').value = member.id;
    byId('pool-member-display-name').value = member.display_name || '';
    byId('pool-member-email').value = member.email || '';
    byId('pool-member-team-name').value = member.team_name || '';
    byId('pool-member-payment-status').value = payment?.status || member.payment_status || 'unpaid';
    byId('pool-member-amount-due').value = String(payment?.amount_due ?? member.amount_due ?? pool.entry_fee_default);
    byId('pool-member-amount-paid').value = String(payment?.amount_paid ?? member.amount_paid ?? 0);
    byId('pool-member-paid-at').value = (payment?.paid_at || member.paid_at || '').slice(0, 10);
    byId('pool-member-payment-method').value = payment?.method || member.payment_method || '';
    byId('pool-member-late-payment').checked = Boolean(payment?.late_payment_flag ?? member.late_payment_flag);
    byId('pool-member-eligible-payout').checked = Boolean(payment?.eligible_for_payout ?? member.eligible_for_payout);
    byId('pool-member-payout-place').value = member.payout_place || '';
    byId('pool-member-payout-amount').value = String(member.payout_amount || 0);
    byId('pool-member-payment-notes').value = payment?.notes || member.payment_notes || '';

    renderPickOverrideList(member);
}

function renderPickOverrideList(member) {
    const container = byId('pick-override-list');
    container.innerHTML = '';

    if (!member || !state.selectedRoundId) {
        container.innerHTML = '<p class="text-sm text-slate-400">Choose a round and member first.</p>';
        return;
    }

    if (!state.series.length) {
        container.innerHTML = '<p class="text-sm text-slate-400">No series are configured for the selected round.</p>';
        return;
    }

    const pickDoc = state.roundPickDocs.find(item => item.id === member.id) || normalizePickDoc({
        id: member.id,
        entries: state.series.map(series => ({ series_id: series.id }))
    });

    container.innerHTML = state.series.map(series => {
        const entry = pickDoc.entries.find(item => item.series_id === series.id) || { series_id: series.id };
        return `
            <article class="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
                <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                        <p class="text-sm font-bold text-slate-950">${escapeHtml(series.matchup_label || `${series.home_team_name || series.home_team_id} vs ${series.away_team_name || series.away_team_id}`)}</p>
                        <p class="mt-1 text-xs uppercase tracking-[0.2em] text-slate-400">Pick: ${escapeHtml(buildCompactPickLabel(entry, series) || 'No saved pick')}</p>
                    </div>
                    <div class="text-right text-xs text-slate-500">
                        <p>Scored: ${entry.series_points_total || 0}</p>
                        <p>Winner ${entry.winner_points_awarded || 0} • Games ${entry.games_points_awarded || 0}</p>
                    </div>
                </div>
                <div class="mt-4 grid gap-3 md:grid-cols-3">
                    <label class="inline-flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700">
                        <input type="checkbox" data-override-series="${series.id}" data-field="winner_eligibility" class="h-4 w-4 rounded border-slate-300" ${entry.winner_eligibility !== false ? 'checked' : ''}>
                        Winner eligible
                    </label>
                    <label class="inline-flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700">
                        <input type="checkbox" data-override-series="${series.id}" data-field="games_eligibility" class="h-4 w-4 rounded border-slate-300" ${entry.games_eligibility !== false ? 'checked' : ''}>
                        Games eligible
                    </label>
                    <input type="text" data-override-series="${series.id}" data-field="eligibility_reason" value="${escapeAttribute(entry.eligibility_reason || '')}" placeholder="Override reason" class="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-900">
                </div>
            </article>
        `;
    }).join('');
}

async function savePoolMember(event) {
    event.preventDefault();
    if (!state.selectedPoolId) {
        showToast('Choose a pool first', 'error');
        return;
    }

    const memberId = byId('pool-member-id').value;
    if (!memberId) {
        showToast('Select a pool member from the table first', 'error');
        return;
    }

    const pool = getSelectedPool() || normalizePlayoffPool({ entry_fee_default: CONFIG.PLAYOFF_DEFAULT_ENTRY_FEE });
    const existingMember = getSelectedMember() || defaultPlayoffMember({}, pool);
    const amountDue = Number(byId('pool-member-amount-due').value || pool.entry_fee_default || CONFIG.PLAYOFF_DEFAULT_ENTRY_FEE);
    const amountPaid = Number(byId('pool-member-amount-paid').value || 0);
    const paymentStatus = derivePaymentStatus({
        amount_due: amountDue,
        amount_paid: amountPaid,
        payment_status: byId('pool-member-payment-status').value
    });

    const nextMember = normalizePlayoffMember({
        ...existingMember,
        uid: memberId,
        display_name: byId('pool-member-display-name').value,
        email: byId('pool-member-email').value,
        team_name: byId('pool-member-team-name').value,
        payment_status: paymentStatus,
        amount_due: amountDue,
        amount_paid: amountPaid,
        paid_at: byId('pool-member-paid-at').value,
        payment_method: byId('pool-member-payment-method').value,
        payment_notes: byId('pool-member-payment-notes').value,
        late_payment_flag: byId('pool-member-late-payment').checked,
        eligible_for_payout: byId('pool-member-eligible-payout').checked,
        payout_place: byId('pool-member-payout-place').value,
        payout_amount: Number(byId('pool-member-payout-amount').value || 0),
        updated_at: new Date().toISOString()
    }, pool);

    const nextPayment = normalizePaymentRecord({
        member_uid: memberId,
        amount_due: amountDue,
        amount_paid: amountPaid,
        status: paymentStatus,
        paid_at: byId('pool-member-paid-at').value,
        method: byId('pool-member-payment-method').value,
        notes: byId('pool-member-payment-notes').value,
        late_payment_flag: byId('pool-member-late-payment').checked,
        eligible_for_payout: byId('pool-member-eligible-payout').checked
    }, nextMember, pool);

    await setDoc(doc(db, 'playoff_pools', state.selectedPoolId, 'members', memberId), nextMember, { merge: true });
    await setDoc(doc(db, 'playoff_pools', state.selectedPoolId, 'payments', memberId), nextPayment, { merge: true });

    showToast('Entrant saved');
    await loadSelectedPoolData();
    renderAdmin();
}

async function savePickOverrides(event) {
    event.preventDefault();
    if (!state.selectedPoolId || !state.selectedRoundId || !state.selectedMemberId) {
        showToast('Choose a pool, round, and member first', 'error');
        return;
    }

    const member = getSelectedMember();
    const existingPick = state.roundPickDocs.find(item => item.id === state.selectedMemberId) || normalizePickDoc({
        pool_id: state.selectedPoolId,
        round_id: state.selectedRoundId,
        entries: state.series.map(series => ({ series_id: series.id }))
    });

    const inputs = [...byId('pick-override-list').querySelectorAll('[data-override-series]')];
    const overrides = {};
    inputs.forEach(input => {
        const seriesId = input.dataset.overrideSeries;
        const field = input.dataset.field;
        overrides[seriesId] = overrides[seriesId] || {};
        overrides[seriesId][field] = input.type === 'checkbox' ? input.checked : input.value;
    });

    const entries = state.series.map(series => {
        const currentEntry = existingPick.entries.find(item => item.series_id === series.id) || { series_id: series.id };
        const override = overrides[series.id] || {};
        return {
            ...currentEntry,
            series_id: series.id,
            winner_eligibility: override.winner_eligibility !== false,
            games_eligibility: override.games_eligibility !== false,
            eligibility_reason: override.eligibility_reason || ''
        };
    });

    await setDoc(doc(db, 'playoff_pools', state.selectedPoolId, 'rounds', state.selectedRoundId, 'picks', state.selectedMemberId), {
        ...existingPick,
        pool_id: state.selectedPoolId,
        round_id: state.selectedRoundId,
        member_uid: state.selectedMemberId,
        team_name: member?.team_name || '',
        entries,
        updated_at: new Date().toISOString()
    }, { merge: true });

    showToast('Overrides saved');
    await loadSelectedPoolData();
    renderAdmin();
}

function getPoolPayoutSummary(pool = getSelectedPool()) {
    if (!pool) return [];
    const suggested = pool.suggested_payouts?.length
        ? pool.suggested_payouts
        : suggestPayouts({
            collectedPot: computeCollectedPot(state.payments, state.poolMembers),
            participantCount: state.poolMembers.length,
            template: pool.payout_template
        });
    return mergeFinalizedPayouts(suggested, pool.finalized_payouts);
}

function renderPlayoffReportSummary() {
    const container = byId('playoff-report-summary');
    if (!container) return;

    const pool = getSelectedPool();
    if (!pool) {
        container.innerHTML = '<p class="text-sm text-slate-400">Choose a pool to view report summaries.</p>';
        return;
    }

    const payoutSummary = getPoolPayoutSummary(pool);
    const seriesById = Object.fromEntries(state.series.map(series => [series.id, series]));
    const pickByMember = Object.fromEntries(state.roundPickDocs.map(item => [item.id, item]));
    const pickDistribution = buildPickDistribution(state.series, state.roundPickDocs);

    container.innerHTML = `
        <div class="grid gap-4 md:grid-cols-4">
            ${payoutSummary.map(item => `
                <div class="rounded-[1.25rem] border border-slate-200 bg-slate-50 p-4">
                    <p class="text-xs font-bold uppercase tracking-[0.22em] text-slate-400">${escapeHtml(item.label || item.place_key)}</p>
                    <p class="mt-2 text-2xl font-black text-slate-950">${CONFIG.CURRENCY_SYMBOL}${Number(item.manual_override && item.final_amount ? item.final_amount : item.final_amount || item.suggested_amount || 0).toFixed(2)}</p>
                </div>
            `).join('')}
        </div>
        <div class="overflow-hidden rounded-[1.5rem] border border-slate-100">
            <table class="w-full text-left">
                <thead class="bg-slate-50 text-[11px] uppercase tracking-[0.22em] text-slate-400">
                    <tr>
                        <th class="px-4 py-3">Entrant</th>
                        <th class="px-4 py-3">Team</th>
                        <th class="px-4 py-3">Paid</th>
                        <th class="px-4 py-3">Current Round</th>
                        <th class="px-4 py-3">Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${state.poolMembers.map(member => {
                        const payment = getPaymentForMember(member.id) || member;
                        const currentPick = pickByMember[member.id];
                        const compactPicks = (currentPick?.entries || [])
                            .map(entry => buildCompactPickLabel(entry, seriesById[entry.series_id] || {}))
                            .filter(Boolean)
                            .join(' • ');
                        return `
                            <tr class="border-b border-slate-100 text-sm">
                                <td class="px-4 py-4 font-semibold text-slate-950">${escapeHtml(member.display_name || member.email || member.id)}</td>
                                <td class="px-4 py-4 text-slate-500">${escapeHtml(member.team_name || '-')}</td>
                                <td class="px-4 py-4 text-slate-500">${escapeHtml(payment.status || member.payment_status || 'unpaid')} (${CONFIG.CURRENCY_SYMBOL}${Number(payment.amount_paid ?? member.amount_paid ?? 0).toFixed(2)})</td>
                                <td class="px-4 py-4 text-slate-500">${escapeHtml(compactPicks || 'No picks')}</td>
                                <td class="px-4 py-4 text-slate-500">${member.points_total || 0}</td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
        <div class="grid gap-4">
            ${pickDistribution.map(item => `
                <div class="rounded-[1.25rem] border border-slate-200 bg-slate-50 p-4">
                    <p class="text-sm font-bold text-slate-950">${escapeHtml(item.matchup_label)}</p>
                    <p class="mt-2 text-xs uppercase tracking-[0.2em] text-slate-400">Winner split</p>
                    <p class="mt-2 text-sm text-slate-600">${Object.entries(item.winner_counts).map(([key, count]) => `${key}: ${count}`).join(' • ') || 'No picks yet'}</p>
                    <p class="mt-3 text-xs uppercase tracking-[0.2em] text-slate-400">Games split</p>
                    <p class="mt-2 text-sm text-slate-600">${Object.entries(item.games_counts).filter(([, count]) => count > 0).map(([key, count]) => `${key}: ${count}`).join(' • ') || 'No picks yet'}</p>
                </div>
            `).join('')}
        </div>
    `;
}

async function rescoreSelectedRound() {
    if (!state.selectedPoolId || !state.selectedRoundId) {
        showToast('Choose a pool and round first', 'error');
        return;
    }

    const pool = getSelectedPool();
    const round = getSelectedRound();
    if (!pool || !round) {
        showToast('The selected pool or round could not be found', 'error');
        return;
    }

    const now = new Date().toISOString();
    const currentRoundPicksSnap = await getDocs(collection(db, 'playoff_pools', state.selectedPoolId, 'rounds', state.selectedRoundId, 'picks'));
    const scoredCurrentRoundDocs = currentRoundPicksSnap.docs.map(item => {
        const scored = scorePickDocument(normalizePickDoc({ id: item.id, ...item.data() }), state.series, round);
        return { id: item.id, ...scored };
    });

    for (const pickDoc of scoredCurrentRoundDocs) {
        await setDoc(doc(db, 'playoff_pools', state.selectedPoolId, 'rounds', state.selectedRoundId, 'picks', pickDoc.id), {
            ...pickDoc,
            updated_at: now
        }, { merge: true });
    }

    const picksByRound = {};
    for (const existingRound of state.rounds) {
        if (existingRound.id === state.selectedRoundId) {
            picksByRound[existingRound.id] = Object.fromEntries(scoredCurrentRoundDocs.map(item => [item.id, item]));
            continue;
        }

        const picksSnap = await getDocs(collection(db, 'playoff_pools', state.selectedPoolId, 'rounds', existingRound.id, 'picks'));
        picksByRound[existingRound.id] = Object.fromEntries(
            picksSnap.docs.map(item => [item.id, normalizePickDoc({ id: item.id, ...item.data() })])
        );
    }

    const updatedMembers = [];
    for (const member of state.poolMembers) {
        const totals = computeMemberTotalsFromScoredPicks(state.rounds, Object.fromEntries(
            state.rounds.map(existingRound => [existingRound.id, picksByRound[existingRound.id]?.[member.id] || { round_total: 0 }])
        ));

        const nextMember = normalizePlayoffMember({
            ...member,
            ...totals,
            updated_at: now
        }, pool);
        updatedMembers.push(nextMember);
    }

    const rankedMembers = sortStandings(updatedMembers);
    const payoutSummary = getPoolPayoutSummary(pool);
    const rankedPayouts = payoutSummary.filter(item => Number(item.final_amount || item.suggested_amount || 0) > 0);

    for (const [index, member] of rankedMembers.entries()) {
        const payout = member.eligible_for_payout ? rankedPayouts[index] : null;
        const resolvedAmount = payout
            ? Number(payout.manual_override && payout.final_amount ? payout.final_amount : payout.final_amount || payout.suggested_amount || 0)
            : 0;
        await setDoc(doc(db, 'playoff_pools', state.selectedPoolId, 'members', member.id), {
            ...member,
            payout_place: payout?.place_key || '',
            payout_amount: resolvedAmount
        }, { merge: true });
    }

    const suggestedPayouts = suggestPayouts({
        collectedPot: computeCollectedPot(state.payments, rankedMembers),
        participantCount: rankedMembers.length,
        template: pool.payout_template
    });
    await setDoc(doc(db, 'playoff_pools', state.selectedPoolId), {
        suggested_payouts: suggestedPayouts
    }, { merge: true });

    showToast('Round rescored and totals updated');
    await loadAdminData();
}

function escapeAttribute(value) {
    return String(value || '').replace(/"/g, '&quot;');
}

function toDateTimeLocal(value) {
    if (!value) return '';
    const date = new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
}
