import { CONFIG } from './config.js?v=20260419-sidebar';
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
} from './app-model.js?v=20260419-sidebar';
import {
    buildCompactPickLabel,
    buildDraftFromEntries,
    buildPickDistribution,
    buildStandingsTrend,
    computeCollectedPot,
    isRoundLocked,
    isRoundRevealed,
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
} from './playoff-logic.js?v=20260419-sidebar';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import {
    createUserWithEmailAndPassword,
    getAuth,
    onAuthStateChanged,
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
        visibleSections: null
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

function getSelectedRegistrationAppId() {
    return byId('register-app-id').value || APP_IDS.PLAYOFF;
}

function setSelectedRegistrationApp(appId) {
    const selectedAppId = appId === APP_IDS.STRONG8K ? APP_IDS.STRONG8K : APP_IDS.PLAYOFF;
    byId('register-app-id').value = selectedAppId;
    byId('register-playoff-app-btn').className = selectedAppId === APP_IDS.PLAYOFF
        ? 'rounded-2xl border border-emerald-400 bg-emerald-50 px-4 py-3 text-left transition hover:border-emerald-600'
        : 'rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-slate-900';
    byId('register-strong8k-app-btn').className = selectedAppId === APP_IDS.STRONG8K
        ? 'rounded-2xl border border-slate-900 bg-slate-100 px-4 py-3 text-left transition hover:border-slate-900'
        : 'rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-slate-900';
    const needsInvite = selectedAppId === APP_IDS.STRONG8K;
    byId('reg-code-wrap').classList.toggle('hidden', !needsInvite);
    byId('reg-code').required = needsInvite;
    byId('register-submit-btn').textContent = needsInvite ? 'Create Strong8K Access' : 'Create Playoff Access';
    updateAuthBlurb();
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
        visibleSections: null
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
        await ensureDefaultPlayoffAccess(user);
        await routeAuthenticatedUser();
    } catch (error) {
        handlePortalLoadError(error);
    }
}

async function ensureDefaultPlayoffAccess(user) {
    if (!user || !canSelfServePlayoff()) {
        return;
    }

    if (state.accessibleApps[APP_IDS.PLAYOFF]?.status === 'active') {
        return;
    }

    try {
        await ensurePlayoffSelfServeAccess(user.uid, user.email);
        await hydrateSession(user);
    } catch (error) {
        console.warn('Playoff self-serve bootstrap skipped during session hydration.', error);
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

function canSelfServePlayoff() {
    const playoffMembership = state.memberships[APP_IDS.PLAYOFF];
    return !playoffMembership || playoffMembership.status !== 'disabled';
}

async function routeAuthenticatedUser() {
    const activeMemberships = getActiveMemberships();
    const pendingMemberships = getPendingMemberships();
    const requestedAppId = currentHashApp();
    const wantsAppSwitcher = isAppsHomeRoute();

    if (requestedAppId === APP_IDS.PLAYOFF && !activeMemberships[APP_IDS.PLAYOFF] && canSelfServePlayoff()) {
        await ensurePlayoffSelfServeAccess(state.authUser.uid, state.authUser.email);
        await hydrateSession(state.authUser);
        await openApp(APP_IDS.PLAYOFF);
        return;
    }

    if (requestedAppId && activeMemberships[requestedAppId]) {
        await openApp(requestedAppId);
        return;
    }

    const appIds = Object.keys(activeMemberships);
    if (wantsAppSwitcher && (appIds.length || canSelfServePlayoff())) {
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

    if (canSelfServePlayoff()) {
        renderAppSwitcher(activeMemberships);
        setView('app-switcher-view');
        return;
    }

    renderNoAccess(pendingMemberships);
    setView('no-access-view');
}

function handlePortalLoadError(error) {
    console.error('Portal load failed', error);
    if (state.authUser?.email) {
        byId('no-access-email').textContent = state.authUser.email;
    }

    const activeMemberships = getActiveMemberships();
    if (state.authUser && (Object.keys(activeMemberships).length || canSelfServePlayoff())) {
        renderAppSwitcher(activeMemberships);
        setView('app-switcher-view');
        showToast(error?.message || 'Portal load failed', 'error');
        return;
    }

    byId('no-access-message').textContent = 'We could not load this portal view. Try signing out and back in, or contact Elliot if it keeps happening.';
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
        if (!state.accessibleApps[APP_IDS.PLAYOFF] && canSelfServePlayoff()) {
            await ensurePlayoffSelfServeAccess(state.authUser.uid, state.authUser.email);
            await hydrateSession(state.authUser);
        }
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
        updateAuthBlurb();
    });

    byId('show-login-link').addEventListener('click', event => {
        event.preventDefault();
        byId('register-form').classList.add('hidden');
        byId('login-form').classList.remove('hidden');
    });

    byId('register-playoff-app-btn').addEventListener('click', () => setSelectedRegistrationApp(APP_IDS.PLAYOFF));
    byId('register-strong8k-app-btn').addEventListener('click', () => setSelectedRegistrationApp(APP_IDS.STRONG8K));
    byId('reg-code').addEventListener('input', updateAuthBlurb);

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
        const selectedAppId = getSelectedRegistrationAppId();
        const inviteCode = byId('reg-code').value.trim();
        const resolvedInviteAppId = inviteCode ? resolveInviteCode(inviteCode) : null;

        if (selectedAppId === APP_IDS.STRONG8K && resolvedInviteAppId !== APP_IDS.STRONG8K) {
            showToast('Invalid invite code', 'error');
            return;
        }

        try {
            const credential = await createUserWithEmailAndPassword(auth, email, password);
            await claimOrCreateAccount({
                uid: credential.user.uid,
                email,
                appId: selectedAppId,
                inviteCode: selectedAppId === APP_IDS.STRONG8K ? inviteCode : 'self-serve'
            });
            showToast(`${APP_DEFINITIONS[selectedAppId].shortLabel} access created`);
        } catch (error) {
            showToast(error.message, 'error');
        }
    });

    setSelectedRegistrationApp(APP_IDS.PLAYOFF);
    updateAuthBlurb();
}

