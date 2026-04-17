import { CONFIG } from './config.js?v=20260416-bracket-ui';
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
} from './app-model.js?v=20260416-bracket-ui';
import {
    buildCompactPickLabel,
    buildDraftFromEntries,
    buildPickDistribution,
    buildStandingsTrend,
    computeCollectedPot,
    defaultPaymentRecord,
    defaultPlayoffMember,
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
} from './playoff-logic.js?v=20260416-bracket-ui';
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
        draft: {},
        isLocked: false
    }
};

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
        draft: {},
        isLocked: false
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
    const q = query(collection(db, 'users'), where('email', '==', email));
    const results = await getDocs(q);
    const existingDoc = results.docs.find(item => item.id !== uid) || null;

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
                <div class="grid gap-2 text-xs text-slate-500">
                    <div class="flex items-center justify-between gap-3">
                        <span class="font-bold uppercase tracking-[0.2em] text-slate-400">Server</span>
                        <button type="button" class="font-mono text-slate-700 hover:text-slate-950" data-copy="${escapeAttribute(domain)}">${domain}</button>
                    </div>
                    ${backup ? `
                        <div class="flex items-center justify-between gap-3">
                            <span class="font-bold uppercase tracking-[0.2em] text-slate-400">Backup</span>
                            <button type="button" class="font-mono text-slate-700 hover:text-slate-950" data-copy="${escapeAttribute(backup)}">${backup}</button>
                        </div>
                    ` : ''}
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
    state.playoff.draft = buildDraftFromEntries(currentPick?.entries || []);
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
    const memberSnap = await getDoc(memberRef);
    const existingMember = memberSnap.exists()
        ? normalizePlayoffMember({ id: uid, ...memberSnap.data() }, pool)
        : defaultPlayoffMember({
            id: uid,
            full_name: sharedUser.full_name,
            email
        }, pool);
    await setDoc(memberRef, {
        ...existingMember,
        uid,
        display_name: existingMember.display_name || sharedUser.full_name || email.split('@')[0],
        email
    }, { merge: true });

    const paymentRef = doc(db, 'playoff_pools', pool.id, 'payments', uid);
    const paymentSnap = await getDoc(paymentRef);
    const existingPayment = paymentSnap.exists()
        ? paymentSnap.data()
        : defaultPaymentRecord(uid, pool);
    await setDoc(paymentRef, {
        ...existingPayment,
        member_uid: uid,
        amount_due: Number(existingPayment.amount_due ?? pool.entry_fee_default ?? 0)
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
    byId('pool-description').textContent = state.playoff.pool.description || 'Round-by-round NHL playoff picks.';
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
    byId('playoff-guide-steps').innerHTML = buildPlayoffGuideSteps();
    byId('playoff-payment-instructions').textContent = buildPaymentInstructions();
    byId('playoff-payment-link').href = buildPlayoffPaymentLink();
    byId('playoff-deadline-detail').textContent = buildDeadlineInstructions();
    byId('playoff-guide-note').textContent = buildPlayoffGuideNote();

    renderSeriesCards();
    renderStandings();
    renderPayoutSummary();
    renderStandingsTrend();
    renderPickDistribution();
    renderPreviousPicks();
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

    state.playoff.series.forEach(series => {
        const saved = state.playoff.draft[series.id] || {};
        const savedEntry = state.playoff.currentPick?.entries?.find(entry => entry.series_id === series.id) || null;
        const winnerChoice = saved.winner_team_id || '';
        const card = document.createElement('article');
        card.className = 'rounded-[2rem] border border-white/10 bg-gradient-to-br from-white/10 to-white/5 p-5 shadow-[0_24px_60px_rgba(2,6,23,0.18)]';
        card.innerHTML = `
            <div class="mb-4 flex items-start justify-between gap-4">
                <div>
                    <p class="text-[11px] font-bold uppercase tracking-[0.25em] text-emerald-300">${series.conference || series.matchup_label || `Series ${series.sort_order || ''}`}</p>
                    <h3 class="mt-2 text-xl font-bold text-white">${series.home_team_name || series.home_team_id} vs ${series.away_team_name || series.away_team_id}</h3>
                    <p class="mt-2 text-sm text-slate-300">${series.notes || 'Click a logo to choose the winner, then lock in the exact series length.'}</p>
                </div>
                <span class="rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold uppercase text-slate-200">${series.status || 'Open'}</span>
            </div>
            <div class="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
                <div>
                    <span class="mb-3 block text-[11px] font-bold uppercase tracking-[0.22em] text-slate-300">Winner</span>
                    <div class="grid gap-3 sm:grid-cols-2">
                        ${buildWinnerOptionMarkup(series, 'home', winnerChoice)}
                        ${buildWinnerOptionMarkup(series, 'away', winnerChoice)}
                    </div>
                </div>
                <div>
                    <span class="mb-3 block text-[11px] font-bold uppercase tracking-[0.22em] text-slate-300">Games</span>
                    <div class="grid grid-cols-2 gap-3">
                        ${[4, 5, 6, 7].map(games => `
                            <button type="button" class="${String(saved.games) === String(games)
                                ? 'series-games-option rounded-2xl border border-amber-300 bg-amber-300/15 px-4 py-4 text-left text-white shadow-[0_0_0_1px_rgba(252,211,77,0.25)]'
                                : 'series-games-option rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-4 text-left text-slate-200 transition hover:border-amber-300/60 hover:bg-slate-900'}" data-series-id="${series.id}" data-games="${games}">
                                <span class="block text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Exact Length</span>
                                <span class="mt-2 block text-2xl font-black">${games}</span>
                                <span class="mt-1 block text-xs uppercase tracking-[0.18em] text-slate-400">Games</span>
                            </button>
                        `).join('')}
                    </div>
                </div>
            </div>
            ${savedEntry ? `
                <div class="mt-4 rounded-2xl bg-slate-950/40 px-4 py-3 text-xs text-slate-300">
                    <div class="flex flex-wrap items-center justify-between gap-3">
                        <span>Winner pts: ${savedEntry.winner_points_awarded || 0}</span>
                        <span>Games pts: ${savedEntry.games_points_awarded || 0}</span>
                        <span>Total: ${savedEntry.series_points_total || 0}</span>
                    </div>
                    ${savedEntry.eligibility_reason ? `<p class="mt-2 text-[11px] uppercase tracking-[0.2em] text-amber-300">Override: ${escapeHtml(savedEntry.eligibility_reason)}</p>` : ''}
                </div>
            ` : ''}
        `;
        container.appendChild(card);
    });

    container.querySelectorAll('.series-team-option').forEach(button => {
        button.disabled = state.playoff.isLocked;
        button.addEventListener('click', event => updatePlayoffDraft(event.currentTarget.dataset.seriesId, 'winner_team_id', event.currentTarget.dataset.teamId));
    });
    container.querySelectorAll('.series-games-option').forEach(button => {
        button.disabled = state.playoff.isLocked;
        button.addEventListener('click', event => updatePlayoffDraft(event.currentTarget.dataset.seriesId, 'games', event.currentTarget.dataset.games));
    });

    submitButton.disabled = state.playoff.isLocked;
    roundMessage.textContent = state.playoff.isLocked
        ? 'This round is locked. Your latest saved picks are shown below.'
        : 'Click a team logo, choose 4 to 7 games, and save before the deadline.';
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

function buildPlayoffGuideSteps() {
    const deadlineValue = state.playoff.currentRound?.lock_at || state.playoff.currentRound?.pick_deadline || '';
    const deadlineLabel = deadlineValue ? formatDateTime(deadlineValue) : 'the posted deadline';
    return `
        <div class="space-y-3 text-sm leading-6 text-slate-200">
            <p><span class="font-bold text-white">1.</span> Click one logo in every series to choose your winner.</p>
            <p><span class="font-bold text-white">2.</span> Choose the exact series length from 4 to 7 games.</p>
            <p><span class="font-bold text-white">3.</span> Save everything before ${escapeHtml(deadlineLabel)}.</p>
        </div>
    `;
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

function buildDeadlineInstructions() {
    const deadlineValue = state.playoff.currentRound?.lock_at || state.playoff.currentRound?.pick_deadline || '';
    if (!deadlineValue) {
        return 'The next pick deadline has not been posted yet.';
    }

    const revealLine = isRoundRevealed(state.playoff.currentRound, state.playoff.pool)
        ? 'Picks for this round are already revealed.'
        : 'Everyone’s picks stay hidden until the round locks.';
    return `Submit your ${state.playoff.currentRound?.name || 'current round'} picks by ${formatDateTime(deadlineValue)}. ${revealLine}`;
}

function buildPlayoffGuideNote() {
    const poolDescription = state.playoff.pool?.description?.trim();
    if (poolDescription) {
        return poolDescription;
    }

    return 'You are automatically added to the live pool as soon as you open it. Set your team name, pay in, and keep your picks saved before lock.';
}

function buildWinnerOptionMarkup(series, side, selectedTeamId) {
    const isHome = side === 'home';
    const teamId = isHome ? (series.home_team_id || series.home_team_name) : (series.away_team_id || series.away_team_name);
    const teamName = isHome ? (series.home_team_name || series.home_team_id) : (series.away_team_name || series.away_team_id);
    const seedLabel = isHome ? series.home_team_seed_label : series.away_team_seed_label;
    const logoUrl = isHome
        ? (series.home_team_logo_dark || series.home_team_logo_light || '')
        : (series.away_team_logo_dark || series.away_team_logo_light || '');
    const isSelected = selectedTeamId === teamId;
    return `
        <button type="button" class="${isSelected
            ? 'series-team-option group rounded-[1.6rem] border border-emerald-300 bg-emerald-400/15 p-4 text-left shadow-[0_0_0_1px_rgba(110,231,183,0.28)]'
            : 'series-team-option group rounded-[1.6rem] border border-white/10 bg-slate-950/65 p-4 text-left transition hover:border-emerald-300/60 hover:bg-slate-900'}" data-series-id="${series.id}" data-team-id="${teamId}">
            <div class="flex items-center gap-4">
                <div class="flex h-16 w-16 items-center justify-center rounded-2xl border ${isSelected ? 'border-emerald-300/50 bg-white/95' : 'border-white/10 bg-white/90'} p-2 shadow-sm">
                    <img src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(teamName)} logo" class="h-full w-full object-contain">
                </div>
                <div class="min-w-0">
                    <span class="inline-flex rounded-full ${isSelected ? 'bg-emerald-300/20 text-emerald-200' : 'bg-white/10 text-slate-300'} px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em]">${escapeHtml(seedLabel || 'Pick')}</span>
                    <p class="mt-3 text-lg font-black text-white">${escapeHtml(teamName)}</p>
                    <p class="mt-1 text-xs uppercase tracking-[0.18em] ${isSelected ? 'text-emerald-200' : 'text-slate-400'}">${escapeHtml(teamId)}</p>
                </div>
            </div>
        </button>
    `;
}

function renderStandings() {
    const tbody = byId('standings-body');
    tbody.innerHTML = '';

    state.playoff.standings.forEach((member, index) => {
        const row = document.createElement('tr');
        row.className = 'border-b border-white/10 text-sm';
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
}

async function submitPlayoffPicks() {
    if (!state.playoff.pool || !state.playoff.currentRound) return;
    if (state.playoff.isLocked) {
        showToast('This round is locked', 'error');
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
