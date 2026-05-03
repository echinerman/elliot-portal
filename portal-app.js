import { CONFIG } from './config.js?v=20260502-picks-auth';
import {
    APP_DEFINITIONS,
    APP_IDS,
    defaultMembership,
    defaultSharedUser,
    deriveAccessibleApps,
    formatDate,
    getSetupNotesValue,
    normalizeStrong8kProfile,
    sortByPrice
} from './app-model.js?v=20260502-picks-auth';
import {
    buildCompactPickLabel,
    buildDraftFromEntries,
    buildPickDistribution,
    buildStandingsTrend,
    computeCollectedPot,
    computeMemberPotentialPoints,
    isRoundLocked,
    isRoundRevealed,
    isSeriesLocked,
    mergeFinalizedPayouts,
    normalizePaymentRecord,
    normalizePlayoffMember,
    normalizePlayoffPool,
    normalizePlayoffRound,
    normalizePlayoffSeries,
    normalizePickDoc,
    pickCurrentRound,
    scorePickDocument,
    sortStandings,
    suggestPayouts
} from './playoff-logic.js?v=20260502-picks-auth';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import {
    createUserWithEmailAndPassword,
    getAuth,
    onAuthStateChanged,
    sendPasswordResetEmail,
    signInWithEmailAndPassword,
    signOut
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    getFirestore,
    orderBy,
    query,
    runTransaction,
    setDoc,
    where
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const firebaseApp = initializeApp(CONFIG.FIREBASE);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

const VIEW_IDS = [
    'loading-view',
    'auth-view',
    'app-switcher-view',
    'no-access-view',
    'strong8k-view',
    'playoff-view'
];

const state = {
    authUser: null,
    sharedUser: null,
    memberships: {},
    accessibleApps: {},
    activeAppId: null,
    strong8k: {
        profile: null,
        products: [],
        contentOptions: { live_list: [], vod_list: [] }
    },
    playoff: {
        membership: null,
        pool: null,
        poolId: '',
        member: null,
        payment: null,
        rounds: [],
        currentRound: null,
        series: [],
        currentPick: null,
        previousPicks: [],
        standings: [],
        roundPickDocs: [],
        payoutSummary: [],
        pickDistribution: [],
        standingsTrend: [],
        teamNameDraft: '',
        draft: {},
        scenarioDraft: {},
        isLocked: false,
        visibleSections: null,
        picksBoardSort: 'standings',
        picksBoardFilter: null,
        picksBoardFlipped: false,
        eventHistory: [],
        timelineIndex: 0,
        chartType: 'rank',
        historySeriesMap: {},
        historyPickDocsMap: {}
    }
};

const PLAYOFF_SECTIONS = [
    { key: 'standings',  label: 'Standings',      icon: '🏆', sectionId: 'section-standings'  },
    { key: 'picksBoard', label: 'Picks Board',     icon: '📋', sectionId: 'picks-board-section' },
    { key: 'myPicks',    label: 'My Picks',        icon: '🎯', sectionId: 'section-my-picks'   },
    { key: 'overview',   label: 'Pool Overview',   icon: '📊', sectionId: 'section-overview'   },
    { key: 'whatif',     label: 'What-If Lab',     icon: '🔬', sectionId: 'section-whatif'     },
    { key: 'rules',      label: 'Pool Rules',      icon: '📜', sectionId: 'section-rules'      },
    { key: 'payouts',    label: 'Payout & Status', icon: '💰', sectionId: 'section-payouts'    },
    { key: 'trends',     label: 'Trends',          icon: '📈', sectionId: 'section-trends'     },
];
const SECTIONS_DEFAULT_ON = new Set(['standings', 'picksBoard']);
const LS_VISIBLE_KEY = 'playoff_visible_sections';

document.addEventListener('DOMContentLoaded', () => {
    bindAuthForms();
    bindNoAccessEvents();
    bindStrong8kEvents();
    bindPlayoffEvents();
    bindSharedActions();
    setView('auth-view');
    onAuthStateChanged(auth, handleAuthStateChange);
    window.addEventListener('hashchange', () => {
        if (state.authUser) {
            routeAuthenticatedUser().catch(handlePortalLoadError);
        }
    });
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

function setView(viewId) {
    VIEW_IDS.forEach(id => byId(id).classList.toggle('hidden', id !== viewId));
}

function currentHashApp() {
    const match = window.location.hash.match(/^#\/app\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
}

function isAppsHomeRoute() {
    return window.location.hash === '#/apps';
}

function resolveInviteCode(code) {
    const normalized = String(code || '').trim().toUpperCase();
    return Object.entries(CONFIG.INVITE_CODES).find(([, inviteCode]) => inviteCode.toUpperCase() === normalized)?.[0] || null;
}


function resetSessionState() {
    state.sharedUser = null;
    state.memberships = {};
    state.accessibleApps = {};
    state.activeAppId = null;
    state.strong8k = {
        profile: null,
        products: [],
        contentOptions: { live_list: [], vod_list: [] }
    };
    state.playoff = {
        membership: null,
        pool: null,
        poolId: '',
        member: null,
        payment: null,
        rounds: [],
        currentRound: null,
        series: [],
        currentPick: null,
        previousPicks: [],
        standings: [],
        roundPickDocs: [],
        payoutSummary: [],
        pickDistribution: [],
        standingsTrend: [],
        teamNameDraft: '',
        draft: {},
        scenarioDraft: {},
        isLocked: false,
        visibleSections: null,
        picksBoardSort: 'standings',
        picksBoardFilter: null,
        picksBoardFlipped: false,
        eventHistory: [],
        timelineIndex: 0,
        chartType: 'rank',
        historySeriesMap: {},
        historyPickDocsMap: {}
    };
}

async function handleAuthStateChange(user) {
    state.authUser = user;

    if (!user) {
        resetSessionState();
        setView('auth-view');
        return;
    }

    try {
        setView('loading-view');
        await hydrateSession(user);
        await routeAuthenticatedUser();
    } catch (error) {
        handlePortalLoadError(error);
    }
}

async function hydrateSession(user) {
    state.sharedUser = await loadSharedUser(user);
    state.memberships = await loadMemberships(user.uid);
    state.accessibleApps = deriveAccessibleApps(state.memberships, state.sharedUser);
    byId('switcher-email').textContent = user.email;
    byId('no-access-email').textContent = user.email;
}

function getActiveMemberships() {
    return Object.fromEntries(
        Object.entries(state.accessibleApps).filter(([, membership]) => membership.status === 'active')
    );
}

function getPendingMemberships() {
    return Object.fromEntries(
        Object.entries(state.accessibleApps).filter(([, membership]) => membership.status !== 'active')
    );
}

async function routeAuthenticatedUser() {
    const activeMemberships = getActiveMemberships();
    const requestedAppId = currentHashApp();
    const wantsAppSwitcher = isAppsHomeRoute();

    if (requestedAppId && activeMemberships[requestedAppId]) {
        await openApp(requestedAppId);
        return;
    }

    const appIds = Object.keys(activeMemberships);
    if (wantsAppSwitcher && appIds.length) {
        renderAppSwitcher(activeMemberships);
        setView('app-switcher-view');
        return;
    }

    if (appIds.length === 1) {
        const appId = appIds[0];
        window.location.hash = APP_DEFINITIONS[appId].route;
        await openApp(appId);
        return;
    }

    if (appIds.length > 1) {
        renderAppSwitcher(activeMemberships);
        setView('app-switcher-view');
        return;
    }

    renderInviteCodePrompt();
    setView('no-access-view');
}

function handlePortalLoadError(error) {
    console.error('Portal load failed', error);
    if (state.authUser?.email) {
        byId('no-access-email').textContent = state.authUser.email;
    }

    const activeMemberships = getActiveMemberships();
    if (state.authUser && Object.keys(activeMemberships).length) {
        renderAppSwitcher(activeMemberships);
        setView('app-switcher-view');
        showToast(error?.message || 'Portal load failed', 'error');
        return;
    }

    renderInviteCodePrompt();
    setView('no-access-view');
    showToast(error?.message || 'Portal load failed', 'error');
}

async function openApp(appId) {
    state.activeAppId = appId;

    if (appId === APP_IDS.STRONG8K) {
        await loadStrong8kApp();
        setView('strong8k-view');
        return;
    }

    if (appId === APP_IDS.PLAYOFF) {
        await loadPlayoffApp();
        setView('playoff-view');
    }
}

async function loadSharedUser(user) {
    const userRef = doc(db, 'users', user.uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
        const newUser = {
            ...defaultSharedUser(user.email),
            email: user.email
        };
        await setDoc(userRef, newUser, { merge: true });
        return newUser;
    }

    return {
        ...defaultSharedUser(user.email),
        ...userSnap.data(),
        email: user.email
    };
}

async function loadMemberships(uid) {
    const membershipSnap = await getDocs(collection(db, 'users', uid, 'memberships'));
    const memberships = {};
    membershipSnap.forEach(item => {
        memberships[item.id] = {
            ...defaultMembership(item.id),
            ...item.data(),
            app_id: item.id
        };
    });
    return memberships;
}

function bindAuthForms() {
    byId('show-register-link').addEventListener('click', event => {
        event.preventDefault();
        byId('login-form').classList.add('hidden');
        byId('register-form').classList.remove('hidden');
    });

    byId('show-login-link').addEventListener('click', event => {
        event.preventDefault();
        byId('register-form').classList.add('hidden');
        byId('login-form').classList.remove('hidden');
    });

    byId('login-form').addEventListener('submit', async event => {
        event.preventDefault();
        try {
            await signInWithEmailAndPassword(auth, byId('login-email').value, byId('login-pass').value);
        } catch (error) {
            showToast(error.message, 'error');
        }
    });

    byId('register-form').addEventListener('submit', async event => {
        event.preventDefault();
        const email = byId('reg-email').value.trim();
        const password = byId('reg-pass').value;
        try {
            await createUserWithEmailAndPassword(auth, email, password);
        } catch (error) {
            showToast(error.message, 'error');
        }
    });

    byId('forgot-password-link').addEventListener('click', async event => {
        event.preventDefault();
        const email = byId('login-email').value.trim();
        if (!email) {
            showToast('Enter your email address above first', 'error');
            return;
        }
        try {
            await sendPasswordResetEmail(auth, email);
            showToast('Password reset email sent — check your inbox');
        } catch (error) {
            showToast(error.message || 'Failed to send reset email', 'error');
        }
    });
}

function renderInviteCodePrompt() {
    const codeInput = byId('activate-code');
    if (codeInput) codeInput.value = '';
}

async function selfActivateApp(appId, inviteCode) {
    const uid = state.authUser.uid;
    const membershipRef = doc(db, 'users', uid, 'memberships', appId);
    await setDoc(membershipRef, {
        ...defaultMembership(appId, inviteCode),
        app_id: appId
    }, { merge: true });
    if (appId === APP_IDS.STRONG8K) {
        await setDoc(doc(db, 'strong8k_profiles', uid), normalizeStrong8kProfile({}, {}), { merge: true });
    }
}

function bindNoAccessEvents() {
    const form = byId('activate-form');
    if (!form) return;
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const code = byId('activate-code').value.trim();
        const appId = resolveInviteCode(code);
        if (!appId) {
            showToast('Invalid invite code', 'error');
            return;
        }
        const submitBtn = byId('activate-submit-btn');
        try {
            submitBtn.disabled = true;
            await selfActivateApp(appId, code.toUpperCase());
            await hydrateSession(state.authUser);
            await routeAuthenticatedUser();
            showToast(`${APP_DEFINITIONS[appId].shortLabel} access activated!`);
        } catch (error) {
            showToast(error.message, 'error');
        } finally {
            submitBtn.disabled = false;
        }
    });
}

async function claimOrCreateAccount({ uid, email, appId, inviteCode }) {
    let existingDoc = null;
    try {
        const q = query(collection(db, 'users'), where('email', '==', email));
        const results = await getDocs(q);
        existingDoc = results.docs.find(item => item.id !== uid) || null;
    } catch (error) {
        console.warn('Legacy account lookup skipped during registration bootstrap.', error);
    }

    if (existingDoc) {
        await migrateLegacyAccount({
            oldUserId: existingDoc.id,
            newUserId: uid,
            email,
            appId,
            inviteCode
        });
        return;
    }

    const userRef = doc(db, 'users', uid);
    const membershipRef = doc(db, 'users', uid, 'memberships', appId);
    await setDoc(userRef, {
        ...defaultSharedUser(email),
        email,
        default_app_id: appId
    }, { merge: true });

    await setDoc(membershipRef, {
        ...defaultMembership(appId, inviteCode),
        app_id: appId
    }, { merge: true });

    if (appId === APP_IDS.STRONG8K) {
        await setDoc(doc(db, 'strong8k_profiles', uid), normalizeStrong8kProfile({}, {}), { merge: true });
        return;
    }

    if (appId === APP_IDS.PLAYOFF) {
        await ensurePlayoffSelfServeAccess(uid, email);
    }
}

async function migrateLegacyAccount({ oldUserId, newUserId, email, appId, inviteCode }) {
    await runTransaction(db, async transaction => {
        const oldUserRef = doc(db, 'users', oldUserId);
        const newUserRef = doc(db, 'users', newUserId);
        const oldUserSnap = await transaction.get(oldUserRef);
        const newUserSnap = await transaction.get(newUserRef);

        const oldUserData = oldUserSnap.exists() ? oldUserSnap.data() : {};
        const newUserData = newUserSnap.exists() ? newUserSnap.data() : {};

        transaction.set(newUserRef, {
            ...defaultSharedUser(email),
            ...oldUserData,
            ...newUserData,
            email,
            default_app_id: oldUserData.default_app_id || appId
        }, { merge: true });
    });

    const oldMembershipSnap = await getDocs(collection(db, 'users', oldUserId, 'memberships'));
    for (const membershipDoc of oldMembershipSnap.docs) {
        await setDoc(doc(db, 'users', newUserId, 'memberships', membershipDoc.id), {
            ...membershipDoc.data(),
            app_id: membershipDoc.id,
            invite_code_used: membershipDoc.data().invite_code_used || CONFIG.INVITE_CODES[membershipDoc.id] || inviteCode
        }, { merge: true });
    }

    await setDoc(doc(db, 'users', newUserId, 'memberships', appId), {
        ...defaultMembership(appId, inviteCode),
        app_id: appId
    }, { merge: true });

    const oldProfileRef = doc(db, 'strong8k_profiles', oldUserId);
    const oldProfileSnap = await getDoc(oldProfileRef);
    if (oldProfileSnap.exists()) {
        await setDoc(doc(db, 'strong8k_profiles', newUserId), oldProfileSnap.data(), { merge: true });
    } else {
        const oldUserSnap = await getDoc(doc(db, 'users', oldUserId));
        if (oldUserSnap.exists()) {
            await setDoc(
                doc(db, 'strong8k_profiles', newUserId),
                normalizeStrong8kProfile({}, oldUserSnap.data()),
                { merge: true }
            );
        }
    }

    if (appId === APP_IDS.PLAYOFF) {
        await ensurePlayoffSelfServeAccess(newUserId, email);
    }
}

function bindSharedActions() {
    byId('switcher-signout-btn').addEventListener('click', () => signOut(auth));
    byId('no-access-signout-btn').addEventListener('click', () => signOut(auth));

    document.querySelectorAll('[data-action="app-home"]').forEach(button => {
        button.addEventListener('click', async () => {
            window.location.hash = '#/apps';
            try {
                await routeAuthenticatedUser();
            } catch (error) {
                handlePortalLoadError(error);
            }
        });
    });

    document.querySelectorAll('[data-action="signout"]').forEach(button => {
        button.addEventListener('click', () => signOut(auth));
    });
}

function renderAppSwitcher(activeMemberships) {
    const container = byId('app-switcher-cards');
    container.innerHTML = '';

    Object.keys(activeMemberships).forEach(appId => {
        const app = APP_DEFINITIONS[appId];
        const button = document.createElement('button');
        button.className = 'group rounded-3xl border border-slate-200 bg-white p-6 text-left shadow-sm transition hover:-translate-y-1 hover:border-slate-900 hover:shadow-xl';
        button.innerHTML = `
            <div class="mb-4 flex items-center justify-between">
                <span class="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.25em] text-slate-600">${app.shortLabel}</span>
                <i class="fa-solid fa-arrow-right text-slate-300 transition group-hover:text-slate-900"></i>
            </div>
            <h3 class="text-2xl font-bold text-slate-950">${app.authTitle}</h3>
            <p class="mt-3 text-sm leading-6 text-slate-500">${app.authDescription}</p>
        `;
        button.addEventListener('click', async () => {
            window.location.hash = app.route;
            try {
                await openApp(appId);
            } catch (error) {
                handlePortalLoadError(error);
            }
        });
        container.appendChild(button);
    });

}

async function loadStrong8kApp() {
    const user = state.authUser;
    const sharedUser = state.sharedUser || {};
    const profileSnap = await getDoc(doc(db, 'strong8k_profiles', user.uid));
    const profile = normalizeStrong8kProfile(profileSnap.exists() ? profileSnap.data() : {}, sharedUser);

    let contentOptions = { live_list: [], vod_list: [] };
    const configSnap = await getDoc(doc(db, 'strong8k_config', 'content_options'));
    if (configSnap.exists()) {
        contentOptions = configSnap.data();
    } else {
        const legacyConfigSnap = await getDoc(doc(db, 'app_config', 'content_options'));
        if (legacyConfigSnap.exists()) {
            contentOptions = legacyConfigSnap.data();
        }
    }

    const products = [];
    const productsSnap = await getDocs(collection(db, 'strong8k_products'));
    if (!productsSnap.empty) {
        productsSnap.forEach(item => products.push({ id: item.id, ...item.data() }));
    } else {
        const legacyProductsSnap = await getDocs(collection(db, 'products'));
        legacyProductsSnap.forEach(item => products.push({ id: item.id, ...item.data() }));
    }

    const hasEPGenius = profile.licenses.some(license => license.epgenius_url && String(license.epgenius_url).trim() !== '');
    const resolvedProducts = sortByPrice(products);
    if (hasEPGenius) {
        resolvedProducts.push({ id: 'donation_epgenius', name: 'Donate to EPGenius Curator', price: 20 });
    }

    state.strong8k.profile = profile;
    state.strong8k.products = resolvedProducts;
    state.strong8k.contentOptions = contentOptions;
    renderStrong8k();
}

function renderStrong8k() {
    const { profile, products, contentOptions } = state.strong8k;
    if (!profile) return;

    byId('strong8k-user-name').textContent = state.sharedUser.full_name || 'Client';
    byId('strong8k-user-email').textContent = state.authUser.email;
    byId('contact-link').href = CONFIG.CONTACT_LINK;

    renderStrong8kLicenses(profile);
    renderStrong8kProducts(products);
    renderStrong8kPreferenceTags('live', profile.live_preferences || [], contentOptions.live_list || []);
    renderStrong8kPreferenceTags('vod', profile.vod_preferences || [], contentOptions.vod_list || []);
    byId('custom-req').value = profile.custom_request || '';
    byId('setup-notes').value = getSetupNotesValue(profile);
}

function renderStrong8kLicenses(profile) {
    const container = byId('licenses-container');
    container.innerHTML = '';

    const licenses = profile.licenses || [];
    if (!licenses.length) {
        container.innerHTML = `
            <div class="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-400">
                No active licenses found yet.
            </div>
        `;
        return;
    }

    licenses.forEach(license => {
        const card = document.createElement('article');
        const status = license.status || 'Unknown';
        const statusClass = status === 'Active'
            ? 'bg-emerald-100 text-emerald-700'
            : status === 'Expired'
                ? 'bg-rose-100 text-rose-700'
                : 'bg-slate-100 text-slate-500';
        const domain = profile.domain_8k || 'Contact Admin';
        const backup = profile.domain_8k_backup || '';
        card.className = 'rounded-3xl border border-slate-200 bg-white p-6 shadow-sm';
        card.innerHTML = `
            <div class="mb-5 flex items-start justify-between gap-4">
                <div>
                    <h3 class="text-lg font-bold text-slate-950">${license.label || 'License'}</h3>
                    <p class="mt-1 text-xs uppercase tracking-[0.25em] text-slate-400">Expiry ${formatDate(license.expiry_date)}</p>
                </div>
                <span class="rounded-full px-3 py-1 text-[11px] font-bold uppercase ${statusClass}">${status}</span>
            </div>
            <div class="grid gap-4 rounded-2xl bg-slate-50 p-4">
                <div class="grid gap-3 md:grid-cols-2">
                    ${copyField('Primary Domain', domain)}
                    ${backup ? copyField('Backup Domain', backup) : ''}
                </div>
                <div class="grid gap-3 md:grid-cols-2">
                    ${copyField('Username', license.username_8k)}
                    ${copyField('Password', license.password_8k)}
                </div>
                ${license.m3u_url_8k ? copyBlock('8K M3U URL', license.m3u_url_8k) : ''}
                ${license.epg_url_8k ? copyBlock('8K EPG URL', license.epg_url_8k) : ''}
                ${license.epgenius_url ? copyBlock('EPGenius Playlist URL', license.epgenius_url, 'border-blue-100') : ''}
            </div>
        `;
        container.appendChild(card);
    });

    container.querySelectorAll('[data-copy]').forEach(button => {
        button.addEventListener('click', async () => {
            await navigator.clipboard.writeText(button.dataset.copy || '');
            showToast('Copied to clipboard');
        });
    });
}

function copyField(label, value) {
    return `
        <div>
            <label class="mb-1 block text-[11px] font-bold uppercase tracking-[0.22em] text-slate-400">${label}</label>
            <button type="button" class="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-3 py-2 text-left text-sm font-mono text-slate-700 hover:border-slate-900" data-copy="${escapeAttribute(value || '')}">
                <span class="truncate">${value || 'N/A'}</span>
                <i class="fa-regular fa-copy text-xs text-slate-300"></i>
            </button>
        </div>
    `;
}

function copyBlock(label, value, extraBorderClass = '') {
    return `
        <div>
            <label class="mb-1 block text-[11px] font-bold uppercase tracking-[0.22em] text-slate-400">${label}</label>
            <button type="button" class="flex w-full items-center justify-between rounded-2xl border ${extraBorderClass || 'border-slate-200'} bg-white px-3 py-2 text-left text-xs font-mono text-slate-600 hover:border-slate-900" data-copy="${escapeAttribute(value || '')}">
                <span class="truncate">${value}</span>
                <i class="fa-regular fa-copy text-xs text-slate-300"></i>
            </button>
        </div>
    `;
}

function renderStrong8kProducts(products) {
    const list = byId('product-list');
    list.innerHTML = '';

    products.forEach(product => {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-4 border-b border-slate-100 py-4 last:border-b-0';
        row.innerHTML = `
            <div>
                <h4 class="text-sm font-bold text-slate-950">${product.name}</h4>
                <p class="mt-1 text-xs font-bold text-slate-500">${CONFIG.CURRENCY_SYMBOL}${product.price}</p>
            </div>
            <button type="button" class="rounded-full bg-slate-100 px-4 py-2 text-xs font-bold text-slate-900 transition hover:bg-slate-900 hover:text-white" data-product-name="${escapeAttribute(product.name)}" data-product-price="${product.price}">
                Purchase
            </button>
        `;
        list.appendChild(row);
    });

    list.querySelectorAll('[data-product-name]').forEach(button => {
        button.addEventListener('click', () => {
            openPurchaseModal(button.dataset.productName, button.dataset.productPrice);
        });
    });
}

function renderStrong8kPreferenceTags(type, selectedValues, allOptions) {
    const container = byId(type === 'live' ? 'live-tags' : 'vod-tags');
    const select = byId(type === 'live' ? 'live-pref-select' : 'vod-pref-select');
    container.innerHTML = '';

    selectedValues.forEach(value => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'rounded-full bg-slate-900 px-3 py-1 text-[11px] font-bold text-white transition hover:bg-rose-600';
        chip.textContent = value;
        chip.addEventListener('click', () => toggleStrong8kPreference(type, value));
        container.appendChild(chip);
    });

    select.innerHTML = '<option value="">+ Add...</option>';
    allOptions.forEach(option => {
        if (selectedValues.includes(option)) return;
        const opt = document.createElement('option');
        opt.value = option;
        opt.textContent = option;
        select.appendChild(opt);
    });
}

function bindStrong8kEvents() {
    byId('live-pref-select').addEventListener('change', event => {
        if (event.target.value) toggleStrong8kPreference('live', event.target.value);
        event.target.value = '';
    });
    byId('vod-pref-select').addEventListener('change', event => {
        if (event.target.value) toggleStrong8kPreference('vod', event.target.value);
        event.target.value = '';
    });
    byId('save-config-btn').addEventListener('click', saveStrong8kProfile);
    byId('purchase-close-btn').addEventListener('click', () => byId('purchase-modal').classList.add('hidden'));
}

function toggleStrong8kPreference(type, value) {
    const field = type === 'live' ? 'live_preferences' : 'vod_preferences';
    const current = state.strong8k.profile[field] || [];
    state.strong8k.profile[field] = current.includes(value)
        ? current.filter(item => item !== value)
        : [...current, value];
    renderStrong8k();
}

async function saveStrong8kProfile() {
    const profileRef = doc(db, 'strong8k_profiles', state.authUser.uid);
    state.strong8k.profile.custom_request = byId('custom-req').value;
    state.strong8k.profile.setup_notes = byId('setup-notes').value;

    await setDoc(profileRef, {
        ...state.strong8k.profile,
        updated_at: new Date().toISOString()
    }, { merge: true });

    showToast('Strong8K preferences saved');
}

function openPurchaseModal(name, price) {
    byId('modal-product-name').textContent = name;
    byId('modal-product-price').textContent = `${CONFIG.CURRENCY_SYMBOL}${price}`;
    const subject = encodeURIComponent(`Payment Sent: ${name} (${state.authUser.email})`);
    const body = encodeURIComponent(`Hi Elliot,\n\nI have sent an e-transfer of $${price} for the ${name} package.\n\nAccount Email: ${state.authUser.email}\n\nThanks!`);
    byId('notify-link').href = `mailto:${CONFIG.PAYMENT_EMAIL}?subject=${subject}&body=${body}`;
    byId('purchase-modal').classList.remove('hidden');
}

async function loadPlayoffApp() {
    const membership = state.accessibleApps[APP_IDS.PLAYOFF];
    state.playoff.membership = membership;
    const pool = await resolvePlayoffPool(membership);
    if (!pool) {
        state.playoff.pool = null;
        renderPlayoffApp();
        return;
    }

    const poolId = pool.id;
    const roundsSnap = await getDocs(query(collection(db, 'playoff_pools', poolId, 'rounds'), orderBy('sort_order')));
    const rounds = roundsSnap.docs.map(item => normalizePlayoffRound({ id: item.id, ...item.data() }));
    const currentRound = pickCurrentRound(rounds);
    const currentRoundId = currentRound?.id || '';
    const series = currentRoundId
        ? (await getDocs(query(collection(db, 'playoff_pools', poolId, 'rounds', currentRoundId, 'series'), orderBy('sort_order'))))
            .docs
            .map(item => normalizePlayoffSeries({ id: item.id, ...item.data() }))
        : [];
    let memberSnap = await getDoc(doc(db, 'playoff_pools', poolId, 'members', state.authUser.uid));
    let paymentSnap = await getDoc(doc(db, 'playoff_pools', poolId, 'payments', state.authUser.uid));

    if (!memberSnap.exists() || !paymentSnap.exists()) {
        await ensurePlayoffSelfServeAccess(state.authUser.uid, state.authUser.email);
        memberSnap = await getDoc(doc(db, 'playoff_pools', poolId, 'members', state.authUser.uid));
        paymentSnap = await getDoc(doc(db, 'playoff_pools', poolId, 'payments', state.authUser.uid));
    }

    const rawMember = memberSnap.exists() ? { id: memberSnap.id, ...memberSnap.data() } : null;
    const member = normalizePlayoffMember(rawMember || {
        uid: state.authUser.uid,
        display_name: state.sharedUser.full_name,
        email: state.authUser.email
    }, pool);

    const payment = normalizePaymentRecord(paymentSnap.exists() ? paymentSnap.data() : {}, member, pool);

    const currentPickSnap = currentRoundId
        ? await getDoc(doc(db, 'playoff_pools', poolId, 'rounds', currentRoundId, 'picks', state.authUser.uid))
        : null;
    const currentPick = currentPickSnap?.exists()
        ? scorePickDocument(normalizePickDoc(currentPickSnap.data()), series, currentRound)
        : null;

    const standingsSnap = await getDocs(collection(db, 'playoff_pools', poolId, 'members'));
    const standings = sortStandings(standingsSnap.docs.map(item => normalizePlayoffMember({ id: item.id, ...item.data() }, pool)));
    const collectedPot = computeCollectedPot([], standings);
    const payoutSummary = mergeFinalizedPayouts(
        pool.suggested_payouts?.length ? pool.suggested_payouts : suggestPayouts({
            collectedPot,
            participantCount: standings.length,
            template: pool.payout_template
        }),
        pool.finalized_payouts
    );

    // Load ALL rounds' series and pick docs for multi-round scoreboard history
    const historySeriesMap = {};   // { [roundId]: series[] }
    const historyPickDocsMap = {}; // { [roundId]: pickDoc[] }
    const previousPicks = [];

    for (const round of rounds) {
        const isCurrentRound = round.id === currentRoundId;
        // Use already-loaded series for current round; fetch for others
        const roundSeries = isCurrentRound ? series : await (async () => {
            const snap = await getDocs(query(collection(db, 'playoff_pools', poolId, 'rounds', round.id, 'series'), orderBy('sort_order')));
            return snap.docs.map(item => normalizePlayoffSeries({ id: item.id, ...item.data() }));
        })();
        historySeriesMap[round.id] = roundSeries;

        // Collection reads (all members' picks) are only safe when the round is revealed —
        // Firestore rules allow users to read their own pick doc but block collection reads
        // for unrevealed rounds. Fall back to a single-doc fetch for the current user only.
        if (isRoundRevealed(round, pool)) {
            const roundPicksSnap = await getDocs(collection(db, 'playoff_pools', poolId, 'rounds', round.id, 'picks'));
            historyPickDocsMap[round.id] = roundPicksSnap.docs.map(item => normalizePickDoc({ id: item.id, ...item.data() }));
        } else {
            // Unrevealed: only fetch the signed-in user's own pick (permitted by rules)
            const userPickSnap = await getDoc(doc(db, 'playoff_pools', poolId, 'rounds', round.id, 'picks', state.authUser.uid));
            historyPickDocsMap[round.id] = userPickSnap.exists()
                ? [normalizePickDoc({ id: userPickSnap.id, ...userPickSnap.data() })]
                : [];
        }

        // Build previousPicks for the current user's prior round picks display
        if (!isCurrentRound) {
            const userPickDoc = historyPickDocsMap[round.id].find(d => d.id === state.authUser.uid);
            if (userPickDoc) {
                previousPicks.push({
                    round,
                    series: roundSeries,
                    pick: scorePickDocument(userPickDoc, roundSeries, round)
                });
            }
        }
    }

    const roundPickDocs = historyPickDocsMap[currentRoundId] || [];

    const preservedScenarioDraft = state.playoff.poolId === poolId && state.playoff.currentRound?.id === currentRoundId
        ? state.playoff.scenarioDraft
        : {};
    const preservedTeamNameDraft = state.playoff.poolId === poolId
        ? state.playoff.teamNameDraft
        : '';

    state.playoff.poolId = poolId;
    state.playoff.pool = pool;
    state.playoff.member = member;
    state.playoff.payment = payment;
    state.playoff.rounds = rounds;
    state.playoff.currentRound = currentRound;
    state.playoff.series = series;
    state.playoff.currentPick = currentPick;
    state.playoff.previousPicks = previousPicks;
    state.playoff.standings = standings;
    state.playoff.roundPickDocs = roundPickDocs;
    state.playoff.historySeriesMap = historySeriesMap;
    state.playoff.historyPickDocsMap = historyPickDocsMap;
    state.playoff.payoutSummary = payoutSummary;
    state.playoff.pickDistribution = buildPickDistribution(series, roundPickDocs);
    state.playoff.standingsTrend = buildStandingsTrend(rounds, standings);
    state.playoff.eventHistory = buildAllEventSnapshots(historySeriesMap, historyPickDocsMap, rounds, standings);
    state.playoff.timelineIndex = Math.max(0, state.playoff.eventHistory.length - 1);
    state.playoff.teamNameDraft = preservedTeamNameDraft || member.team_name || '';
    state.playoff.draft = buildDraftFromEntries(currentPick?.entries || []);
    state.playoff.scenarioDraft = buildScenarioDraft(series, preservedScenarioDraft);
    state.playoff.isLocked = isRoundLocked(currentRound);
    renderPlayoffApp();
}

async function findSelfServePlayoffPool() {
    const activePoolSnap = await getDocs(query(collection(db, 'playoff_pools'), where('status', '==', 'active')));
    const pools = activePoolSnap.docs
        .map(item => normalizePlayoffPool({ id: item.id, ...item.data() }))
        .sort((left, right) => (left.season_label || left.name || left.id).localeCompare(right.season_label || right.name || right.id));

    return pools[0] || null;
}

async function resolvePlayoffPool(membership) {
    const activePool = await findSelfServePlayoffPool();
    if (activePool) {
        return activePool;
    }

    const legacyPoolId = Array.isArray(membership?.pool_ids) ? membership.pool_ids.find(Boolean) : '';
    if (!legacyPoolId) {
        return null;
    }

    const legacyPoolSnap = await getDoc(doc(db, 'playoff_pools', legacyPoolId));
    if (!legacyPoolSnap.exists()) {
        return null;
    }

    return normalizePlayoffPool({ id: legacyPoolId, ...legacyPoolSnap.data() });
}

async function ensurePlayoffSelfServeAccess(uid, email) {
    const pool = await findSelfServePlayoffPool();
    if (!pool) {
        throw new Error('No active playoff pool is available for self-registration yet.');
    }

    const membershipRef = doc(db, 'users', uid, 'memberships', APP_IDS.PLAYOFF);
    const membershipSnap = await getDoc(membershipRef);
    const existingMembership = membershipSnap.exists()
        ? { ...defaultMembership(APP_IDS.PLAYOFF), ...membershipSnap.data() }
        : defaultMembership(APP_IDS.PLAYOFF, 'self-serve');
    const nextPoolIds = Array.from(new Set([...(existingMembership.pool_ids || []), pool.id]));

    await setDoc(doc(db, 'users', uid), {
        email,
        default_app_id: APP_IDS.PLAYOFF
    }, { merge: true });

    await setDoc(membershipRef, {
        ...existingMembership,
        app_id: APP_IDS.PLAYOFF,
        role: existingMembership.role || 'member',
        status: existingMembership.status === 'disabled' ? 'disabled' : 'active',
        invite_code_used: existingMembership.invite_code_used || 'self-serve',
        pool_ids: nextPoolIds
    }, { merge: true });

    if ((existingMembership.status || '') === 'disabled') {
        throw new Error('This playoff account is disabled. Contact Elliot to restore access.');
    }

    const sharedUser = state.sharedUser || defaultSharedUser(email);
    const memberRef = doc(db, 'playoff_pools', pool.id, 'members', uid);
    await setDoc(memberRef, {
        uid,
        email,
        display_name: sharedUser.full_name || email.split('@')[0] || 'Pool Member',
        amount_due: Number(pool.entry_fee_default ?? 0) || 0
    }, { merge: true });

    const paymentRef = doc(db, 'playoff_pools', pool.id, 'payments', uid);
    await setDoc(paymentRef, {
        member_uid: uid,
        amount_due: Number(pool.entry_fee_default ?? 0) || 0
    }, { merge: true });
}

function renderPlayoffApp() {
    byId('playoff-user-name').textContent = state.sharedUser.full_name || 'Pool Member';
    byId('playoff-user-email').textContent = state.authUser.email;
    byId('playoff-brand-name').textContent = CONFIG.PLAYOFF_BRAND_NAME;

    if (!state.playoff.pool) {
        const emptyState = byId('playoff-empty-state');
        const emptyMessage = emptyState.querySelector('p:last-of-type');
        byId('playoff-empty-state').classList.remove('hidden');
        byId('playoff-main-state').classList.add('hidden');
        if (emptyMessage) {
            emptyMessage.textContent = 'Once the live pool is seeded and marked active, this page will automatically add you in and open your picks, payment instructions, and standings.';
        }
        return;
    }

    byId('playoff-empty-state').classList.add('hidden');
    byId('playoff-main-state').classList.remove('hidden');

    byId('pool-name').textContent = state.playoff.pool.name || CONFIG.PLAYOFF_BRAND_NAME;
    byId('pool-season').textContent = state.playoff.pool.season_label || 'Current Season';
    byId('pool-member-count').textContent = `${state.playoff.standings.length} members`;
    byId('pool-description').textContent = 'Round-by-round NHL playoff picks.';
    byId('current-round-name').textContent = state.playoff.currentRound?.name || 'No round configured';
    byId('current-round-deadline').textContent = state.playoff.currentRound?.lock_at
        ? `Lock ${formatDateTime(state.playoff.currentRound.lock_at)}`
        : state.playoff.currentRound?.pick_deadline
            ? `Deadline ${formatDateTime(state.playoff.currentRound.pick_deadline)}`
            : 'Deadline not set';
    byId('playoff-points-total').textContent = String(state.playoff.member?.points_total || 0);
    byId('playoff-round-points').textContent = String(state.playoff.member?.round_points || 0);
    byId('playoff-team-name').textContent = state.playoff.member?.team_name || 'Not set yet';
    byId('playoff-payment-status').textContent = prettifyStatus(state.playoff.payment?.status || state.playoff.member?.payment_status || 'unpaid');
    byId('playoff-amount-paid').textContent = `${formatCurrency(state.playoff.payment?.amount_paid || state.playoff.member?.amount_paid || 0)} / ${formatCurrency(state.playoff.payment?.amount_due || state.playoff.member?.amount_due || 0)}`;
    byId('playoff-payout-status').textContent = buildPayoutStatusText();
    byId('playoff-rank-summary').textContent = buildCurrentRankSummary();
    byId('playoff-rules-content').innerHTML = buildPoolRulesMarkup();
    byId('playoff-payment-instructions').textContent = buildPaymentInstructions();
    byId('playoff-payment-link').href = buildPlayoffPaymentLink();

    renderIPTVUpsellBanner();
    renderTeamNameEditor();
    renderSeriesCards();
    renderStandingsHistory();
    renderPayoutSummary();
    renderStandingsTrend();
    renderPickDistribution();
    renderPreviousPicks();
    renderScenarioLab();
    renderPicksBoard();
    initSectionVisibility();
    renderSidebar();
    applyVisibleSections();
}

function renderSeriesCards() {
    const container = byId('series-container');
    const submitButton = byId('playoff-submit-btn');
    const roundMessage = byId('playoff-round-message');
    const roundSummary = byId('playoff-current-summary');
    container.innerHTML = '';
    roundSummary.innerHTML = '';

    if (!state.playoff.currentRound || !state.playoff.series.length) {
        container.innerHTML = `
            <div class="rounded-3xl border border-dashed border-white/20 bg-white/5 p-6 text-sm text-slate-300">
                No series have been posted for this round yet.
            </div>
        `;
        submitButton.disabled = true;
        roundMessage.textContent = 'No active round is ready for picks.';
        roundSummary.textContent = '';
        return;
    }

    const conferenceGroups = groupSeriesByConference(state.playoff.series);
    container.innerHTML = conferenceGroups.map(group => `
        <section class="rounded-[2rem] border border-white/10 bg-gradient-to-br from-white/8 to-white/4 p-5 shadow-[0_24px_60px_rgba(2,6,23,0.18)]">
            <div class="mb-5 flex items-end justify-between gap-4">
                <div>
                    <p class="text-xs font-bold uppercase tracking-[0.3em] text-emerald-300">${escapeHtml(group.title)}</p>
                    <h3 class="mt-2 text-2xl font-black text-white">${group.series.length} matchups</h3>
                </div>
                <p class="text-xs uppercase tracking-[0.22em] text-slate-400">Logo pick + exact length</p>
            </div>
            <div class="space-y-4">
                ${group.series.map(series => {
                    const saved = state.playoff.draft[series.id] || {};
                    const savedEntry = state.playoff.currentPick?.entries?.find(entry => entry.series_id === series.id) || null;
                    const winnerChoice = saved.winner_team_id || '';
                    const thisSeriesLocked = state.playoff.isLocked || isSeriesLocked(series);
                    const statusLabel = thisSeriesLocked ? 'Locked' : (series.status || 'Open');
                    const statusBadgeClass = thisSeriesLocked ? 'bg-rose-500/10 text-rose-300' : 'bg-white/10 text-slate-200';
                    return `
                        <article class="rounded-[1.75rem] border border-white/10 bg-slate-950/35 p-5" data-series-locked="${thisSeriesLocked}">
                            <div class="mb-4 flex items-start justify-between gap-4">
                                <div>
                                    <p class="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-400">${escapeHtml(series.matchup_label || `Series ${series.sort_order || ''}`)}</p>
                                    <h4 class="mt-2 text-xl font-black text-white">${escapeHtml((series.home_team_name || series.home_team_id) + ' vs ' + (series.away_team_name || series.away_team_id))}</h4>
                                </div>
                                <span class="rounded-full px-3 py-1 text-[11px] font-bold uppercase ${statusBadgeClass}">${escapeHtml(statusLabel)}</span>
                            </div>
                            <div class="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
                                <div>
                                    <span class="mb-3 block text-[11px] font-bold uppercase tracking-[0.22em] text-slate-300">Pick The Winner</span>
                                    <div class="grid gap-3 sm:grid-cols-2">
                                        ${buildPickTeamOptionMarkup(series, 'home', winnerChoice, 'live')}
                                        ${buildPickTeamOptionMarkup(series, 'away', winnerChoice, 'live')}
                                    </div>
                                </div>
                                <div>
                                    <span class="mb-3 block text-[11px] font-bold uppercase tracking-[0.22em] text-slate-300"># Games - Exact Length</span>
                                    <div class="grid grid-cols-4 gap-2">
                                        ${buildGamesOptionGroupMarkup(series.id, saved.games, 'live')}
                                    </div>
                                </div>
                            </div>
                            ${savedEntry ? `
                                <div class="mt-4 rounded-2xl bg-slate-950/50 px-4 py-3 text-xs text-slate-300">
                                    <div class="flex flex-wrap items-center justify-between gap-3">
                                        <span>Winner pts: ${savedEntry.winner_points_awarded || 0}</span>
                                        <span>Games pts: ${savedEntry.games_points_awarded || 0}</span>
                                        <span>Total: ${savedEntry.series_points_total || 0}</span>
                                    </div>
                                    ${savedEntry.eligibility_reason ? `<p class="mt-2 text-[11px] uppercase tracking-[0.2em] text-amber-300">Override: ${escapeHtml(savedEntry.eligibility_reason)}</p>` : ''}
                                </div>
                            ` : ''}
                        </article>
                    `;
                }).join('')}
            </div>
        </section>
    `).join('');

    container.querySelectorAll('.pick-team-option').forEach(button => {
        const article = button.closest('article[data-series-locked]');
        button.disabled = article ? article.dataset.seriesLocked === 'true' : state.playoff.isLocked;
        button.addEventListener('click', event => updatePlayoffDraft(event.currentTarget.dataset.seriesId, 'winner_team_id', event.currentTarget.dataset.teamId));
    });
    container.querySelectorAll('.pick-games-option').forEach(button => {
        const article = button.closest('article[data-series-locked]');
        button.disabled = article ? article.dataset.seriesLocked === 'true' : state.playoff.isLocked;
        button.addEventListener('click', event => updatePlayoffDraft(event.currentTarget.dataset.seriesId, 'games', event.currentTarget.dataset.games));
    });

    submitButton.disabled = state.playoff.isLocked || !hasReadyTeamNameForPicks();
    const someSeriesLocked = !state.playoff.isLocked && (state.playoff.series || []).some(isSeriesLocked);
    const roundIsAdminComplete = ['complete', 'completed'].includes(String(state.playoff.currentRound?.status || '').toLowerCase());
    roundMessage.textContent = state.playoff.isLocked
        ? (roundIsAdminComplete ? 'This round is complete. Final picks are shown below.' : 'Picks are locked for this round. Results are still being decided.')
        : someSeriesLocked
            ? 'Some series have locked (game already started). Save your remaining picks before their deadlines.'
            : hasReadyTeamNameForPicks()
                ? 'Click a team logo, choose the exact series length, and save before the deadline.'
                : 'Save your team name first, then lock in your series picks.';
    roundSummary.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-4">
            <div>
                <p class="text-xs font-bold uppercase tracking-[0.22em] text-slate-400">Scoring</p>
                <p class="mt-2 text-sm text-slate-200">Winner = ${state.playoff.currentRound.winner_points} points, exact games = ${state.playoff.currentRound.games_points} points.</p>
            </div>
            <div class="text-right">
                <p class="text-xs font-bold uppercase tracking-[0.22em] text-slate-400">Visibility</p>
                <p class="mt-2 text-sm text-slate-200">${isRoundRevealed(state.playoff.currentRound, state.playoff.pool) ? 'Picks are revealed for this round.' : 'All picks stay hidden until the round locks.'}</p>
            </div>
        </div>
    `;
}

function renderTeamNameEditor() {
    const input = byId('playoff-team-name-input');
    const button = byId('playoff-team-name-save-btn');
    const helper = byId('playoff-team-name-helper');
    const locked = isTeamNameLockedForMember();
    const savedTeamName = state.playoff.member?.team_name || '';
    if (locked && normalizeTeamNameValue(state.playoff.teamNameDraft) !== normalizeTeamNameValue(savedTeamName)) {
        state.playoff.teamNameDraft = savedTeamName;
    }
    const draftTeamName = state.playoff.teamNameDraft || '';

    input.value = draftTeamName;
    input.disabled = locked;
    button.classList.toggle('hidden', locked);
    button.disabled = locked || !normalizeTeamNameValue(draftTeamName) || !isTeamNameDirty();

    if (locked) {
        helper.textContent = savedTeamName
            ? 'Round 1 is locked, so your saved team name is now read-only for the rest of the pool.'
            : 'Round 1 is locked. Team name changes are no longer available from the portal.';
        return;
    }

    if (!savedTeamName) {
        helper.textContent = 'Set your scoreboard name first. You can change it as often as you want until Round 1 locks.';
        return;
    }

    helper.textContent = isTeamNameDirty()
        ? 'You have an unsaved team-name change. Save it before saving your picks.'
        : 'This is the name everyone sees on the scoreboard. You can keep changing it until Round 1 locks.';
}

function groupSeriesByConference(seriesList = []) {
    const desiredOrder = ['Eastern Conference', 'Western Conference'];
    const grouped = desiredOrder.map(title => ({
        title,
        series: seriesList.filter(series => series.conference === title)
    })).filter(group => group.series.length);

    const extras = [];
    const seen = new Set(desiredOrder);
    seriesList.forEach(series => {
        const conference = series.conference || 'Other Matchups';
        if (seen.has(conference)) {
            return;
        }

        const existing = extras.find(item => item.title === conference);
        if (existing) {
            existing.series.push(series);
            return;
        }

        extras.push({ title: conference, series: [series] });
    });

    return [...grouped, ...extras];
}

function buildPickTeamOptionMarkup(series, side, selectedTeamId, mode = 'live') {
    const isHome = side === 'home';
    const teamId = isHome ? (series.home_team_id || series.home_team_name) : (series.away_team_id || series.away_team_name);
    const teamName = isHome ? (series.home_team_name || series.home_team_id) : (series.away_team_name || series.away_team_id);
    const seedLabel = isHome ? series.home_team_seed_label : series.away_team_seed_label;
    const primaryColor = isHome ? (series.home_team_primary_color || '#0F172A') : (series.away_team_primary_color || '#0F172A');
    const useDarkLogo = isLightColor(primaryColor);
    const logoUrl = isHome
        ? (useDarkLogo ? (series.home_team_logo_dark || series.home_team_logo_light || '') : (series.home_team_logo_light || series.home_team_logo_dark || ''))
        : (useDarkLogo ? (series.away_team_logo_dark || series.away_team_logo_light || '') : (series.away_team_logo_light || series.away_team_logo_dark || ''));
    const isSelected = selectedTeamId === teamId;
    const frameClass = mode === 'scenario'
        ? (isSelected
            ? 'border-emerald-300 bg-emerald-400/12 shadow-[0_0_0_1px_rgba(110,231,183,0.25)]'
            : 'border-white/10 bg-white/5 hover:border-emerald-300/60 hover:bg-white/10')
        : (isSelected
            ? 'border-emerald-300 bg-emerald-400/12 shadow-[0_0_0_1px_rgba(110,231,183,0.28)]'
            : 'border-white/10 bg-slate-950/65 hover:border-emerald-300/60 hover:bg-slate-900');

    return `
        <button type="button" class="pick-team-option group min-h-[12.5rem] rounded-[1.6rem] border p-4 text-center transition ${frameClass}" data-series-id="${series.id}" data-team-id="${teamId}">
            <div class="flex h-full flex-col items-center justify-between gap-3">
                <span class="inline-flex rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] ${isSelected ? 'bg-emerald-300/20 text-emerald-100' : 'bg-white/10 text-slate-300'}">${escapeHtml(seedLabel || 'Pick')}</span>
                <div class="flex h-24 w-24 items-center justify-center rounded-[1.5rem] border border-black/10 p-3 shadow-sm" style="background:${escapeAttribute(primaryColor)};">
                    <img src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(teamName)} logo" class="h-full w-full object-contain">
                </div>
                <div class="min-w-0">
                    <p class="min-h-[2.75rem] text-base font-black leading-tight text-white [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">${escapeHtml(teamName)}</p>
                    <p class="mt-1 text-[10px] uppercase tracking-[0.18em] ${isSelected ? 'text-emerald-200' : 'text-slate-400'}">${escapeHtml(teamId)}</p>
                </div>
            </div>
        </button>
    `;
}

function buildGamesOptionGroupMarkup(seriesId, selectedGames, mode = 'live') {
    return [4, 5, 6, 7].map(games => buildGamesOptionMarkup(seriesId, games, selectedGames, mode)).join('');
}

function buildGamesOptionMarkup(seriesId, games, selectedGames, mode = 'live') {
    const isSelected = String(selectedGames) === String(games);
    const classes = mode === 'scenario'
        ? (isSelected
            ? 'border-amber-300 bg-amber-300/15 text-white'
            : 'border-white/10 bg-white/5 text-slate-300 hover:border-amber-300/60 hover:bg-white/10')
        : (isSelected
            ? 'border-amber-300 bg-amber-300/15 text-white shadow-[0_0_0_1px_rgba(252,211,77,0.25)]'
            : 'border-white/10 bg-slate-950/70 text-slate-200 hover:border-amber-300/60 hover:bg-slate-900');

    return `
        <button type="button" class="pick-games-option rounded-2xl border px-3 py-3 text-center transition ${classes}" data-series-id="${seriesId}" data-games="${games}">
            <span class="block text-2xl font-black">${games}</span>
        </button>
    `;
}

function isLightColor(hex) {
    const normalized = String(hex || '').replace('#', '');
    if (normalized.length !== 6) {
        return false;
    }

    const red = parseInt(normalized.slice(0, 2), 16);
    const green = parseInt(normalized.slice(2, 4), 16);
    const blue = parseInt(normalized.slice(4, 6), 16);
    if ([red, green, blue].some(Number.isNaN)) {
        return false;
    }

    const luminance = ((red * 299) + (green * 587) + (blue * 114)) / 1000;
    return luminance >= 160;
}

function getRoundOne() {
    return state.playoff.rounds.find(round => Number(round.round_number || 0) === 1) || null;
}

function isTeamNameLockedForMember() {
    const roundOne = getRoundOne();
    return Boolean(roundOne && isRoundLocked(roundOne));
}

function normalizeTeamNameValue(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeTeamNameComparison(value = '') {
    return normalizeTeamNameValue(value).toLowerCase();
}

function isTeamNameDirty() {
    return normalizeTeamNameValue(state.playoff.teamNameDraft) !== normalizeTeamNameValue(state.playoff.member?.team_name || '');
}

function hasReadyTeamNameForPicks() {
    return Boolean(normalizeTeamNameValue(state.playoff.member?.team_name || ''))
        && (isTeamNameLockedForMember() || !isTeamNameDirty());
}

function buildPaymentInstructions() {
    const dueAmount = state.playoff.payment?.amount_due || state.playoff.member?.amount_due || state.playoff.pool?.entry_fee_default || CONFIG.PLAYOFF_DEFAULT_ENTRY_FEE;
    const paidAmount = state.playoff.payment?.amount_paid || state.playoff.member?.amount_paid || 0;
    const remaining = Math.max(0, Number(dueAmount) - Number(paidAmount));
    const balanceText = remaining > 0 ? `${formatCurrency(remaining)} remaining.` : 'You are fully paid.';
    return `Send your entry by e-transfer to ${CONFIG.PAYMENT_EMAIL}. Current entry fee: ${formatCurrency(dueAmount)}. ${balanceText}`;
}

function buildPlayoffPaymentLink() {
    const dueAmount = state.playoff.payment?.amount_due || state.playoff.member?.amount_due || state.playoff.pool?.entry_fee_default || CONFIG.PLAYOFF_DEFAULT_ENTRY_FEE;
    const subject = encodeURIComponent(`Playoff Pool Payment (${state.authUser.email})`);
    const body = encodeURIComponent(`Hi Elliot,\n\nI have sent my playoff pool entry payment of ${formatCurrency(dueAmount)}.\n\nAccount email: ${state.authUser.email}\nTeam name: ${state.playoff.member?.team_name || ''}\n\nThanks!`);
    return `mailto:${CONFIG.PAYMENT_EMAIL}?subject=${subject}&body=${body}`;
}

function getPoolRulesSourceTextLegacy() {
    const description = String(state.playoff.pool?.description || '').trim();
    if (description) {
        return description;
    }

    return [
        'Sign up + join',
        '',
        'Open the pool link, create an account, then follow the on-screen instructions. If you can see the Playoff Pool page, you’re in.',
        '',
        'Hard deadline (payment + picks)',
        '',
        'You must be PAID ($25 entry fee) and have ALL Round 1 picks saved before puck drop of Game 1:',
        'Saturday, April 18, 2026 — 3:00 PM ET (Hurricanes vs Senators).',
        'No pay = no picks. If you’re unpaid at puck drop, you’re done for the year.',
        '',
        'Payment',
        '',
        'Entry fee is $25.',
        'Pay using the instructions in the app. Add your team name in the note so it matches up without a forensic audit.',
        '',
        'Team name (scoreboard name)',
        '',
        'Pick the name you want shown on the standings board (max 40 characters).',
        'Set it early so people know who’s who before the chaos starts.',
        '',
        'Making picks',
        '',
        'For every series, you choose:',
        'the series winner (click the logo), and',
        'the exact series length (4–7 games).',
        'You can edit picks up until the deadline. After that, they lock.',
        '',
        'Scoring (it doubles each round)',
        '',
        'Each series has two ways to score:',
        'Winner = points',
        'Exact games = points',
        'Points by round:',
        'Round 1: Winner 2, Games 1',
        'Round 2: Winner 4, Games 2',
        'Round 3: Winner 8, Games 4',
        'Round 4: Winner 16, Games 8',
        '',
        'Prize pool + payouts (Top 3 + Pity)',
        '',
        'Prize pool = the money collected from paid entries.',
        'Payout template: 1st / 2nd / 3rd / Pity.',
        'Payout amounts scale with the pot and are shown in the app.',
        '',
        'Ties (golf-style payout splits)',
        '',
        'If there’s a tie in a paying position, we combine the money for the tied places and split it evenly, then skip the next place(s).',
        'Example: tie for 2nd → (2nd + 3rd money) split evenly between the tied entries → next payout position becomes 4th.',
        '',
        'Admin reality clause',
        '',
        'If the NHL updates results, corrections happen, and scores may be rescored. The standings follow the official outcomes, not vibes.'
    ].join('\n');
}

function parsePoolRulesSectionsLegacy(rawText = '') {
    return String(rawText || '')
        .split(/\r?\n\s*\r?\n/)
        .map(block => block
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean))
        .filter(lines => lines.length)
        .map(lines => ({
            heading: lines[0],
            lines: lines.slice(1)
        }));
}

function buildPoolRulesMarkupLegacy() {
    const sections = parsePoolRulesSectionsLegacy(getPoolRulesSourceTextLegacy());
    if (!sections.length) {
        return '<p class="text-sm leading-[1.4] text-slate-300">Pool rules will appear here once they are posted.</p>';
    }

    return `
        <div class="space-y-5">
            ${sections.map(section => renderPoolRulesSectionLegacy(section)).join('')}
        </div>
    `;
}

function renderPoolRulesSectionLegacy(section) {
    const heading = String(section.heading || '');
    const lines = Array.isArray(section.lines) ? section.lines : [];
    const accentClass = getRulesHeadingAccentClassLegacy(heading);

    if (heading === 'Scoring (it doubles each round)') {
        return renderScoringRulesSection(heading, lines, accentClass);
    }

    if (heading === 'Ties (golf-style payout splits)') {
        return renderTiebreakRulesSection(heading, lines, accentClass);
    }

    if (heading === 'Hard deadline (payment + picks)') {
        return renderDeadlineRulesSection(heading, lines, accentClass);
    }

    return `
        <section class="space-y-3 rounded-[1.1rem] border border-white/10 bg-white/[0.03] p-4">
            <div>
                <p class="text-[11px] font-bold uppercase tracking-[0.3em] ${accentClass}">${escapeHtml(heading)}</p>
            </div>
            <div class="space-y-2 text-sm leading-[1.4] text-slate-200">
                ${renderPoolRulesBody(lines)}
            </div>
        </section>
    `;
}

function renderPoolRulesBody(lines = []) {
    if (!lines.length) {
        return '';
    }

    if (lines[0].endsWith(':') && lines.length > 1) {
        const intro = lines[0];
        const listItems = lines.slice(1);
        return `
            <p>${escapeHtml(intro)}</p>
            <ul class="space-y-1.5 pl-5 text-slate-300 list-disc">
                ${listItems.map(line => `<li>${escapeHtml(line)}</li>`).join('')}
            </ul>
        `;
    }

    return lines.map(line => `<p>${escapeHtml(line)}</p>`).join('');
}

function renderDeadlineRulesSection(heading, lines, accentClass) {
    const intro = lines[0] || '';
    const deadlineLine = lines[1] || '';
    const warningLine = lines[2] || '';

    return `
        <section class="space-y-3 rounded-[1.1rem] border border-amber-300/30 bg-amber-300/10 p-4">
            <div>
                <p class="text-[11px] font-bold uppercase tracking-[0.3em] ${accentClass}">${escapeHtml(heading)}</p>
            </div>
            <div class="space-y-2 text-sm leading-[1.4] text-slate-100">
                ${intro ? `<p>${escapeHtml(intro)}</p>` : ''}
                ${deadlineLine ? `<div class="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 font-semibold text-white">${escapeHtml(deadlineLine)}</div>` : ''}
                ${warningLine ? `<div class="rounded-2xl border border-rose-300/30 bg-rose-400/10 px-4 py-3 font-semibold text-rose-100">${escapeHtml(warningLine)}</div>` : ''}
            </div>
        </section>
    `;
}

function renderScoringRulesSection(heading, lines, accentClass) {
    const roundRows = lines.filter(line => /^Round\s+\d+:/i.test(line));
    const introLines = lines.filter(line => !/^Round\s+\d+:/i.test(line));

    return `
        <section class="space-y-3 rounded-[1.1rem] border border-white/10 bg-white/[0.03] p-4">
            <div>
                <p class="text-[11px] font-bold uppercase tracking-[0.3em] ${accentClass}">${escapeHtml(heading)}</p>
            </div>
            <div class="space-y-2 text-sm leading-[1.4] text-slate-200">
                ${renderPoolRulesBody(introLines)}
            </div>
            <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                ${roundRows.map(line => {
                    const [roundLabel, details] = line.split(':');
                    return `
                        <div class="rounded-2xl border border-white/10 bg-slate-950/55 px-4 py-3">
                            <p class="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-400">${escapeHtml(roundLabel || '')}</p>
                            <p class="mt-1 text-sm font-semibold leading-[1.35] text-white">${escapeHtml((details || '').trim())}</p>
                        </div>
                    `;
                }).join('')}
            </div>
        </section>
    `;
}

function renderTiebreakRulesSection(heading, lines, accentClass) {
    const exampleLine = lines.find(line => /^Example:/i.test(line)) || '';
    const baseLines = lines.filter(line => line !== exampleLine);

    return `
        <section class="space-y-3 rounded-[1.1rem] border border-white/10 bg-white/[0.03] p-4">
            <div>
                <p class="text-[11px] font-bold uppercase tracking-[0.3em] ${accentClass}">${escapeHtml(heading)}</p>
            </div>
            <div class="space-y-2 text-sm leading-[1.4] text-slate-200">
                ${renderPoolRulesBody(baseLines)}
            </div>
            ${exampleLine ? `
                <div class="rounded-2xl border border-sky-300/25 bg-sky-400/10 px-4 py-3">
                    <p class="text-[11px] font-bold uppercase tracking-[0.22em] text-sky-200">Example</p>
                    <p class="mt-1 text-sm leading-[1.4] text-slate-100">${escapeHtml(exampleLine.replace(/^Example:\s*/i, ''))}</p>
                </div>
            ` : ''}
        </section>
    `;
}

function getRulesHeadingAccentClassLegacy(heading = '') {
    if (heading === 'Hard deadline (payment + picks)') return 'text-amber-300';
    if (heading === 'Payment') return 'text-amber-300';
    if (heading === 'Scoring (it doubles each round)') return 'text-emerald-300';
    if (heading === 'Prize pool + payouts (Top 3 + Pity)') return 'text-fuchsia-200';
    if (heading === 'Ties (golf-style payout splits)') return 'text-sky-300';
    if (heading === 'Admin reality clause') return 'text-rose-200';
    return 'text-emerald-300';
}

function getPoolRulesSourceText() {
    const description = String(state.playoff.pool?.description || '').trim();
    if (description) {
        return description;
    }

    return [
        '## Sign up + join',
        'Open the pool link, create an account, then follow the on-screen instructions. If you can see the Playoff Pool page, you\'re in.',
        '',
        '---',
        '',
        '## Hard deadline — payment + picks',
        'You must be **paid** ($25 entry fee) and have **all Round 1 picks saved** before puck drop of Game 1:',
        '',
        '**Saturday, April 18, 2026 — 3:00 PM ET** (Hurricanes vs Senators)',
        '',
        'No pay = no picks. If you\'re unpaid at puck drop, you\'re done for the year.',
        '',
        '---',
        '',
        '## Payment',
        'Entry fee is **$25**. Pay using the instructions in the app. Add your team name in the note so it matches up without a forensic audit.',
        '',
        '---',
        '',
        '## Team name (scoreboard name)',
        'Pick the name you want shown on the standings board (max 40 characters). Set it early so people know who\'s who before the chaos starts.',
        '',
        '---',
        '',
        '## Making picks',
        'For every series, you choose:',
        '- the **series winner** (click the logo), and',
        '- the **exact series length** (4–7 games).',
        '',
        'You can edit picks up until the deadline. After that, they lock.',
        '',
        '---',
        '',
        '## Scoring (doubles each round)',
        'Each series has two ways to score: **winner points** and **exact games points**.',
        '',
        '| Round | Winner | Exact games |',
        '|-------|--------|-------------|',
        '| 1 | 2 pts | 1 pt |',
        '| 2 | 4 pts | 2 pts |',
        '| 3 | 8 pts | 4 pts |',
        '| 4 | 16 pts | 8 pts |',
        '',
        '---',
        '',
        '## Prize pool + payouts',
        'Prize pool = total collected from paid entries. Paid out to **1st / 2nd / 3rd + Pity**. Amounts scale with the pot and are shown in the app.',
        '',
        '---',
        '',
        '## Ties (golf-style split)',
        'Tied entries in a paying position share the combined prize money for those positions. The next payout position is then skipped.',
        '',
        '**Example:** tie for 2nd → (2nd + 3rd money) split evenly → next payout goes to 4th.',
        '',
        '---',
        '',
        '## Admin reality clause',
        'If the NHL updates results, scores will be corrected accordingly. Standings follow official outcomes — not vibes.'
    ].join('\n');
}

function parsePoolRulesSections(rawText = '') {
    return String(rawText || '')
        .replace(/\r\n/g, '\n')
        .split(/\n\s*---+\s*\n/g)
        .map(block => block.trim())
        .filter(Boolean)
        .map(block => {
            const lines = block.split('\n').map(line => line.trimEnd());
            const headingLine = lines.find(line => /^##\s+/.test(line)) || '';
            const headingIndex = headingLine ? lines.indexOf(headingLine) : -1;
            return {
                heading: headingLine.replace(/^##\s+/, '').trim(),
                markdown: lines.slice(headingIndex + 1).join('\n').trim()
            };
        })
        .filter(section => section.heading);
}

function buildPoolRulesMarkup() {
    const sections = parsePoolRulesSections(getPoolRulesSourceText());
    if (!sections.length) {
        return '<p class="text-sm leading-[1.4] text-slate-300">Pool rules will appear here once they are posted.</p>';
    }

    return `
        <div class="space-y-5">
            ${sections.map(section => renderPoolRulesSection(section)).join('')}
        </div>
    `;
}

function renderPoolRulesSection(section) {
    const heading = String(section.heading || '');
    const accentClass = getRulesHeadingAccentClass(heading);
    const sectionClass = getPoolRulesSectionContainerClass(heading);

    return `
        <section class="space-y-3 rounded-[1.1rem] ${sectionClass} p-4">
            <div>
                <p class="text-[11px] font-bold uppercase tracking-[0.3em] ${accentClass}">${escapeHtml(heading)}</p>
            </div>
            <div class="space-y-3 text-sm leading-[1.35] text-slate-200">
                ${renderPoolRulesMarkdown(heading, section.markdown)}
            </div>
        </section>
    `;
}

function renderPoolRulesMarkdown(heading, markdown = '') {
    const lines = String(markdown || '').split('\n');
    const chunks = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index].trim();
        if (!line) {
            index += 1;
            continue;
        }

        if (/^\|.*\|$/.test(line)) {
            const tableLines = [];
            while (index < lines.length && /^\|.*\|$/.test(lines[index].trim())) {
                tableLines.push(lines[index].trim());
                index += 1;
            }
            chunks.push(renderPoolRulesTable(tableLines));
            continue;
        }

        if (/^- /.test(line)) {
            const listItems = [];
            while (index < lines.length && /^- /.test(lines[index].trim())) {
                listItems.push(lines[index].trim().replace(/^- /, '').trim());
                index += 1;
            }
            chunks.push(`
                <ul class="space-y-2 pl-5 text-slate-200 list-disc marker:text-emerald-300">
                    ${listItems.map(item => `<li>${applyRulesInlineFormatting(item)}</li>`).join('')}
                </ul>
            `);
            continue;
        }

        if (heading === 'Hard deadline — payment + picks' && /^\*\*.+\*\*(?:\s*\(.+\))?$/.test(line)) {
            chunks.push(`
                <div class="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 font-semibold text-white">
                    ${applyRulesInlineFormatting(line)}
                </div>
            `);
            index += 1;
            continue;
        }

        if (heading === 'Hard deadline — payment + picks' && /^No pay = no picks\./i.test(line)) {
            chunks.push(`
                <div class="rounded-2xl border border-rose-300/30 bg-rose-400/10 px-4 py-3 font-semibold text-rose-100">
                    ${applyRulesInlineFormatting(line)}
                </div>
            `);
            index += 1;
            continue;
        }

        if (heading === 'Ties (golf-style split)' && /^\*\*Example:\*\*/i.test(line)) {
            chunks.push(`
                <div class="rounded-2xl border border-sky-300/25 bg-sky-400/10 px-4 py-3">
                    <p class="text-[11px] font-bold uppercase tracking-[0.22em] text-sky-200">Example</p>
                    <p class="mt-1 text-sm leading-[1.35] text-slate-100">${applyRulesInlineFormatting(line)}</p>
                </div>
            `);
            index += 1;
            continue;
        }

        chunks.push(`<p>${applyRulesInlineFormatting(line)}</p>`);
        index += 1;
    }

    return chunks.join('');
}

function getRulesHeadingAccentClass(heading = '') {
    if (heading === 'Hard deadline — payment + picks') return 'text-amber-300';
    if (heading === 'Payment') return 'text-amber-300';
    if (heading === 'Scoring (doubles each round)') return 'text-emerald-300';
    if (heading === 'Prize pool + payouts') return 'text-fuchsia-200';
    if (heading === 'Ties (golf-style split)') return 'text-sky-300';
    if (heading === 'Admin reality clause') return 'text-rose-200';
    return 'text-emerald-300';
}

function getPoolRulesSectionContainerClass(heading = '') {
    if (heading === 'Hard deadline — payment + picks') {
        return 'border border-amber-300/30 bg-amber-300/10';
    }

    return 'border border-white/10 bg-white/[0.03]';
}

function renderPoolRulesTable(lines = []) {
    const rows = lines
        .map(parsePoolRulesTableRow)
        .filter(row => row.length);
    if (rows.length < 2) {
        return '';
    }

    const header = rows[0];
    const body = rows
        .slice(1)
        .filter(row => !row.every(cell => /^:?-{3,}:?$/.test(cell)));

    return `
        <div class="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/55">
            <div class="grid grid-cols-3 gap-px bg-white/10 text-sm">
                ${header.map(cell => `
                    <div class="bg-slate-900/95 px-4 py-3 text-[11px] font-bold uppercase tracking-[0.22em] text-slate-300">
                        ${escapeHtml(cell)}
                    </div>
                `).join('')}
                ${body.map(row => row.map((cell, cellIndex) => `
                    <div class="bg-slate-950/85 px-4 py-3 ${cellIndex === 0 ? 'font-semibold text-white' : 'text-slate-200'}">
                        ${escapeHtml(cell)}
                    </div>
                `).join('')).join('')}
            </div>
        </div>
    `;
}

function parsePoolRulesTableRow(line = '') {
    return String(line || '')
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(cell => cell.trim());
}

function applyRulesInlineFormatting(text = '') {
    return escapeHtml(String(text || ''))
        .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-white">$1</strong>');
}

function buildCurrentRankSummary() {
    const currentRank = state.playoff.standings.findIndex(member => member.id === state.authUser.uid);
    if (currentRank < 0) {
        return 'Your live placement will show up here once you are on the standings board.';
    }

    return `Currently ${ordinal(currentRank + 1)} of ${state.playoff.standings.length}`;
}

function renderIPTVUpsellBanner() {
    const banner = byId('iptv-upsell-banner');
    if (!banner) return;
    if (state.accessibleApps[APP_IDS.STRONG8K]) {
        banner.classList.add('hidden');
        return;
    }
    banner.classList.remove('hidden');
    banner.innerHTML = `
        <div class="rounded-[1.5rem] border border-amber-400/30 bg-gradient-to-r from-amber-950/60 to-slate-900/80 px-5 py-4">
            <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div class="min-w-0">
                    <p class="text-[11px] font-bold uppercase tracking-[0.3em] text-amber-300">Strong8K IPTV</p>
                    <p class="mt-1 text-sm font-semibold text-white">Want to watch the games live? Get Elliot's IPTV service — 3 months for $25.</p>
                </div>
                <button id="iptv-activate-btn" class="shrink-0 rounded-full bg-amber-400 px-5 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-amber-300">
                    Activate IPTV Access
                </button>
            </div>
            <div id="iptv-code-wrap" class="hidden mt-4 flex gap-2">
                <input type="text" id="iptv-code-input" placeholder="Invite Code" class="flex-1 rounded-2xl border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-bold uppercase tracking-widest text-white placeholder-white/40 outline-none transition focus:border-amber-400">
                <button id="iptv-code-submit" class="rounded-2xl bg-amber-400 px-5 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-amber-300">Go</button>
                <button id="iptv-code-cancel" class="rounded-2xl border border-white/20 px-4 py-2.5 text-sm font-bold text-white/60 transition hover:text-white">Cancel</button>
            </div>
        </div>
    `;

    byId('iptv-activate-btn').addEventListener('click', () => {
        byId('iptv-activate-btn').classList.add('hidden');
        byId('iptv-code-wrap').classList.remove('hidden');
        byId('iptv-code-input').focus();
    });

    byId('iptv-code-cancel').addEventListener('click', () => {
        byId('iptv-code-wrap').classList.add('hidden');
        byId('iptv-activate-btn').classList.remove('hidden');
        byId('iptv-code-input').value = '';
    });

    byId('iptv-code-submit').addEventListener('click', async () => {
        const code = byId('iptv-code-input').value.trim();
        const appId = resolveInviteCode(code);
        if (appId !== APP_IDS.STRONG8K) {
            showToast('Invalid invite code', 'error');
            return;
        }
        try {
            byId('iptv-code-submit').disabled = true;
            await selfActivateApp(APP_IDS.STRONG8K, code.toUpperCase());
            await hydrateSession(state.authUser);
            showToast('Strong8K IPTV access activated!');
            window.location.hash = APP_DEFINITIONS[APP_IDS.STRONG8K].route;
            await openApp(APP_IDS.STRONG8K);
        } catch (error) {
            showToast(error.message, 'error');
            byId('iptv-code-submit').disabled = false;
        }
    });
}

function buildScenarioDraft(seriesList = [], existingDraft = {}) {
    return Object.fromEntries(seriesList.map(series => [
        series.id,
        {
            result_winner_team_id: existingDraft[series.id]?.result_winner_team_id || series.result_winner_team_id || '',
            result_games: String(existingDraft[series.id]?.result_games || series.result_games || '')
        }
    ]));
}

function buildScenarioSeriesList() {
    return state.playoff.series.map(series => ({
        ...series,
        result_winner_team_id: state.playoff.scenarioDraft[series.id]?.result_winner_team_id || '',
        result_games: Number(state.playoff.scenarioDraft[series.id]?.result_games || 0)
    }));
}

function buildCurrentUserScenarioPickDoc() {
    if (state.playoff.currentPick?.entries?.length) {
        return normalizePickDoc(state.playoff.currentPick);
    }

    return normalizePickDoc({
        id: state.authUser.uid,
        entries: state.playoff.series.map(series => ({
            series_id: series.id,
            winner_team_id: state.playoff.draft[series.id]?.winner_team_id || '',
            games: Number(state.playoff.draft[series.id]?.games || 0)
        }))
    });
}

function buildScenarioSnapshot() {
    const scenarioSeries = buildScenarioSeriesList();
    const currentRound = state.playoff.currentRound;
    const currentRoundId = currentRound?.id || '';
    const actualUserRoundPoints = Number((state.playoff.member?.round_history || []).find(item => item.round_id === currentRoundId)?.points || 0);
    const selfScoredPick = scorePickDocument(buildCurrentUserScenarioPickDoc(), scenarioSeries, currentRound);
    const selfProjectedTotal = Number(state.playoff.member?.points_total || 0) - actualUserRoundPoints + Number(selfScoredPick.round_total || 0);
    const scoreboardVisible = Boolean(state.playoff.roundPickDocs.length) && isRoundRevealed(currentRound, state.playoff.pool);

    if (!scoreboardVisible) {
        return {
            scoreboardVisible,
            selfScoredPick,
            selfProjectedTotal,
            projectedStandings: [],
            projectedRank: null
        };
    }

    const projectedStandings = sortStandings(state.playoff.standings.map(member => {
        const actualRoundPoints = Number((member.round_history || []).find(item => item.round_id === currentRoundId)?.points || 0);
        const pickDoc = state.playoff.roundPickDocs.find(item => item.id === member.id) || normalizePickDoc({
            id: member.id,
            entries: state.playoff.series.map(series => ({ series_id: series.id }))
        });
        const scoredPick = scorePickDocument(pickDoc, scenarioSeries, currentRound);
        return normalizePlayoffMember({
            ...member,
            round_points: Number(scoredPick.round_total || 0),
            points_total: Number(member.points_total || 0) - actualRoundPoints + Number(scoredPick.round_total || 0)
        }, state.playoff.pool);
    }));

    return {
        scoreboardVisible,
        selfScoredPick,
        selfProjectedTotal,
        projectedStandings,
        projectedRank: projectedStandings.findIndex(member => member.id === state.authUser.uid)
    };
}

function renderScenarioLab() {
    const resultContainer = byId('playoff-whatif-series');
    const summary = byId('playoff-whatif-summary');
    const scoreboard = byId('playoff-whatif-scoreboard');
    resultContainer.innerHTML = '';
    summary.innerHTML = '';
    scoreboard.innerHTML = '';

    if (!state.playoff.currentRound || !state.playoff.series.length) {
        resultContainer.innerHTML = '<p class="text-sm text-slate-400">Once a round is loaded, you can run hypothetical results here.</p>';
        summary.innerHTML = '<p class="text-sm text-slate-400">No scenario data is available yet.</p>';
        return;
    }

    state.playoff.series.forEach(series => {
        const draft = state.playoff.scenarioDraft[series.id] || {};
        const card = document.createElement('article');
        card.className = 'rounded-[1.75rem] border border-white/10 bg-slate-950/35 p-5';
        card.innerHTML = `
            <div class="mb-4 flex items-start justify-between gap-4">
                <div>
                    <p class="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-400">${escapeHtml(series.matchup_label || `${series.home_team_name || series.home_team_id} vs ${series.away_team_name || series.away_team_id}`)}</p>
                    <h4 class="mt-2 text-xl font-black text-white">${escapeHtml((series.home_team_name || series.home_team_id) + ' vs ' + (series.away_team_name || series.away_team_id))}</h4>
                </div>
                <span class="rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold uppercase text-slate-300">${series.status || 'Open'}</span>
            </div>
            <div class="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
                <div>
                    <span class="mb-3 block text-[11px] font-bold uppercase tracking-[0.22em] text-slate-300">Pick The Winner</span>
                    <div class="grid gap-3 sm:grid-cols-2">
                        ${buildPickTeamOptionMarkup(series, 'home', draft.result_winner_team_id, 'scenario')}
                        ${buildPickTeamOptionMarkup(series, 'away', draft.result_winner_team_id, 'scenario')}
                    </div>
                </div>
                <div>
                    <span class="mb-3 block text-[11px] font-bold uppercase tracking-[0.22em] text-slate-300"># Games - Exact Length</span>
                    <div class="grid grid-cols-4 gap-2">
                        ${buildGamesOptionGroupMarkup(series.id, draft.result_games, 'scenario')}
                    </div>
                </div>
            </div>
        `;
        resultContainer.appendChild(card);
    });

    resultContainer.querySelectorAll('.pick-team-option').forEach(button => {
        button.addEventListener('click', event => updateScenarioDraft(event.currentTarget.dataset.seriesId, 'result_winner_team_id', event.currentTarget.dataset.teamId));
    });
    resultContainer.querySelectorAll('.pick-games-option').forEach(button => {
        button.addEventListener('click', event => updateScenarioDraft(event.currentTarget.dataset.seriesId, 'result_games', event.currentTarget.dataset.games));
    });

    const snapshot = buildScenarioSnapshot();
    summary.innerHTML = `
        <div class="grid gap-4 md:grid-cols-2">
            <div class="rounded-3xl bg-white/5 p-4">
                <p class="text-xs uppercase tracking-[0.2em] text-slate-400">Your Projected Round</p>
                <p class="mt-2 text-3xl font-black text-white">${snapshot.selfScoredPick.round_total || 0}</p>
            </div>
            <div class="rounded-3xl bg-white/5 p-4">
                <p class="text-xs uppercase tracking-[0.2em] text-slate-400">Your Projected Total</p>
                <p class="mt-2 text-3xl font-black text-white">${snapshot.selfProjectedTotal}</p>
                <p class="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">${snapshot.projectedRank >= 0 ? `Projected ${ordinal(snapshot.projectedRank + 1)} place if these results happen.` : 'Projected rank appears once the round is revealed.'}</p>
            </div>
        </div>
    `;

    if (!snapshot.scoreboardVisible) {
        scoreboard.innerHTML = '<p class="text-sm text-slate-400">Full projected standings unlock after the round locks and everyone’s picks are revealed. Until then, this lab only shows your own projection.</p>';
    } else {
        scoreboard.innerHTML = `
            <div class="overflow-hidden rounded-3xl border border-white/10">
                <table class="w-full text-left">
                    <thead class="bg-slate-950/70 text-[11px] uppercase tracking-[0.22em] text-slate-400">
                        <tr>
                            <th class="px-4 py-3">#</th>
                            <th class="px-4 py-3">Member</th>
                            <th class="px-4 py-3">Projected Pts</th>
                            <th class="px-4 py-3">Projected Round</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${snapshot.projectedStandings.map((member, index) => `
                            <tr class="${member.id === state.authUser.uid ? 'border-b border-emerald-300/30 bg-emerald-400/10 text-sm' : 'border-b border-white/10 text-sm'}">
                                <td class="px-4 py-3 text-slate-300">${index + 1}</td>
                                <td class="px-4 py-3 font-semibold text-white">${escapeHtml(member.team_name || member.display_name || member.email || member.id)}</td>
                                <td class="px-4 py-3 text-slate-200">${member.points_total || 0}</td>
                                <td class="px-4 py-3 text-slate-400">${member.round_points || 0}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }
}

function updateScenarioDraft(seriesId, field, value) {
    const next = state.playoff.scenarioDraft[seriesId] || {};
    next[field] = value;
    state.playoff.scenarioDraft[seriesId] = next;
    renderScenarioLab();
}


// Multi-round scoreboard history builder — processes ALL rounds in order, carries totals forward.
function buildAllEventSnapshots(historySeriesMap = {}, historyPickDocsMap = {}, rounds = [], members = []) {
    const sortedRounds = [...rounds].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const allEvents = [];
    const cumulativePoints = Object.fromEntries(members.map(m => [m.id, 0]));

    for (const round of sortedRounds) {
        const roundSeries = historySeriesMap[round.id] || [];
        const pickDocs = historyPickDocsMap[round.id] || [];
        if (!pickDocs.length) continue;

        const confirmedSeries = roundSeries
            .filter(s => s.result_winner_team_id)
            .sort((a, b) => {
                const at = a.result_decided_at ? new Date(a.result_decided_at).getTime() : 0;
                const bt = b.result_decided_at ? new Date(b.result_decided_at).getTime() : 0;
                if (at && bt) return at - bt;
                return Number(a.sort_order || 0) - Number(b.sort_order || 0);
            });
        if (!confirmedSeries.length) continue;

        const pickById = Object.fromEntries(pickDocs.map(p => [p.id, p]));

        confirmedSeries.forEach((s, i) => {
            const confirmedIds = new Set(confirmedSeries.slice(0, i + 1).map(x => x.id));
            const maskedSeries = roundSeries.map(rs =>
                confirmedIds.has(rs.id) ? rs : { ...rs, result_winner_team_id: '', result_games: 0 }
            );
            const standings = members.map(m => {
                const pd = pickById[m.id];
                const roundPts = pd ? scorePickDocument(pd, maskedSeries, round).round_total : 0;
                return {
                    id: m.id,
                    display_name: m.team_name || m.display_name || m.id,
                    person_name: m.display_name || '',
                    points_total: (cumulativePoints[m.id] || 0) + roundPts,
                    round_points: roundPts
                };
            }).sort((a, b) => b.points_total - a.points_total);

            allEvents.push({
                seriesId: s.id,
                roundId: round.id,
                roundName: round.name || `Round ${round.round_number}`,
                homeId: s.home_team_id,
                awayId: s.away_team_id,
                winnerId: s.result_winner_team_id,
                games: s.result_games || 0,
                label: `${s.home_team_id} vs ${s.away_team_id}`,
                standings
            });
        });

        // After this round's events, carry forward cumulative totals for next round
        if (allEvents.length > 0) {
            const lastEvent = allEvents[allEvents.length - 1];
            for (const s of lastEvent.standings) {
                cumulativePoints[s.id] = s.points_total;
            }
        }
    }

    return allEvents;
}

function buildEventSnapshots(series = [], pickDocs = [], currentRound = null, members = []) {
    if (!series.length || !pickDocs.length || !currentRound) return [];

    const confirmedSeries = series
        .filter(s => s.result_winner_team_id)
        .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
    if (!confirmedSeries.length) return [];

    const pickById = Object.fromEntries(pickDocs.map(p => [p.id, p]));

    // Previous-rounds baseline per member (all rounds except current)
    const prevPoints = Object.fromEntries(members.map(m => [
        m.id,
        (m.round_history || [])
            .filter(h => h.round_id !== currentRound.id)
            .reduce((sum, h) => sum + Number(h.points || 0), 0)
    ]));

    function computeSnapshot(confirmedIds) {
        const masked = series.map(s =>
            confirmedIds.has(s.id) ? s : { ...s, result_winner_team_id: '', result_games: 0 }
        );
        return members.map(m => {
            const pd = pickById[m.id];
            const rPts = pd ? scorePickDocument(pd, masked, currentRound).round_total : 0;
            return {
                id: m.id,
                display_name: m.team_name || m.display_name || m.id,
                points_total: (prevPoints[m.id] || 0) + rPts,
                round_points: rPts
            };
        }).sort((a, b) => b.points_total - a.points_total);
    }

    return confirmedSeries.map((s, i) => {
        const confirmedIds = new Set(confirmedSeries.slice(0, i + 1).map(x => x.id));
        return {
            seriesId: s.id,
            homeId: s.home_team_id,
            awayId: s.away_team_id,
            winnerId: s.result_winner_team_id,
            games: s.result_games || 0,
            label: `${s.home_team_id} vs ${s.away_team_id}`,
            standings: computeSnapshot(confirmedIds)
        };
    });
}

function buildRankSparkline(rankTrend = [], highlightIdx = -1) {
    const filtered = rankTrend.filter(r => r != null && r > 0);
    if (filtered.length < 2) return '<span class="text-slate-700 text-[10px]">—</span>';
    const width = 56;
    const height = 18;
    const minRank = Math.min(...filtered);
    const maxRank = Math.max(...filtered);
    const span = Math.max(1, maxRank - minRank);
    const points = rankTrend.map((rank, idx) => {
        if (rank == null || rank <= 0) return null;
        const x = rankTrend.length === 1 ? width / 2 : (idx / (rankTrend.length - 1)) * width;
        // Lower rank number (better) = higher on chart (smaller y).
        const y = ((rank - minRank) / span) * (height - 4) + 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).filter(Boolean).join(' ');
    let dot = '';
    if (highlightIdx >= 0 && highlightIdx < rankTrend.length && rankTrend[highlightIdx] != null) {
        const rank = rankTrend[highlightIdx];
        const dx = rankTrend.length === 1 ? width / 2 : (highlightIdx / (rankTrend.length - 1)) * width;
        const dy = ((rank - minRank) / span) * (height - 4) + 2;
        dot = `<circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="2" fill="rgb(125 211 252)" />`;
    }
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="inline-block">
        <polyline fill="none" stroke="rgb(125 211 252)" stroke-width="1.5" points="${points}" />${dot}
    </svg>`;
}

function renderStandingsHistory() {
    const container = byId('standings-history');
    if (!container) return;
    const history = state.playoff.eventHistory || [];
    if (!history.length) { container.innerHTML = ''; return; }

    const K = history.length;
    const idx = Math.max(0, Math.min(state.playoff.timelineIndex, K - 1));
    const event = history[idx];
    const prevSnap = idx > 0 ? history[idx - 1].standings : null;
    const prevRankById = prevSnap ? Object.fromEntries(prevSnap.map((m, i) => [m.id, i + 1])) : {};
    const prevPointsById = prevSnap ? Object.fromEntries(prevSnap.map(m => [m.id, m.points_total])) : {};

    // Build per-member rank trend across all events (for sparkline)
    const rankTrendById = {};
    history.forEach((ev, evIdx) => {
        ev.standings.forEach((m, position) => {
            if (!rankTrendById[m.id]) rankTrendById[m.id] = new Array(K).fill(null);
            rankTrendById[m.id][evIdx] = position + 1;
        });
    });

    // Build seriesById across ALL rounds for logo/color lookups and potential points
    const seriesById = {};
    Object.values(state.playoff.historySeriesMap || {}).forEach(roundSeries => {
        roundSeries.forEach(s => { seriesById[s.id] = s; });
    });
    // Fallback to current round series if historySeriesMap not yet populated
    (state.playoff.series || []).forEach(s => { if (!seriesById[s.id]) seriesById[s.id] = s; });

    const picksByMember = Object.fromEntries((state.playoff.roundPickDocs || []).map(p => [p.id, p]));
    const currentRound = state.playoff.currentRound;

    // Snapshot rows
    const snapRows = event.standings.map((m, i) => {
        const rank = i + 1;
        const prev = prevRankById[m.id];
        const delta = prev !== undefined ? prev - rank : null;
        const deltaHTML = delta === null ? '<span class="text-slate-700 text-[10px]">—</span>' : delta > 0
            ? `<span class="text-emerald-400 text-[10px] font-black">▲${delta}</span>`
            : delta < 0
                ? `<span class="text-rose-400 text-[10px] font-black">▼${Math.abs(delta)}</span>`
                : `<span class="text-slate-600 text-[10px]">—</span>`;
        const prevPts = prevPointsById[m.id] ?? 0;
        const earnedThisEvent = (m.points_total || 0) - prevPts;
        const earnedHTML = earnedThisEvent > 0
            ? `<span class="text-amber-300 text-[11px] font-bold tabular-nums">+${earnedThisEvent}</span>`
            : `<span class="text-slate-600 text-[11px]">—</span>`;

        const trend = rankTrendById[m.id] || [];
        const trendSparkline = buildRankSparkline(trend, idx);

        const memberPick = picksByMember[m.id];
        const potential = (memberPick && currentRound)
            ? computeMemberPotentialPoints(memberPick.entries || [], seriesById, currentRound)
            : 0;
        const potentialHTML = potential > 0
            ? `<span class="text-sky-300 text-[11px] font-bold tabular-nums">+${potential}</span>`
            : `<span class="text-slate-600 text-[11px]">—</span>`;

        const isMe = m.id === state.authUser?.uid;
        const personNameHTML = (m.person_name && m.person_name !== m.display_name)
            ? `<span class="block text-[11px] text-slate-400">${escapeHtml(m.person_name)}</span>`
            : '';
        return `<tr class="${isMe ? 'bg-emerald-400/5' : ''} border-b border-white/5 hover:bg-white/5 transition">
            <td class="px-3 py-1.5 text-[11px] font-bold text-slate-500 tabular-nums w-7">${rank}</td>
            <td class="px-3 py-1.5"><span class="text-sm font-semibold text-white">${escapeHtml(m.display_name)}</span>${personNameHTML}</td>
            <td class="px-3 py-1.5 text-sm tabular-nums font-semibold text-slate-200 text-right">${m.points_total}</td>
            <td class="px-3 py-1.5 text-right">${earnedHTML}</td>
            <td class="px-3 py-1.5 text-right">${deltaHTML}</td>
            <td class="px-3 py-1.5 text-center w-16">${trendSparkline}</td>
            <td class="px-3 py-1.5 text-right">${potentialHTML}</td>
        </tr>`;
    }).join('');

    // Event chips
    const chips = history.map((ev, i) => `
        <button data-timeline-jump="${i}"
            class="px-2 py-0.5 rounded-md text-[10px] font-semibold transition whitespace-nowrap
                   ${i === idx ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-400/30' : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}">
            ${escapeHtml(ev.label)}
        </button>`).join('');

    // Winner info — look up across all rounds' series
    const seriesObj = seriesById[event.seriesId] || null;
    const isWinnerHome = event.winnerId === event.homeId;
    const wLogo = seriesObj
        ? (isWinnerHome ? (seriesObj.home_team_logo_dark || seriesObj.home_team_logo_light || '') : (seriesObj.away_team_logo_dark || seriesObj.away_team_logo_light || ''))
        : '';
    const wColor = seriesObj
        ? (isWinnerHome ? (seriesObj.home_team_primary_color || '#0F172A') : (seriesObj.away_team_primary_color || '#0F172A'))
        : '#0F172A';

    // SVG rank chart
    const chartSVG = buildStandingsChartSVG(history, idx);

    container.innerHTML = `
        <div class="rounded-[2rem] border border-white/10 bg-white/5 p-5">
            <div class="flex flex-col gap-5 lg:flex-row lg:gap-6">

                <!-- Left: event nav + snapshot table -->
                <div class="flex-1 min-w-0">
                    <div class="flex items-start justify-between gap-3 mb-3">
                        <div>
                            <p class="text-[10px] font-bold uppercase tracking-[0.3em] text-sky-300">Scoreboard History</p>
                            <p class="text-xs text-slate-400 mt-0.5">${K} scoring event${K !== 1 ? 's' : ''} across all rounds</p>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                            <button ${idx === 0 ? 'disabled' : 'data-timeline-nav="-1"'}
                                class="w-7 h-7 flex items-center justify-center rounded-lg text-xs transition
                                       ${idx === 0 ? 'text-slate-700 cursor-not-allowed' : 'text-slate-400 hover:text-white hover:bg-white/10'}">◀</button>
                            <div class="flex flex-col items-center px-3 py-1.5 rounded-xl bg-white/5 min-w-[9rem] text-center">
                                ${wLogo ? `<div class="h-6 w-6 rounded-md mb-1 flex items-center justify-center border border-black/10 p-0.5" style="background:${escapeAttribute(wColor)}"><img src="${escapeAttribute(wLogo)}" class="h-full w-full object-contain" loading="lazy"></div>` : ''}
                                <p class="text-[11px] font-bold text-white leading-tight">${escapeHtml(event.label)}</p>
                                <p class="text-[10px] text-slate-400"><span class="text-white font-semibold">${escapeHtml(event.winnerId)}</span> wins${event.games ? ` in ${event.games}` : ''}</p>
                            </div>
                            <button ${idx === K - 1 ? 'disabled' : 'data-timeline-nav="1"'}
                                class="w-7 h-7 flex items-center justify-center rounded-lg text-xs transition
                                       ${idx === K - 1 ? 'text-slate-700 cursor-not-allowed' : 'text-slate-400 hover:text-white hover:bg-white/10'}">▶</button>
                        </div>
                    </div>
                    <div class="flex flex-wrap gap-1 mb-3">${chips}</div>
                    <div class="overflow-hidden rounded-2xl border border-white/10">
                        <table class="w-full text-left">
                            <thead class="bg-slate-950/70">
                                <tr>
                                    <th class="px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 w-7">#</th>
                                    <th class="px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Member</th>
                                    <th class="px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 text-right">Total</th>
                                    <th class="px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 text-right">Earned</th>
                                    <th class="px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 text-right">Move</th>
                                    <th class="px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 text-center">Trend</th>
                                    <th class="px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 text-right">Potential</th>
                                </tr>
                            </thead>
                            <tbody>${snapRows}</tbody>
                        </table>
                    </div>
                </div>

                <!-- Right: chart -->
                <div class="w-full lg:w-72 shrink-0">
                    <div class="flex items-center justify-between mb-2">
                        <p class="text-[10px] font-bold uppercase tracking-[0.25em] text-slate-500">Rank Evolution</p>
                        <div class="flex gap-1">
                            <button data-chart-type="rank"
                                class="px-2 py-0.5 rounded text-[10px] font-semibold transition
                                       ${(state.playoff.chartType || 'rank') === 'rank' ? 'bg-sky-500/20 text-sky-300' : 'text-slate-500 hover:text-slate-300'}">Rank</button>
                            <button data-chart-type="pts"
                                class="px-2 py-0.5 rounded text-[10px] font-semibold transition
                                       ${(state.playoff.chartType || 'rank') === 'pts' ? 'bg-sky-500/20 text-sky-300' : 'text-slate-500 hover:text-slate-300'}">Pts</button>
                        </div>
                    </div>
                    <div class="rounded-2xl border border-white/10 bg-slate-950/40 p-2 overflow-hidden">
                        ${chartSVG}
                    </div>
                    <p class="mt-2 text-[10px] text-slate-600">
                        <span class="text-violet-400">━</span> You &nbsp;
                        <span class="text-sky-400">━</span> Top 3 &nbsp;
                        <span class="text-slate-600">━</span> Others
                    </p>
                </div>

            </div>
        </div>`;
}

function buildStandingsChartSVG(history, selectedIdx) {
    if (!history.length) return '<p class="text-xs text-slate-600 py-8 text-center">No data yet</p>';

    const members = state.playoff.standings;
    const N = members.length;
    const K = history.length;
    const myId = state.authUser?.uid;
    const chartType = state.playoff.chartType || 'rank';

    // Identify top 3 by latest standings
    const top3Ids = new Set(history[history.length - 1].standings.slice(0, 3).map(m => m.id));

    // For each member, build array of values across events
    function getRank(snap, memberId) {
        const i = snap.standings.findIndex(m => m.id === memberId);
        return i === -1 ? N : i + 1;
    }
    function getPoints(snap, memberId) {
        return snap.standings.find(m => m.id === memberId)?.points_total || 0;
    }

    const maxPts = chartType === 'pts'
        ? Math.max(...history[history.length - 1].standings.map(m => m.points_total), 1)
        : null;

    const W = 280, H = 180;
    const pL = 22, pR = 8, pT = 8, pB = 20;
    const cW = W - pL - pR, cH = H - pT - pB;

    const xOf = i => pL + (K === 1 ? cW / 2 : (i / (K - 1)) * cW);
    const yOfRank = r => pT + ((r - 1) / Math.max(N - 1, 1)) * cH;
    const yOfPts = p => pT + (1 - p / maxPts) * cH;
    const yOf = chartType === 'rank' ? yOfRank : yOfPts;
    const valOf = chartType === 'rank'
        ? (snap, id) => getRank(snap, id)
        : (snap, id) => getPoints(snap, id);

    // Selected event guide line
    const gx = xOf(selectedIdx).toFixed(1);
    const guide = `<line x1="${gx}" y1="${pT}" x2="${gx}" y2="${H - pB}" stroke="rgba(148,163,184,0.15)" stroke-width="1" stroke-dasharray="3,2"/>`;

    // Lines (grey first, then highlights on top)
    const greyLines = members
        .filter(m => m.id !== myId && !top3Ids.has(m.id))
        .map(m => {
            const pts = history.map((snap, i) => `${xOf(i).toFixed(1)},${yOf(valOf(snap, m.id)).toFixed(1)}`).join(' ');
            return `<polyline points="${pts}" fill="none" stroke="rgba(51,65,85,0.8)" stroke-width="1" stroke-linejoin="round" stroke-linecap="round"/>`;
        }).join('');

    const top3Lines = members
        .filter(m => top3Ids.has(m.id) && m.id !== myId)
        .map(m => {
            const pts = history.map((snap, i) => `${xOf(i).toFixed(1)},${yOf(valOf(snap, m.id)).toFixed(1)}`).join(' ');
            return `<polyline points="${pts}" fill="none" stroke="rgba(56,189,248,0.7)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
        }).join('');

    const myLine = myId ? (() => {
        const m = members.find(m => m.id === myId);
        if (!m) return '';
        const pts = history.map((snap, i) => `${xOf(i).toFixed(1)},${yOf(valOf(snap, m.id)).toFixed(1)}`).join(' ');
        return `<polyline points="${pts}" fill="none" stroke="rgba(167,139,250,1)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    })() : '';

    // Endpoint dots for notable members at selected event
    const snap = history[selectedIdx];
    const notableDots = members
        .filter(m => m.id === myId || top3Ids.has(m.id))
        .map(m => {
            const x = gx;
            const y = yOf(valOf(snap, m.id)).toFixed(1);
            const isMe = m.id === myId;
            const col = isMe ? '#a78bfa' : '#38bdf8';
            return `<circle cx="${x}" cy="${y}" r="${isMe ? 3.5 : 2.5}" fill="${col}" stroke="rgb(2,6,23)" stroke-width="1.5"/>`;
        }).join('');

    // X labels (series home team ID, abbreviated)
    const xLabels = history.map((ev, i) => {
        const x = xOf(i).toFixed(1);
        return `<text x="${x}" y="${H - 4}" text-anchor="middle" font-size="7" fill="rgba(100,116,139,0.7)">${escapeHtml(ev.homeId || '')}</text>`;
    }).join('');

    // Y axis
    const yAxisItems = chartType === 'rank'
        ? [[1, '1'], [Math.ceil(N / 2), String(Math.ceil(N / 2))], [N, String(N)]]
        : [[maxPts, String(maxPts)], [Math.round(maxPts / 2), String(Math.round(maxPts / 2))], [0, '0']];
    const yLabels = yAxisItems.map(([v, label]) => {
        const y = (chartType === 'rank' ? yOfRank(v) : yOfPts(v)).toFixed(1);
        return `<text x="${pL - 3}" y="${(Number(y) + 3).toFixed(1)}" text-anchor="end" font-size="7" fill="rgba(100,116,139,0.6)">${label}</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${W} ${H}" class="w-full" style="height:${H}px">
        ${guide}
        ${greyLines}
        ${top3Lines}
        ${myLine}
        ${notableDots}
        ${xLabels}
        ${yLabels}
    </svg>`;
}

function renderPayoutSummary() {
    const container = byId('playoff-payout-summary');
    container.innerHTML = '';

    if (!state.playoff.payoutSummary.length) {
        container.innerHTML = '<p class="text-sm text-slate-400">Payout suggestions will appear after entrants and payments are tracked.</p>';
        return;
    }

    state.playoff.payoutSummary.forEach(item => {
        const resolvedAmount = item.manual_override && item.final_amount
            ? item.final_amount
            : item.final_amount || item.suggested_amount || 0;
        const card = document.createElement('div');
        card.className = 'flex items-center justify-between gap-4 rounded-3xl bg-slate-950/40 px-4 py-3';
        card.innerHTML = `
            <div>
                <p class="text-sm font-bold text-white">${escapeHtml(item.label || item.place_key)}</p>
                <p class="text-xs uppercase tracking-[0.2em] text-slate-400">${item.manual_override ? 'Manual override' : 'Suggested payout'}</p>
            </div>
            <p class="text-lg font-black text-white">${formatCurrency(resolvedAmount)}</p>
        `;
        container.appendChild(card);
    });
}

function renderStandingsTrend() {
    const container = byId('playoff-standings-trend');
    container.innerHTML = '';

    if (!state.playoff.standingsTrend.length || !state.playoff.rounds.length) {
        container.innerHTML = '<p class="text-sm text-slate-400">Trend data will appear once rounds have been scored.</p>';
        return;
    }

    const roundLabels = state.playoff.rounds.map(round => escapeHtml(round.name || `Round ${round.sort_order}`));
    container.innerHTML = `
        <div class="grid gap-3">
            ${state.playoff.standingsTrend.slice(0, 6).map(line => `
                <div class="rounded-3xl bg-slate-950/40 p-4">
                    <div class="mb-3 flex items-center justify-between gap-4">
                        <p class="text-sm font-bold text-white">${escapeHtml(line.display_name)}</p>
                        <p class="text-xs uppercase tracking-[0.2em] text-slate-400">${line.points.reduce((sum, value) => sum + Number(value || 0), 0)} total</p>
                    </div>
                    <div class="grid gap-2 ${roundLabels.length > 1 ? 'md:grid-cols-4' : ''}">
                        ${line.points.map((value, index) => `
                            <div class="rounded-2xl bg-white/5 px-3 py-2">
                                <p class="text-[11px] uppercase tracking-[0.18em] text-slate-400">${roundLabels[index]}</p>
                                <p class="mt-1 text-lg font-black text-white">${value}</p>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function renderPickDistribution() {
    const container = byId('playoff-pick-distribution');
    container.innerHTML = '';

    if (!isRoundRevealed(state.playoff.currentRound, state.playoff.pool)) {
        container.innerHTML = '<p class="text-sm text-slate-400">Pick distribution becomes visible after the current round locks.</p>';
        return;
    }

    if (!state.playoff.pickDistribution.length) {
        container.innerHTML = '<p class="text-sm text-slate-400">No revealed pick data is available for this round yet.</p>';
        return;
    }

    state.playoff.pickDistribution.forEach(item => {
        const winnerRows = Object.entries(item.winner_counts || {}).sort((left, right) => right[1] - left[1]);
        const gamesRows = Object.entries(item.games_counts || {}).filter(([, count]) => count > 0);
        const card = document.createElement('article');
        card.className = 'rounded-3xl border border-white/10 bg-slate-950/40 p-5';
        card.innerHTML = `
            <div class="mb-4">
                <p class="text-sm font-bold text-white">${escapeHtml(item.matchup_label)}</p>
                <p class="mt-1 text-xs uppercase tracking-[0.2em] text-slate-400">Current round revealed picks</p>
            </div>
            <div class="grid gap-4 md:grid-cols-2">
                <div>
                    <p class="mb-2 text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-300">Winner Split</p>
                    <div class="space-y-2">
                        ${winnerRows.length ? winnerRows.map(([label, count]) => distributionRow(label, count, state.playoff.roundPickDocs.length)).join('') : '<p class="text-sm text-slate-400">No winner picks yet.</p>'}
                    </div>
                </div>
                <div>
                    <p class="mb-2 text-[11px] font-bold uppercase tracking-[0.22em] text-sky-300">Games Split</p>
                    <div class="space-y-2">
                        ${gamesRows.length ? gamesRows.map(([label, count]) => distributionRow(`${label} games`, count, state.playoff.roundPickDocs.length)).join('') : '<p class="text-sm text-slate-400">No exact-games picks yet.</p>'}
                    </div>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

function renderPicksBoard() {
    const container = byId('picks-board-container');
    const note = byId('picks-board-note');
    container.innerHTML = '';

    if (!isRoundRevealed(state.playoff.currentRound, state.playoff.pool)) {
        note.textContent = 'Picks are hidden until the round locks.';
        container.innerHTML = '<p class="text-sm text-slate-400">The picks board becomes visible once the current round locks and picks are revealed.</p>';
        return;
    }

    const series = state.playoff.series;
    const pickDocs = state.playoff.roundPickDocs;
    const baseStandings = state.playoff.standings;

    if (!series.length || !pickDocs.length) {
        note.textContent = '';
        container.innerHTML = '<p class="text-sm text-slate-400">No revealed pick data is available for this round yet.</p>';
        return;
    }

    // Sort
    const sort = state.playoff.picksBoardSort || 'standings';
    let standings = [...baseStandings];
    if (sort === 'pts_asc') standings.sort((a, b) => (a.points_total || 0) - (b.points_total || 0));
    else if (sort === 'name_asc') standings.sort((a, b) => (a.team_name || a.display_name || '').localeCompare(b.team_name || b.display_name || ''));

    // Filter / compare
    const filter = state.playoff.picksBoardFilter;
    const filteredStandings = filter?.size ? standings.filter(m => filter.has(m.id)) : standings;

    note.textContent = `${filteredStandings.length}${filter?.size ? ` / ${standings.length}` : ''} members · ${series.length} series`;

    // Picks lookup
    const picksByUid = {};
    pickDocs.forEach(d => {
        const map = {};
        (d.entries || []).forEach(e => { map[e.series_id] = e; });
        picksByUid[d.id] = map;
    });
    const seriesById = Object.fromEntries(series.map(s => [s.id, s]));
    const flipped = state.playoff.picksBoardFlipped;

    // ── Controls ──────────────────────────────────────────────────────────
    const sortBtns = [['standings', 'Rank'], ['pts_asc', 'Pts ↑'], ['name_asc', 'Name']].map(([key, label]) =>
        `<button data-pb-sort="${escapeAttribute(key)}"
            class="px-2.5 py-1 rounded-lg text-[11px] font-semibold transition
                   ${sort === key ? 'bg-fuchsia-500/20 text-fuchsia-300 ring-1 ring-fuchsia-400/30' : 'text-slate-400 hover:text-white hover:bg-white/5'}">
            ${label}</button>`
    ).join('');

    const flipBtn = `<button data-pb-flip
        class="px-2.5 py-1 rounded-lg text-[11px] font-semibold transition
               ${flipped ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-400/30' : 'text-slate-400 hover:text-white hover:bg-white/5'}">
        ⇄ Flip</button>`;

    const memberChips = standings.map(m => {
        const sel = filter?.has(m.id);
        return `<button data-pb-filter="${escapeAttribute(m.id)}"
            class="px-2 py-0.5 rounded-md text-[10px] font-medium transition whitespace-nowrap
                   ${sel ? 'bg-fuchsia-500/20 text-fuchsia-300 ring-1 ring-fuchsia-400/30' : 'text-slate-600 hover:text-slate-300 hover:bg-white/5'}">
            ${escapeHtml(m.team_name || m.display_name || m.id)}</button>`;
    }).join('');

    const clearBtn = filter?.size
        ? `<button data-pb-filter-clear class="px-2 py-0.5 rounded-md text-[10px] text-slate-500 hover:text-white hover:bg-white/5 transition shrink-0">Clear ×</button>`
        : '';

    const controls = `
        <div class="mb-3 flex flex-wrap items-start gap-x-4 gap-y-2">
            <div class="flex items-center gap-1 shrink-0">
                <span class="text-[10px] text-slate-500 mr-0.5">Sort</span>
                ${sortBtns}
                <span class="mx-1 text-slate-700">|</span>
                ${flipBtn}
            </div>
            <div class="flex flex-wrap items-center gap-1 min-w-0">
                <span class="text-[10px] text-slate-500 mr-0.5 shrink-0">Compare</span>
                ${memberChips}
                ${clearBtn}
            </div>
        </div>`;

    // ── Cell builder ──────────────────────────────────────────────────────
    function buildCell(s, member) {
        const entry = (picksByUid[member.id] || {})[s.id];
        if (!entry?.winner_team_id)
            return `<td class="px-1.5 py-1 text-center"><span class="text-slate-600 text-xs">—</span></td>`;
        const teamId = entry.winner_team_id;
        const isHome = teamId === s.home_team_id;
        const logoUrl = isHome ? (s.home_team_logo_dark || s.home_team_logo_light || '') : (s.away_team_logo_dark || s.away_team_logo_light || '');
        const color = isHome ? (s.home_team_primary_color || '#0F172A') : (s.away_team_primary_color || '#0F172A');
        const games = entry.games || '?';
        const resultKnown = Boolean(seriesById[s.id]?.result_winner_team_id);
        const correct = resultKnown && teamId === seriesById[s.id].result_winner_team_id;
        const incorrect = resultKnown && !correct;
        const ring = correct ? 'ring-2 ring-emerald-400/60' : incorrect ? 'ring-2 ring-rose-400/40' : '';
        const bg = correct ? 'bg-emerald-400/10' : incorrect ? 'bg-rose-400/5' : '';
        return `<td class="px-1.5 py-1 text-center">
            <div class="inline-flex flex-col items-center gap-0.5 ${bg} rounded-xl px-1.5 py-1 ${ring}">
                <div class="h-10 w-10 flex items-center justify-center rounded-lg border border-black/10 p-1" style="background:${escapeAttribute(color)}">
                    <img src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(teamId)}" class="h-full w-full object-contain" loading="lazy">
                </div>
                <span class="text-[10px] font-bold text-slate-300 leading-none tabular-nums">${games}</span>
            </div>
        </td>`;
    }

    // ── Table ─────────────────────────────────────────────────────────────
    let tableHTML;
    if (!flipped) {
        // Members × Series
        const headerCells = series.map(s =>
            `<th class="min-w-[4.5rem] px-2 py-2 text-center text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400 whitespace-nowrap">
                ${escapeHtml(s.home_team_id)} <span class="text-slate-600">vs</span> ${escapeHtml(s.away_team_id)}
            </th>`
        ).join('');

        const rows = filteredStandings.map((member, idx) => {
            const isCurrentUser = member.id === state.authUser.uid;
            const rowCls = isCurrentUser ? 'border-b border-emerald-300/20 bg-emerald-400/5' : 'border-b border-white/5 hover:bg-white/5';
            const rank = sort === 'standings' ? (baseStandings.findIndex(m => m.id === member.id) + 1) : (idx + 1);
            return `<tr class="${rowCls} transition">
                <td class="sticky left-0 bg-slate-950 px-3 py-1.5 font-semibold text-sm text-white z-10 whitespace-nowrap">
                    <span class="mr-1.5 text-[10px] font-bold text-slate-500 tabular-nums w-4 inline-block text-right">${rank}</span>${escapeHtml(member.team_name || member.display_name || member.email || member.id)}
                </td>
                <td class="px-2 py-1.5 text-center text-sm font-semibold text-slate-300 tabular-nums">${member.points_total || 0}</td>
                ${series.map(s => buildCell(s, member)).join('')}
            </tr>`;
        }).join('');

        tableHTML = `
            <div class="overflow-x-auto rounded-[1.5rem] border border-white/10">
                <table class="w-full text-left min-w-max border-collapse">
                    <thead class="bg-slate-950/80">
                        <tr>
                            <th class="sticky left-0 bg-slate-950/90 px-3 py-2 z-10 text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">Member</th>
                            <th class="px-2 py-2 text-center text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500 min-w-[2.5rem]">Pts</th>
                            ${headerCells}
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    } else {
        // Series × Members (flipped)
        const memberHeaders = filteredStandings.map(m =>
            `<th class="min-w-[5rem] max-w-[7rem] px-2 py-2 text-center text-[10px] font-bold text-slate-400 leading-snug">
                ${escapeHtml(m.team_name || m.display_name || m.id)}
            </th>`
        ).join('');

        const rows = series.map(s => {
            return `<tr class="border-b border-white/5 hover:bg-white/5 transition">
                <td class="sticky left-0 bg-slate-950 px-3 py-1.5 z-10 whitespace-nowrap">
                    <span class="text-[11px] font-bold text-white">${escapeHtml(s.home_team_id)}</span>
                    <span class="text-[10px] text-slate-500 mx-1">vs</span>
                    <span class="text-[11px] font-bold text-white">${escapeHtml(s.away_team_id)}</span>
                </td>
                ${filteredStandings.map(m => buildCell(s, m)).join('')}
            </tr>`;
        }).join('');

        tableHTML = `
            <div class="overflow-x-auto rounded-[1.5rem] border border-white/10">
                <table class="w-full text-left min-w-max border-collapse">
                    <thead class="bg-slate-950/80">
                        <tr>
                            <th class="sticky left-0 bg-slate-950/90 px-3 py-2 z-10 text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">Series</th>
                            ${memberHeaders}
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    const legend = `
        <div class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-slate-500">
            <span class="inline-flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-full ring-2 ring-emerald-400/60 bg-emerald-400/10"></span>Correct</span>
            <span class="inline-flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-full ring-2 ring-rose-400/40 bg-rose-400/5"></span>Wrong</span>
            <span class="inline-flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-full bg-white/10"></span>Pending</span>
        </div>`;

    container.innerHTML = controls + tableHTML + legend;
}

// ── Sidebar: section visibility ──────────────────────────────────

function initSectionVisibility() {
    if (state.playoff.visibleSections) return; // already initialised this session
    try {
        const saved = JSON.parse(localStorage.getItem(LS_VISIBLE_KEY));
        if (saved && Array.isArray(saved)) {
            state.playoff.visibleSections = new Set(saved);
            return;
        }
    } catch {}
    state.playoff.visibleSections = new Set(SECTIONS_DEFAULT_ON);
}

function applyVisibleSections() {
    PLAYOFF_SECTIONS.forEach(({ key, sectionId }) => {
        byId(sectionId)?.classList.toggle('hidden', !state.playoff.visibleSections.has(key));
    });
    // Round recap section is controlled independently via renderRoundRecap
}

function toggleSection(key) {
    const vis = state.playoff.visibleSections;
    if (vis.has(key)) vis.delete(key); else vis.add(key);
    localStorage.setItem(LS_VISIBLE_KEY, JSON.stringify([...vis]));
    applyVisibleSections();
    renderSidebarSections();
}

function renderSidebar() {
    const pool = state.playoff.pool;
    const poolName = pool?.name || CONFIG.PLAYOFF_BRAND_NAME || '';
    const seasonLabel = pool?.season_label || '';
    byId('sidebar-pool-name').textContent = poolName;
    byId('sidebar-season-label').textContent = seasonLabel;
    byId('sidebar-pool-name-mobile').textContent = poolName;
    renderSidebarSections();
    renderSidebarRounds();
}

function renderSidebarSections() {
    const vis = state.playoff.visibleSections;
    byId('playoff-sidebar-sections').innerHTML = PLAYOFF_SECTIONS.map(({ key, label, icon }) => {
        const on = vis.has(key);
        return `<button data-toggle-section="${escapeAttribute(key)}"
            class="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-sm text-left transition
                   ${on ? 'bg-white/10 text-white font-semibold' : 'text-slate-400 hover:bg-white/5 hover:text-white'}">
            <span class="text-base leading-none w-5 shrink-0">${icon}</span>
            <span class="flex-1 truncate">${escapeHtml(label)}</span>
            <span class="text-[10px] font-bold tabular-nums shrink-0 ${on ? 'text-emerald-400' : 'text-slate-600'}">${on ? 'ON' : 'OFF'}</span>
        </button>`;
    }).join('');
}

function renderSidebarRounds() {
    const rounds = state.playoff.rounds || [];
    const currentRoundId = state.playoff.currentRound?.id;
    const currentRoundIdx = rounds.findIndex(r => r.id === currentRoundId);

    byId('playoff-sidebar-rounds').innerHTML = rounds.map((round, idx) => {
        const isCurrent = round.id === currentRoundId;
        const isFuture = !isCurrent && currentRoundIdx !== -1 && idx > currentRoundIdx;
        const icon = isFuture ? '🕐' : isCurrent ? '▶' : '✓';
        const cls = isFuture
            ? 'text-slate-600 cursor-default opacity-50'
            : isCurrent
                ? 'text-fuchsia-300 font-semibold bg-fuchsia-400/10 hover:bg-fuchsia-400/20'
                : 'text-slate-300 hover:bg-white/5 hover:text-white cursor-pointer';

        return `<button ${isFuture ? 'disabled' : `data-round-recap="${escapeAttribute(round.id)}"`}
            class="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-sm transition ${cls}">
            <span class="text-xs w-4 shrink-0">${icon}</span>
            <span class="truncate">${escapeHtml(round.name || round.id)}</span>
        </button>`;
    }).join('') || '<p class="px-3 text-xs text-slate-600">No rounds yet</p>';
}

async function renderRoundRecap(roundId) {
    const round = (state.playoff.rounds || []).find(r => r.id === roundId);
    if (!round) return;

    const section = byId('section-round-recap');
    section.classList.remove('hidden');
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const container = byId('round-recap-container');

    // Only show picks if the round is revealed (locked or explicitly complete).
    // A round with status 'open' hides all picks regardless of what Firestore contains.
    if (!isRoundRevealed(round, state.playoff.pool)) {
        container.innerHTML = `
            <div>
                <p class="text-xs font-bold uppercase tracking-[0.35em] text-amber-300">Round Recap</p>
                <h2 class="mt-2 text-3xl font-black text-white">${escapeHtml(round.name || round.id)}</h2>
                <p class="mt-4 text-sm text-slate-400">Picks for this round are hidden until it locks.</p>
            </div>`;
        return;
    }

    container.innerHTML = `<p class="text-sm text-slate-400 animate-pulse py-4">Loading ${escapeHtml(round.name || round.id)} recap…</p>`;

    const poolId = state.playoff.poolId;
    const isCurrent = round.id === state.playoff.currentRound?.id;

    const [picksSnap, seriesSnap] = await Promise.all([
        getDocs(collection(db, 'playoff_pools', poolId, 'rounds', roundId, 'picks')),
        isCurrent
            ? Promise.resolve(null)
            : getDocs(collection(db, 'playoff_pools', poolId, 'rounds', roundId, 'series')),
    ]);

    const allPickDocs = picksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const series = seriesSnap
        ? seriesSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        : state.playoff.series;

    container.innerHTML = buildRoundRecapHTML(round, series, allPickDocs);
}

function buildRoundRecapHTML(round, series, pickDocs) {
    const standings = state.playoff.standings;
    if (!series.length || !pickDocs.length) {
        return `<div>
            <p class="text-xs font-bold uppercase tracking-[0.35em] text-amber-300">Round Recap</p>
            <h2 class="mt-2 text-3xl font-black text-white">${escapeHtml(round.name || round.id)}</h2>
            <p class="mt-4 text-sm text-slate-400">No pick data is available for this round yet.</p>
        </div>`;
    }

    const lockDate = round.lock_at?.seconds ? formatDateTime({ seconds: round.lock_at.seconds, nanoseconds: 0 }) : '';

    const picksByUid = {};
    pickDocs.forEach(doc => {
        const map = {};
        (doc.entries || []).forEach(e => { map[e.series_id] = e; });
        picksByUid[doc.id] = map;
        picksByUid[doc.id]._roundTotal = doc.round_total || 0;
    });

    const seriesById = Object.fromEntries(series.map(s => [s.id, s]));

    const headerCells = series.map(s =>
        `<th class="min-w-[6rem] px-3 py-3 text-center">
            <p class="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 leading-tight">${escapeHtml(s.matchup_label || (s.home_team_id + ' vs ' + s.away_team_id))}</p>
        </th>`
    ).join('');

    // Build rows from standings order; include any pick doc UIDs not in standings
    const memberOrder = standings.length ? standings : pickDocs.map(d => ({ id: d.id }));
    const rows = memberOrder.map((member, index) => {
        const isCurrentUser = member.id === state.authUser?.uid;
        const rowClass = isCurrentUser
            ? 'border-b border-emerald-300/30 bg-emerald-400/10'
            : 'border-b border-white/10 hover:bg-white/5';
        const entryMap = picksByUid[member.id] || {};
        const roundPts = entryMap._roundTotal || 0;

        const cells = series.map(s => {
            const entry = entryMap[s.id];
            if (!entry || !entry.winner_team_id)
                return `<td class="px-3 py-3 text-center"><span class="text-xs text-slate-500">—</span></td>`;

            const teamId = entry.winner_team_id;
            const isHome = teamId === s.home_team_id;
            const logoUrl = isHome ? (s.home_team_logo_dark || s.home_team_logo_light || '') : (s.away_team_logo_dark || s.away_team_logo_light || '');
            const primaryColor = isHome ? (s.home_team_primary_color || '#0F172A') : (s.away_team_primary_color || '#0F172A');
            const games = entry.games || '?';
            const resultKnown = Boolean(seriesById[s.id]?.result_winner_team_id);
            const correct = resultKnown && teamId === seriesById[s.id].result_winner_team_id;
            const incorrect = resultKnown && !correct;
            const ringClass = correct ? 'ring-2 ring-emerald-400/60' : incorrect ? 'ring-2 ring-rose-400/40' : '';
            const bgTint = correct ? 'bg-emerald-400/10' : incorrect ? 'bg-rose-400/10' : '';

            return `<td class="px-3 py-3 text-center">
                <div class="inline-flex flex-col items-center gap-1 ${bgTint} rounded-[0.75rem] px-2 py-1.5 ${ringClass}">
                    <div class="h-8 w-8 flex items-center justify-center rounded-lg border border-black/10 p-1" style="background:${escapeAttribute(primaryColor)};">
                        <img src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(teamId)}" class="h-full w-full object-contain" loading="lazy">
                    </div>
                    <span class="text-[10px] font-bold text-slate-200">${escapeHtml(String(games))}</span>
                </div>
            </td>`;
        }).join('');

        return `<tr class="${rowClass} text-sm transition">
            <td class="sticky left-0 bg-slate-950 px-4 py-3 font-semibold text-white z-10 whitespace-nowrap">
                <span class="mr-2 text-[11px] font-bold text-slate-400">${index + 1}</span>${escapeHtml(member.team_name || member.display_name || member.email || member.id)}
            </td>
            <td class="px-3 py-3 text-center text-slate-300 font-semibold">${roundPts}</td>
            ${cells}
        </tr>`;
    }).join('');

    return `<div>
        <p class="text-xs font-bold uppercase tracking-[0.35em] text-amber-300">Round Recap</p>
        <div class="mt-2 flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
            <h2 class="text-3xl font-black text-white">${escapeHtml(round.name || round.id)}</h2>
            ${lockDate ? `<p class="text-sm text-slate-400">Locked ${lockDate}</p>` : ''}
        </div>
    </div>
    <div class="mt-6 overflow-x-auto rounded-[1.5rem] border border-white/10">
        <table class="w-full text-left min-w-max">
            <thead class="bg-slate-950/70 text-[11px] uppercase tracking-[0.22em] text-slate-400">
                <tr>
                    <th class="sticky left-0 bg-slate-950/90 px-4 py-3 z-10">Member</th>
                    <th class="px-3 py-3 text-center min-w-[3.5rem]">Pts</th>
                    ${headerCells}
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    </div>
    <div class="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-400">
        <span class="inline-flex items-center gap-2"><span class="inline-block h-3 w-3 rounded-full ring-2 ring-emerald-400/60 bg-emerald-400/10"></span>Correct</span>
        <span class="inline-flex items-center gap-2"><span class="inline-block h-3 w-3 rounded-full ring-2 ring-rose-400/40 bg-rose-400/10"></span>Incorrect</span>
        <span class="inline-flex items-center gap-2"><span class="inline-block h-3 w-3 rounded-full bg-white/10"></span>Pending</span>
    </div>`;
}

function renderPreviousPicks() {
    const container = byId('previous-picks');
    container.innerHTML = '';

    if (!state.playoff.previousPicks.length) {
        container.innerHTML = '<p class="text-sm text-slate-400">No saved picks from earlier rounds yet.</p>';
        return;
    }

    state.playoff.previousPicks.forEach(item => {
        const seriesById = Object.fromEntries((item.series || []).map(series => [series.id, series]));
        const card = document.createElement('article');
        card.className = 'rounded-3xl border border-white/10 bg-white/5 p-5';
        card.innerHTML = `
            <div class="mb-3 flex items-center justify-between gap-4">
                <h4 class="text-lg font-bold text-white">${item.round.name || item.round.id}</h4>
                <span class="text-xs uppercase tracking-[0.2em] text-slate-400">${item.pick.updated_at ? formatDate(item.pick.updated_at) : 'Saved'} • ${item.pick.round_total || 0} pts</span>
            </div>
            <div class="space-y-2 text-sm text-slate-300">
                ${(item.pick.entries || []).map(entry => `
                    <div class="flex items-center justify-between gap-3 rounded-2xl bg-slate-950/40 px-4 py-3">
                        <span>${escapeHtml(seriesById[entry.series_id]?.matchup_label || entry.series_id)}</span>
                        <span>${escapeHtml(buildCompactPickLabel(entry, seriesById[entry.series_id] || {})) || 'No saved pick'} • ${entry.series_points_total || 0} pts</span>
                    </div>
                `).join('')}
            </div>
        `;
        container.appendChild(card);
    });
}

function updatePlayoffDraft(seriesId, field, value) {
    const next = state.playoff.draft[seriesId] || {};
    next[field] = value;
    state.playoff.draft[seriesId] = next;
    renderSeriesCards();
}

function bindPlayoffEvents() {
    byId('playoff-submit-btn').addEventListener('click', submitPlayoffPicks);
    byId('playoff-team-name-input').addEventListener('input', event => {
        state.playoff.teamNameDraft = event.currentTarget.value;
        renderTeamNameEditor();
    });
    byId('playoff-team-name-save-btn').addEventListener('click', savePlayoffTeamName);
    byId('playoff-whatif-reset-btn').addEventListener('click', () => {
        state.playoff.scenarioDraft = buildScenarioDraft(state.playoff.series);
        renderScenarioLab();
    });

    // Mobile sidebar open/close
    byId('playoff-sidebar-open').addEventListener('click', () => {
        byId('playoff-sidebar').classList.remove('-translate-x-full');
        byId('playoff-sidebar-backdrop').classList.remove('hidden');
    });
    byId('playoff-sidebar-backdrop').addEventListener('click', () => {
        byId('playoff-sidebar').classList.add('-translate-x-full');
        byId('playoff-sidebar-backdrop').classList.add('hidden');
    });

    // Section toggle + round recap + picks board controls delegation
    document.addEventListener('click', e => {
        const toggleKey = e.target.closest('[data-toggle-section]')?.dataset.toggleSection;
        if (toggleKey) { toggleSection(toggleKey); return; }

        const recapRoundId = e.target.closest('[data-round-recap]')?.dataset.roundRecap;
        if (recapRoundId) { renderRoundRecap(recapRoundId); return; }

        const pbSort = e.target.closest('[data-pb-sort]')?.dataset.pbSort;
        if (pbSort) { state.playoff.picksBoardSort = pbSort; renderPicksBoard(); return; }

        const pbFilter = e.target.closest('[data-pb-filter]')?.dataset.pbFilter;
        if (pbFilter) {
            if (!state.playoff.picksBoardFilter) state.playoff.picksBoardFilter = new Set();
            const f = state.playoff.picksBoardFilter;
            if (f.has(pbFilter)) f.delete(pbFilter); else f.add(pbFilter);
            renderPicksBoard();
            return;
        }

        if (e.target.closest('[data-pb-filter-clear]')) { state.playoff.picksBoardFilter = null; renderPicksBoard(); return; }
        if (e.target.closest('[data-pb-flip]')) { state.playoff.picksBoardFlipped = !state.playoff.picksBoardFlipped; renderPicksBoard(); return; }

        const timelineNav = e.target.closest('[data-timeline-nav]')?.dataset.timelineNav;
        if (timelineNav) {
            const K = (state.playoff.eventHistory || []).length;
            state.playoff.timelineIndex = Math.max(0, Math.min(K - 1, state.playoff.timelineIndex + Number(timelineNav)));
            renderStandingsHistory();
            return;
        }
        const timelineJump = e.target.closest('[data-timeline-jump]')?.dataset.timelineJump;
        if (timelineJump !== undefined) {
            state.playoff.timelineIndex = Number(timelineJump);
            renderStandingsHistory();
            return;
        }
        const chartType = e.target.closest('[data-chart-type]')?.dataset.chartType;
        if (chartType) { state.playoff.chartType = chartType; renderStandingsHistory(); return; }
    });
}

async function savePlayoffTeamName() {
    if (!state.playoff.pool || !state.playoff.member) return;
    if (isTeamNameLockedForMember()) {
        showToast('Round 1 is locked, so team names are now read-only.', 'error');
        return;
    }

    const nextTeamName = normalizeTeamNameValue(state.playoff.teamNameDraft);
    if (!nextTeamName) {
        showToast('Enter a team name before saving.', 'error');
        return;
    }

    const previousTeamName = state.playoff.member?.team_name || '';
    const previousHistory = Array.isArray(state.playoff.member?.team_name_history)
        ? [...state.playoff.member.team_name_history]
        : [];
    const normalizedPrevious = normalizeTeamNameComparison(previousTeamName);
    const normalizedNext = normalizeTeamNameComparison(nextTeamName);
    const nextHistory = normalizedPrevious !== normalizedNext
        ? [
            ...previousHistory,
            {
                team_name: nextTeamName,
                changed_at: new Date().toISOString(),
                source: 'portal'
            }
        ]
        : previousHistory;

    await setDoc(doc(db, 'playoff_pools', state.playoff.poolId, 'members', state.authUser.uid), {
        team_name: nextTeamName,
        team_name_history: nextHistory,
        updated_at: new Date().toISOString()
    }, { merge: true });

    state.playoff.member = normalizePlayoffMember({
        ...state.playoff.member,
        team_name: nextTeamName,
        team_name_history: nextHistory,
        updated_at: new Date().toISOString()
    }, state.playoff.pool);
    state.playoff.teamNameDraft = nextTeamName;
    state.playoff.standings = sortStandings(state.playoff.standings.map(member => (
        member.id === state.authUser.uid
            ? normalizePlayoffMember({
                ...member,
                team_name: nextTeamName,
                team_name_history: nextHistory,
                updated_at: new Date().toISOString()
            }, state.playoff.pool)
            : member
    )));
    renderPlayoffApp();
    showToast('Team name saved');
}

async function submitPlayoffPicks() {
    if (!state.playoff.pool || !state.playoff.currentRound) return;
    if (state.playoff.isLocked) {
        showToast('This round is locked', 'error');
        return;
    }

    if (!normalizeTeamNameValue(state.playoff.member?.team_name || '')) {
        showToast('Save your team name before saving picks.', 'error');
        return;
    }

    if (!isTeamNameLockedForMember() && isTeamNameDirty()) {
        showToast('Save your team name change before saving picks.', 'error');
        return;
    }

    const now = new Date().toISOString();
    const entries = state.playoff.series.map(series => {
        const seriesLocked = isSeriesLocked(series);
        // For locked series, preserve the existing saved pick rather than overwriting with draft
        const existingEntry = seriesLocked
            ? state.playoff.currentPick?.entries?.find(e => e.series_id === series.id)
            : null;
        return {
            series_id: series.id,
            winner_team_id: existingEntry?.winner_team_id || state.playoff.draft[series.id]?.winner_team_id || '',
            games: Number(existingEntry?.games || state.playoff.draft[series.id]?.games || 0),
            submitted_at: existingEntry?.submitted_at || now,
            updated_at: now,
            winner_points_awarded: existingEntry?.winner_points_awarded || 0,
            games_points_awarded: existingEntry?.games_points_awarded || 0,
            series_points_total: existingEntry?.series_points_total || 0,
            winner_eligibility: existingEntry?.winner_eligibility ?? true,
            games_eligibility: existingEntry?.games_eligibility ?? true,
            eligibility_reason: existingEntry?.eligibility_reason || ''
        };
    });

    // Only require picks for series that aren't individually locked
    const invalid = entries.some(entry => {
        const series = state.playoff.series.find(s => s.id === entry.series_id);
        if (series && isSeriesLocked(series)) return false; // locked series don't need a pick
        return !entry.winner_team_id || !entry.games;
    });
    if (invalid) {
        showToast('Complete all open series picks before saving', 'error');
        return;
    }

    const pickRef = doc(db, 'playoff_pools', state.playoff.poolId, 'rounds', state.playoff.currentRound.id, 'picks', state.authUser.uid);
    await setDoc(pickRef, {
        pool_id: state.playoff.poolId,
        round_id: state.playoff.currentRound.id,
        entries,
        submitted_at: state.playoff.currentPick?.submitted_at || new Date().toISOString(),
        updated_at: now,
        team_name: state.playoff.member?.team_name || '',
        round_total: state.playoff.currentPick?.round_total || 0
    }, { merge: true });

    showToast('Playoff picks saved');
    await loadPlayoffApp();
}

function buildPayoutStatusText() {
    const currentMember = state.playoff.member || {};
    if (currentMember.payout_amount) {
        return `${currentMember.payout_place || 'Payout'}: ${formatCurrency(currentMember.payout_amount)}`;
    }

    if (state.playoff.payment?.eligible_for_payout || currentMember.eligible_for_payout) {
        return 'Eligible for payout once final standings are locked.';
    }

    return 'Not currently marked as payout-eligible.';
}

function distributionRow(label, count, total) {
    const width = total ? Math.max(8, Math.round((count / total) * 100)) : 0;
    return `
        <div class="rounded-2xl bg-white/5 px-3 py-2">
            <div class="mb-1 flex items-center justify-between gap-3 text-xs text-slate-200">
                <span>${escapeHtml(label)}</span>
                <span>${count}</span>
            </div>
            <div class="h-2 rounded-full bg-white/10">
                <div class="h-2 rounded-full bg-emerald-400" style="width:${width}%"></div>
            </div>
        </div>
    `;
}

function prettifyStatus(value) {
    return String(value || '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
}

function formatCurrency(value) {
    return `${CONFIG.CURRENCY_SYMBOL}${Number(value || 0).toFixed(2)}`;
}

function formatDateTime(value) {
    if (!value) {
        return 'TBD';
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return formatDate(value);
    }

    return new Intl.DateTimeFormat('en-CA', {
        dateStyle: 'medium',
        timeStyle: 'short'
    }).format(parsed);
}

function ordinal(value) {
    const safeValue = Number(value || 0);
    const remainder100 = safeValue % 100;
    if (remainder100 >= 11 && remainder100 <= 13) {
        return `${safeValue}th`;
    }

    switch (safeValue % 10) {
    case 1:
        return `${safeValue}st`;
    case 2:
        return `${safeValue}nd`;
    case 3:
        return `${safeValue}rd`;
    default:
        return `${safeValue}th`;
    }
}

function escapeAttribute(value) {
    return String(value || '').replace(/"/g, '&quot;');
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