function updateAuthBlurb() {
    const helper = byId('auth-helper-text');
    if (byId('register-form').classList.contains('hidden')) {
        helper.textContent = 'Sign in to switch apps, or create a new playoff account in one step.';
        return;
    }

    const selectedAppId = getSelectedRegistrationAppId();
    if (selectedAppId === APP_IDS.PLAYOFF) {
        helper.textContent = 'Playoff Pool is open registration. Create your account and you will be added right away.';
        return;
    }

    const code = byId('reg-code').value.trim();
    const inviteAppId = resolveInviteCode(code);
    helper.textContent = inviteAppId === APP_IDS.STRONG8K
        ? `This code will create access for ${APP_DEFINITIONS[inviteAppId].authTitle}.`
        : 'Strong8K still requires a valid invite code.';
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
    byId('no-access-home-btn').addEventListener('click', async () => {
        window.location.hash = '#/apps';
        try {
            await routeAuthenticatedUser();
        } catch (error) {
            handlePortalLoadError(error);
        }
    });

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

    if (!activeMemberships[APP_IDS.PLAYOFF]) {
        const joinCard = document.createElement('button');
        joinCard.className = 'group rounded-3xl border border-emerald-200 bg-emerald-50 p-6 text-left shadow-sm transition hover:-translate-y-1 hover:border-emerald-600 hover:shadow-xl';
        joinCard.innerHTML = `
            <div class="mb-4 flex items-center justify-between">
                <span class="rounded-full bg-emerald-100 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.25em] text-emerald-700">Open Pool</span>
                <i class="fa-solid fa-hockey-puck text-emerald-300 transition group-hover:text-emerald-700"></i>
            </div>
            <h3 class="text-2xl font-bold text-slate-950">${APP_DEFINITIONS[APP_IDS.PLAYOFF].authTitle}</h3>
            <p class="mt-3 text-sm leading-6 text-slate-600">Enter the only active playoff pool, get the payment and deadline details, and start making picks right away.</p>
        `;
        joinCard.addEventListener('click', async () => {
            try {
                await ensurePlayoffSelfServeAccess(state.authUser.uid, state.authUser.email);
                await hydrateSession(state.authUser);
                window.location.hash = APP_DEFINITIONS[APP_IDS.PLAYOFF].route;
                await openApp(APP_IDS.PLAYOFF);
            } catch (error) {
                handlePortalLoadError(error);
            }
        });
        container.appendChild(joinCard);
    }
}

function renderNoAccess(pendingMemberships) {
    const pendingApps = Object.keys(pendingMemberships);
    byId('no-access-message').textContent = pendingApps.length
        ? `Your ${pendingApps.map(appId => APP_DEFINITIONS[appId].shortLabel).join(' / ')} access is not active yet.`
        : 'This account does not have an active app membership yet. If you want in on the playoff pool, open All Apps and enter the live pool there.';
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
    if (canSelfServePlayoff()) {
        await ensurePlayoffSelfServeAccess(state.authUser.uid, state.authUser.email);
        await hydrateSession(state.authUser);
    }

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

    const previousPicks = [];
    for (const round of rounds) {
        if (!currentRound || round.id === currentRound.id) continue;
        const previousSeriesSnap = await getDocs(query(collection(db, 'playoff_pools', poolId, 'rounds', round.id, 'series'), orderBy('sort_order')));
        const previousSeries = previousSeriesSnap.docs.map(item => normalizePlayoffSeries({ id: item.id, ...item.data() }));
        const pickSnap = await getDoc(doc(db, 'playoff_pools', poolId, 'rounds', round.id, 'picks', state.authUser.uid));
        if (pickSnap.exists()) {
            previousPicks.push({
                round,
                series: previousSeries,
                pick: scorePickDocument(normalizePickDoc(pickSnap.data()), previousSeries, round)
            });
        }
    }

    let roundPickDocs = [];
    if (currentRoundId && isRoundRevealed(currentRound, pool)) {
        const roundPicksSnap = await getDocs(collection(db, 'playoff_pools', poolId, 'rounds', currentRoundId, 'picks'));
        roundPickDocs = roundPicksSnap.docs.map(item => normalizePickDoc({ id: item.id, ...item.data() }));
    }

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
    state.playoff.payoutSummary = payoutSummary;
    state.playoff.pickDistribution = buildPickDistribution(series, roundPickDocs);
    state.playoff.standingsTrend = buildStandingsTrend(rounds, standings);
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
    byId('playoff-live-scoreboard-note').textContent = buildLiveScoreboardNote();
    byId('playoff-rules-content').innerHTML = buildPoolRulesMarkup();
    byId('playoff-payment-instructions').textContent = buildPaymentInstructions();
    byId('playoff-payment-link').href = buildPlayoffPaymentLink();

    renderTeamNameEditor();
    renderSeriesCards();
    renderStandings();
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
                    return `
                        <article class="rounded-[1.75rem] border border-white/10 bg-slate-950/35 p-5">
                            <div class="mb-4 flex items-start justify-between gap-4">
                                <div>
                                    <p class="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-400">${escapeHtml(series.matchup_label || `Series ${series.sort_order || ''}`)}</p>
                                    <h4 class="mt-2 text-xl font-black text-white">${escapeHtml((series.home_team_name || series.home_team_id) + ' vs ' + (series.away_team_name || series.away_team_id))}</h4>
                                </div>
                                <span class="rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold uppercase text-slate-200">${escapeHtml(series.status || 'Open')}</span>
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
        button.disabled = state.playoff.isLocked;
        button.addEventListener('click', event => updatePlayoffDraft(event.currentTarget.dataset.seriesId, 'winner_team_id', event.currentTarget.dataset.teamId));
    });
    container.querySelectorAll('.pick-games-option').forEach(button => {
        button.disabled = state.playoff.isLocked;
        button.addEventListener('click', event => updatePlayoffDraft(event.currentTarget.dataset.seriesId, 'games', event.currentTarget.dataset.games));
    });

    submitButton.disabled = state.playoff.isLocked || !hasReadyTeamNameForPicks();
    roundMessage.textContent = state.playoff.isLocked
        ? 'This round is locked. Your latest saved picks are shown below.'
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

function buildLiveScoreboardNote() {
    if (!state.playoff.currentRound) {
        return 'No round is active yet.';
    }

    return isRoundRevealed(state.playoff.currentRound, state.playoff.pool)
        ? 'This board reflects the saved pool totals and updates when results are rescored.'
        : 'This board shows official saved totals. Use the what-if lab below for your own projections before picks unlock.';
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


function renderStandings() {
    const tbody = byId('standings-body');
    tbody.innerHTML = '';

    state.playoff.standings.forEach((member, index) => {
        const row = document.createElement('tr');
        row.className = member.id === state.authUser.uid
            ? 'border-b border-emerald-300/30 bg-emerald-400/10 text-sm'
            : 'border-b border-white/10 text-sm';
        row.innerHTML = `
            <td class="px-4 py-3 text-slate-300">${index + 1}</td>
            <td class="px-4 py-3 font-semibold text-white">${escapeHtml(member.team_name || member.display_name || member.email || member.id)}</td>
            <td class="px-4 py-3 text-slate-200">${member.points_total || 0}</td>
            <td class="px-4 py-3 text-slate-400">${member.round_points || 0}</td>
        `;
        tbody.appendChild(row);
    });
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
    const standings = state.playoff.standings;

    if (!series.length || !pickDocs.length) {
        note.textContent = '';
        container.innerHTML = '<p class="text-sm text-slate-400">No revealed pick data is available for this round yet.</p>';
        return;
    }

    note.textContent = `${standings.length} members · ${series.length} series`;

    const picksByUid = {};
    pickDocs.forEach(pickDoc => {
        const map = {};
        (pickDoc.entries || []).forEach(e => { map[e.series_id] = e; });
        picksByUid[pickDoc.id] = map;
    });

    const seriesById = Object.fromEntries(series.map(s => [s.id, s]));

    const headerCells = series.map(s =>
        `<th class="min-w-[7rem] px-3 py-3 text-center">
            <p class="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400 leading-tight">${escapeHtml(s.matchup_label || (s.home_team_id + ' vs ' + s.away_team_id))}</p>
        </th>`
    ).join('');

    const rows = standings.map((member, index) => {
        const isCurrentUser = member.id === state.authUser.uid;
        const rowClass = isCurrentUser
            ? 'border-b border-emerald-300/30 bg-emerald-400/10'
            : 'border-b border-white/10 hover:bg-white/5';
        const entryMap = picksByUid[member.id] || {};

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
                <div class="inline-flex flex-col items-center gap-1.5 ${bgTint} rounded-[1rem] px-2 py-2 ${ringClass}">
                    <div class="h-9 w-9 flex items-center justify-center rounded-xl border border-black/10 p-1.5" style="background:${escapeAttribute(primaryColor)};">
                        <img src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(teamId)}" class="h-full w-full object-contain" loading="lazy">
                    </div>
                    <span class="text-[11px] font-bold text-slate-200">${games}</span>
                </div>
            </td>`;
        }).join('');

        return `<tr class="${rowClass} text-sm transition">
            <td class="sticky left-0 bg-slate-950 px-4 py-3 font-semibold text-white z-10 whitespace-nowrap">
                <span class="mr-2 text-[11px] font-bold text-slate-400">${index + 1}</span>${escapeHtml(member.team_name || member.display_name || member.email || member.id)}
            </td>
            <td class="px-3 py-3 text-center text-slate-300">${member.points_total || 0}</td>
            ${cells}
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div class="overflow-x-auto rounded-[1.5rem] border border-white/10">
            <table class="w-full text-left min-w-max">
                <thead class="bg-slate-950/70 text-[11px] uppercase tracking-[0.22em] text-slate-400">
                    <tr>
                        <th class="sticky left-0 bg-slate-950/90 px-4 py-3 z-10">Member</th>
                        <th class="px-3 py-3 text-center min-w-[4rem]">Pts</th>
                        ${headerCells}
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div class="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-400">
            <span class="inline-flex items-center gap-2"><span class="inline-block h-3 w-3 rounded-full ring-2 ring-emerald-400/60 bg-emerald-400/10"></span>Correct pick</span>
            <span class="inline-flex items-center gap-2"><span class="inline-block h-3 w-3 rounded-full ring-2 ring-rose-400/40 bg-rose-400/10"></span>Incorrect pick</span>
            <span class="inline-flex items-center gap-2"><span class="inline-block h-3 w-3 rounded-full bg-white/10"></span>Result pending</span>
        </div>`;
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
    const now = Date.now();

    byId('playoff-sidebar-rounds').innerHTML = rounds.map(round => {
        const lockMs = round.lock_at?.seconds ? round.lock_at.seconds * 1000 : 0;
        const isCurrent = round.id === currentRoundId;
        const isFuture = !isCurrent && lockMs > now;
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

    // Section toggle + round recap delegation
    document.addEventListener('click', e => {
        const toggleKey = e.target.closest('[data-toggle-section]')?.dataset.toggleSection;
        if (toggleKey) { toggleSection(toggleKey); return; }
        const recapRoundId = e.target.closest('[data-round-recap]')?.dataset.roundRecap;
        if (recapRoundId) renderRoundRecap(recapRoundId);
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
    const entries = state.playoff.series.map(series => ({
        series_id: series.id,
        winner_team_id: state.playoff.draft[series.id]?.winner_team_id || '',
        games: Number(state.playoff.draft[series.id]?.games || 0),
        submitted_at: now,
        updated_at: now,
        winner_points_awarded: 0,
        games_points_awarded: 0,
        series_points_total: 0,
        winner_eligibility: true,
        games_eligibility: true,
        eligibility_reason: ''
    }));

    const invalid = entries.some(entry => !entry.winner_team_id || !entry.games);
    if (invalid) {
        showToast('Complete every series pick before saving', 'error');
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
