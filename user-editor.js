import {
    defaultSharedUser,
    escapeHtml,
    formatDate,
    normalizeStrong8kProfile,
    parseDelimitedList
} from './app-model.js?v=20261027-user-workspace';
import {
    addDoc,
    collection,
    deleteField,
    doc,
    getDoc,
    getDocs,
    query,
    runTransaction,
    setDoc,
    updateDoc,
    where
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const PROFILE_ROUTE = /^#people\/([^/]+)$/;
const SUPPORT_KINDS = {
    setup: 'Setup',
    troubleshooting: 'Troubleshooting',
    renewal: 'Renewal',
    communication: 'Communication',
    other: 'Other'
};

export function createUserEditor({
    db,
    auth,
    state,
    showToast,
    copyTextToClipboard,
    reloadAdminData,
    syncMembership,
    syncPoolMembers,
    appIds
}) {
    const local = {
        activeUserId: '',
        expandedLicenseId: '',
        supportEvents: [],
        privateNotes: '',
        accessBaseline: '',
        pendingLicensePatches: {},
        autosave: {
            queue: Promise.resolve(),
            timers: new Map(),
            scheduled: new Map(),
            pending: 0,
            failed: null
        }
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function bind() {
        byId('new-user-btn')?.addEventListener('click', openNewUserModal);
        byId('new-user-close')?.addEventListener('click', closeNewUserModal);
        byId('new-user-cancel')?.addEventListener('click', closeNewUserModal);
        byId('new-user-form')?.addEventListener('submit', createUserShell);
        byId('new-user-modal')?.addEventListener('click', event => {
            if (event.target === byId('new-user-modal')) closeNewUserModal();
        });
        byId('new-user-modal')?.addEventListener('keydown', trapModalFocus);

        byId('user-workspace-back')?.addEventListener('click', navigateToPeople);
        byId('user-autosave-retry')?.addEventListener('click', retryFailedSave);
        byId('archive-user-btn')?.addEventListener('click', archiveActiveUser);
        byId('add-license-btn')?.addEventListener('click', openNewLicenseForm);
        byId('new-license-cancel')?.addEventListener('click', closeNewLicenseForm);
        byId('new-license-form')?.addEventListener('submit', createLicense);
        byId('user-license-list')?.addEventListener('click', handleLicenseClick);
        byId('user-license-list')?.addEventListener('input', handleLicenseInput);
        byId('user-license-list')?.addEventListener('change', handleLicenseInput);

        byId('support-event-add-btn')?.addEventListener('click', openSupportEventForm);
        byId('support-event-cancel')?.addEventListener('click', closeSupportEventForm);
        byId('support-event-form')?.addEventListener('submit', createSupportEvent);

        document.querySelectorAll('[data-user-field]').forEach(field => {
            field.addEventListener('input', scheduleUserSave);
            field.addEventListener('change', scheduleUserSave);
        });
        document.querySelectorAll('[data-profile-field]').forEach(field => {
            field.addEventListener('input', scheduleProfileSave);
            field.addEventListener('change', scheduleProfileSave);
        });
        document.querySelectorAll('[data-private-field]').forEach(field => {
            field.addEventListener('input', schedulePrivateSave);
        });

        const accessControls = [
            'member-strong8k-enabled',
            'member-strong8k-role',
            'member-strong8k-status',
            'member-playoff-enabled',
            'member-playoff-role',
            'member-playoff-status'
        ];
        accessControls.forEach(id => byId(id)?.addEventListener('change', updateAccessDraft));
        byId('member-playoff-pools')?.addEventListener('change', updateAccessDraft);
        byId('user-access-apply')?.addEventListener('click', applyAccessChanges);
        byId('private-notes-migration-btn')?.addEventListener('click', migrateAllPrivateNotes);

        window.addEventListener('hashchange', runRouteChange);
        window.addEventListener('beforeunload', event => {
            if (!hasUnsettledSaves()) return;
            event.preventDefault();
            event.returnValue = '';
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !byId('new-user-modal')?.hasAttribute('hidden')) {
                closeNewUserModal();
            }
        });
    }

    function handleDataLoaded() {
        runRouteChange();
    }

    function open(userId) {
        if (!userId) return;
        const nextHash = `#people/${encodeURIComponent(userId)}`;
        if (window.location.hash === nextHash) {
            showUserWorkspace(userId).catch(reportWorkspaceError);
            return;
        }
        window.location.hash = nextHash;
    }

    function runRouteChange() {
        handleRouteChange().catch(reportWorkspaceError);
    }

    function reportWorkspaceError(error) {
        console.error('Unable to open the customer workspace', error);
        showToast(error?.message || 'The customer workspace could not be opened.', 'error');
    }

    async function handleRouteChange() {
        const match = window.location.hash.match(PROFILE_ROUTE);
        if (!match) {
            if (local.activeUserId) {
                await flushAutosaves();
                if (local.autosave.failed && !window.confirm('A profile change could not be saved. Leave the profile anyway?')) {
                    window.location.hash = `#people/${encodeURIComponent(local.activeUserId)}`;
                    return;
                }
            }
            showDashboard();
            return;
        }

        const userId = decodeURIComponent(match[1]);
        if (!state.users.length) return;
        await showUserWorkspace(userId);
    }

    function showDashboard() {
        local.activeUserId = '';
        local.expandedLicenseId = '';
        byId('user-workspace')?.classList.add('hidden');
        byId('admin-page-header')?.classList.remove('hidden');
        const activeTab = document.querySelector('[data-tab].is-active')?.dataset.tab || 'platform';
        document.querySelectorAll('[data-admin-dashboard]').forEach(section => {
            if (section.matches('[data-panel]')) {
                section.classList.toggle('hidden', section.dataset.panel !== activeTab);
            } else {
                section.classList.remove('hidden');
            }
        });
        document.title = "Operations | Elliot's Private Clubhouse";
    }

    async function showUserWorkspace(userId) {
        const user = state.users.find(item => item.id === userId);
        if (!user) {
            showToast('That customer profile could not be found.', 'error');
            window.location.hash = '#people';
            return;
        }

        if (local.activeUserId && local.activeUserId !== userId) {
            await flushAutosaves();
            if (local.autosave.failed && !window.confirm('A profile change could not be saved. Open another profile anyway?')) {
                window.location.hash = `#people/${encodeURIComponent(local.activeUserId)}`;
                return;
            }
        }

        local.activeUserId = userId;
        local.expandedLicenseId = '';
        local.pendingLicensePatches = {};
        resetAutosaveState();

        document.querySelectorAll('[data-admin-dashboard]').forEach(section => section.classList.add('hidden'));
        byId('admin-page-header')?.classList.add('hidden');
        byId('user-workspace')?.classList.remove('hidden');
        document.title = `${user.full_name || user.email || 'Customer'} | Operations`;
        window.scrollTo({ top: 0, behavior: 'auto' });

        const profile = normalizeStrong8kProfile(state.strong8kProfiles[userId] || {}, user);
        try {
            state.currentLicenses = await ensureStableLicenseIds(userId, profile);
        } catch (error) {
            console.error('Unable to verify stable license IDs', error);
            state.currentLicenses = profile.licenses.map(license => ({
                ...license,
                id: license.id || crypto.randomUUID()
            }));
            showToast('Licenses are visible, but edits may fail until the connection recovers.', 'error');
        }
        profile.licenses = state.currentLicenses;
        state.strong8kProfiles[userId] = profile;
        const supportContext = await loadSupportContext(user);
        local.privateNotes = supportContext.privateNotes;
        local.supportEvents = supportContext.events;

        populateWorkspace(user, profile);
        renderLicenses();
        renderSupportTimeline();
        renderAccessEditor(user);
        closeNewLicenseForm();
        closeSupportEventForm();
    }

    function populateWorkspace(user, profile) {
        byId('user-id').value = user.id;
        byId('user-workspace-title').textContent = user.full_name || user.email || 'Customer profile';
        byId('user-workspace-email').textContent = user.email || 'No email saved';
        byId('user-full-name').value = user.full_name || '';
        byId('user-email').value = user.email || '';
        byId('user-default-app').value = user.default_app_id || '';
        byId('strong8k-domain').value = profile.domain_8k || '';
        byId('strong8k-backup-domain').value = profile.domain_8k_backup || '';
        byId('strong8k-credits').value = Number(profile.credits_allocated || 0);
        byId('strong8k-live').value = (profile.live_preferences || []).join(', ');
        byId('strong8k-vod').value = (profile.vod_preferences || []).join(', ');
        byId('strong8k-custom-request').value = profile.custom_request || '';
        byId('strong8k-setup-notes').value = profile.setup_notes || '';
        byId('strong8k-internal-notes').value = local.privateNotes || '';
        renderMembershipStrip(user.id);
    }

    function renderMembershipStrip(userId) {
        const memberships = state.membershipsByUser[userId] || {};
        const definitions = [
            { id: appIds.STRONG8K, label: 'Strong8K' },
            { id: appIds.PLAYOFF, label: 'Playoff Pool' }
        ];
        byId('user-membership-strip').innerHTML = definitions.map(item => {
            const membership = memberships[item.id];
            const status = membership?.status || 'none';
            const statusClass = status === 'active'
                ? 'is-active'
                : status === 'pending'
                    ? 'is-pending'
                    : status === 'disabled'
                        ? 'is-disabled'
                        : '';
            return `<span class="user-membership-chip ${statusClass}">${escapeHtml(item.label)}: ${escapeHtml(status)}</span>`;
        }).join('');
    }

    async function ensureStableLicenseIds(userId, profile) {
        let resolvedLicenses = profile.licenses.map(license => ({ ...license }));
        await runTransaction(db, async transaction => {
            const profileRef = doc(db, 'strong8k_profiles', userId);
            const snapshot = await transaction.get(profileRef);
            const savedLicenses = snapshot.exists() && Array.isArray(snapshot.data().licenses)
                ? snapshot.data().licenses
                : profile.licenses;
            resolvedLicenses = savedLicenses.map(license => ({ ...license, id: license.id || crypto.randomUUID() }));
            const needsWrite = !snapshot.exists() || savedLicenses.some(license => !license.id);
            if (needsWrite && resolvedLicenses.length) {
                transaction.set(profileRef, {
                    licenses: resolvedLicenses,
                    updated_at: new Date().toISOString()
                }, { merge: true });
            }
        });
        return resolvedLicenses;
    }

    function profileIdsForUser(user) {
        return [...new Set([user.id, user.legacy_account_id].filter(Boolean))];
    }

    async function loadSupportContext(user) {
        const profileIds = profileIdsForUser(user);
        const legacyNotes = [];
        let incomplete = false;
        for (const profileId of profileIds) {
            const profile = state.strong8kProfiles[profileId];
            if (profile?.internal_notes) {
                legacyNotes.push(String(profile.internal_notes).trim());
                try {
                    await migrateLegacyPrivateNote(profileId, profile.internal_notes);
                    delete profile.internal_notes;
                } catch (error) {
                    incomplete = true;
                    console.error(`Private note migration deferred for ${profileId}`, error);
                }
            }
        }

        const privateSnapshots = await Promise.all(profileIds.map(async profileId => {
            try {
                return await getDoc(doc(db, 'strong8k_private', profileId));
            } catch (error) {
                incomplete = true;
                console.error(`Unable to load private notes for ${profileId}`, error);
                return null;
            }
        }));
        const privateValues = privateSnapshots
            .filter(Boolean)
            .filter(snapshot => snapshot.exists() && String(snapshot.data().internal_notes || '').trim())
            .map(snapshot => String(snapshot.data().internal_notes).trim())
            .filter((value, index, values) => values.indexOf(value) === index);
        legacyNotes.forEach(note => {
            if (note && !privateValues.some(value => value.includes(note))) privateValues.push(note);
        });
        const privateNotes = privateValues.join('\n\n');

        const eventSnapshots = await Promise.all(profileIds.map(async profileId => {
            try {
                return await getDocs(collection(db, 'strong8k_profiles', profileId, 'support_events'));
            } catch (error) {
                incomplete = true;
                console.error(`Unable to load support history for ${profileId}`, error);
                return null;
            }
        }));
        const events = [];
        eventSnapshots.forEach((snapshot, index) => {
            if (!snapshot) return;
            snapshot.forEach(item => events.push({
                id: item.id,
                profile_id: profileIds[index],
                ...item.data()
            }));
        });
        events.sort((left, right) => String(right.occurred_at || right.created_at || '').localeCompare(String(left.occurred_at || left.created_at || '')));
        if (incomplete) {
            showToast('Some private notes or support history could not be loaded. You can keep working and retry later.', 'error');
        }
        return { privateNotes, events };
    }

    function scheduleUserSave() {
        const userId = local.activeUserId;
        if (!userId) return;
        const emailInput = byId('user-email');
        if (!emailInput.checkValidity()) {
            setAutosaveStatus('error', 'Check email', false);
            return;
        }

        const user = state.users.find(item => item.id === userId);
        if (user) {
            user.full_name = byId('user-full-name').value.trim();
            user.email = emailInput.value.trim().toLowerCase();
            user.default_app_id = byId('user-default-app').value;
            byId('user-workspace-title').textContent = user.full_name || user.email || 'Customer profile';
            byId('user-workspace-email').textContent = user.email || 'No email saved';
        }

        scheduleAutosave(`user:${userId}`, async () => {
            await setDoc(doc(db, 'users', userId), {
                full_name: byId('user-full-name').value.trim(),
                email: byId('user-email').value.trim().toLowerCase(),
                default_app_id: byId('user-default-app').value,
                updated_at: new Date().toISOString()
            }, { merge: true });
        });
    }

    function scheduleProfileSave() {
        const userId = local.activeUserId;
        if (!userId) return;
        const profile = state.strong8kProfiles[userId] || normalizeStrong8kProfile({}, {});
        Object.assign(profile, collectProfileFields());
        state.strong8kProfiles[userId] = profile;

        scheduleAutosave(`profile:${userId}`, async () => {
            await setDoc(doc(db, 'strong8k_profiles', userId), {
                ...collectProfileFields(),
                updated_at: new Date().toISOString()
            }, { merge: true });
        });
    }

    function collectProfileFields() {
        return {
            domain_8k: byId('strong8k-domain').value.trim(),
            domain_8k_backup: byId('strong8k-backup-domain').value.trim(),
            credits_allocated: Number(byId('strong8k-credits').value || 0),
            live_preferences: parseDelimitedList(byId('strong8k-live').value),
            vod_preferences: parseDelimitedList(byId('strong8k-vod').value),
            custom_request: byId('strong8k-custom-request').value,
            setup_notes: byId('strong8k-setup-notes').value
        };
    }

    function schedulePrivateSave() {
        const userId = local.activeUserId;
        if (!userId) return;
        local.privateNotes = byId('strong8k-internal-notes').value;
        scheduleAutosave(`private:${userId}`, async () => {
            await setDoc(doc(db, 'strong8k_private', userId), {
                internal_notes: byId('strong8k-internal-notes').value,
                updated_at: new Date().toISOString(),
                updated_by: auth.currentUser?.uid || ''
            }, { merge: true });
        });
    }

    function scheduleAutosave(key, writer) {
        const existingTimer = local.autosave.timers.get(key);
        if (existingTimer) window.clearTimeout(existingTimer);
        local.autosave.scheduled.set(key, writer);
        setAutosaveStatus('saving', 'Waiting to save');
        const timer = window.setTimeout(() => {
            local.autosave.timers.delete(key);
            local.autosave.scheduled.delete(key);
            enqueueSave(key, writer);
        }, 700);
        local.autosave.timers.set(key, timer);
    }

    function enqueueSave(key, writer) {
        local.autosave.pending += 1;
        local.autosave.failed = null;
        setAutosaveStatus('saving', 'Saving');
        const operation = local.autosave.queue.then(writer);
        local.autosave.queue = operation.catch(() => {});
        operation
            .then(() => {
                local.autosave.pending -= 1;
                refreshAutosaveStatus();
            })
            .catch(error => {
                console.error(`Autosave failed for ${key}`, error);
                local.autosave.pending -= 1;
                local.autosave.failed = { key, writer };
                setAutosaveStatus('error', 'Could not save', true);
            });
        return operation;
    }

    function refreshAutosaveStatus() {
        if (local.autosave.failed) {
            setAutosaveStatus('error', 'Could not save', true);
            return;
        }
        if (local.autosave.pending || local.autosave.scheduled.size) {
            setAutosaveStatus('saving', 'Saving');
            return;
        }
        setAutosaveStatus('saved', 'Saved');
    }

    function setAutosaveStatus(status, label, canRetry = false) {
        const container = byId('user-autosave-status');
        if (!container) return;
        container.dataset.state = status;
        byId('user-autosave-label').textContent = label;
        byId('user-autosave-icon').className = status === 'error'
            ? 'fa-solid fa-circle-exclamation'
            : status === 'saving'
                ? 'fa-solid fa-rotate fa-spin'
                : 'fa-solid fa-circle-check';
        byId('user-autosave-retry').classList.toggle('hidden', !canRetry);
    }

    function resetAutosaveState() {
        local.autosave.timers.forEach(timer => window.clearTimeout(timer));
        local.autosave.timers.clear();
        local.autosave.scheduled.clear();
        local.autosave.pending = 0;
        local.autosave.failed = null;
        local.autosave.queue = Promise.resolve();
        setAutosaveStatus('saved', 'Saved');
    }

    async function retryFailedSave() {
        const failed = local.autosave.failed;
        if (!failed) return;
        local.autosave.failed = null;
        try {
            await enqueueSave(failed.key, failed.writer);
        } catch (error) {
            showToast('The profile change still could not be saved.', 'error');
        }
    }

    async function flushAutosaves() {
        const scheduled = [...local.autosave.scheduled.entries()];
        local.autosave.timers.forEach(timer => window.clearTimeout(timer));
        local.autosave.timers.clear();
        local.autosave.scheduled.clear();
        scheduled.forEach(([key, writer]) => enqueueSave(key, writer));
        await local.autosave.queue;
    }

    function hasUnsettledSaves() {
        return Boolean(local.autosave.pending || local.autosave.scheduled.size || local.autosave.failed);
    }

    function renderLicenses() {
        const container = byId('user-license-list');
        const licenses = state.currentLicenses || [];
        if (!licenses.length) {
            container.innerHTML = `
                <div class="user-license-empty">
                    <strong>No Strong8K license is saved yet.</strong>
                    <p>Add the purchased line after payment and provider details have been confirmed.</p>
                </div>`;
            return;
        }

        container.innerHTML = licenses.map(license => {
            const presentation = licensePresentation(license);
            const isEditing = local.expandedLicenseId === license.id;
            const paidSummary = [license.package_name, license.price_paid ? `Paid ${license.price_paid}` : '', license.date_paid ? formatDate(license.date_paid) : ''].filter(Boolean).join(' / ') || 'No package or payment details';
            return `
                <article class="user-license ${isEditing ? 'is-editing' : ''}" data-license-id="${escapeAttribute(license.id)}" style="--license-accent:${presentation.accent}">
                    <div class="user-license-summary">
                        <div>
                            <div class="user-license-name">${escapeHtml(license.label || 'Strong8K license')}</div>
                            <div class="user-license-meta mt-1">${escapeHtml(paidSummary)} / ${escapeHtml(String(Number(license.credits || 0)))} credits</div>
                            <span class="user-license-status mt-2 ${presentation.className}">${escapeHtml(presentation.label)}</span>
                        </div>
                        <div><div class="user-license-meta">Username</div><div class="user-license-value">${escapeHtml(license.username_8k || 'Missing')}</div></div>
                        <div><div class="user-license-meta">License password</div><div class="user-license-value">${escapeHtml(license.password_8k || 'Missing')}</div></div>
                        <div><div class="user-license-meta">Expiry</div><div class="user-license-value">${escapeHtml(formatDate(license.expiry_date))}</div></div>
                        <div class="user-license-actions">
                            <button type="button" data-license-copy-all="${escapeAttribute(license.id)}" aria-label="Copy all credentials"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>
                            <button type="button" data-license-edit="${escapeAttribute(license.id)}" aria-label="${isEditing ? 'Close' : 'Edit'} license"><i class="fa-solid ${isEditing ? 'fa-chevron-up' : 'fa-pen'}" aria-hidden="true"></i></button>
                            <button type="button" data-license-remove="${escapeAttribute(license.id)}" aria-label="Remove license"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
                        </div>
                    </div>
                    <div class="grid gap-2 px-3 pt-4 md:grid-cols-2">
                        ${licenseCopyRow('M3U URL', license.m3u_url_8k)}
                        ${licenseCopyRow('EPG URL', license.epg_url_8k)}
                        ${licenseCopyRow('EPGenius URL', license.epgenius_url)}
                        ${licenseCopyRow('EPGenius key', license.epgenius_key)}
                    </div>
                    <div class="user-license-editor">
                        <div class="user-license-grid">
                            ${licenseInput('Label', 'label', license.label)}
                            ${licenseSelect('Status', 'status', license.status || 'Active', ['Active', 'Trial', 'Expired', 'Banned'])}
                            ${licenseInput('Expiry', 'expiry_date', license.expiry_date, 'date')}
                            ${licenseInput('Username', 'username_8k', license.username_8k)}
                            ${licenseInput('License password', 'password_8k', license.password_8k)}
                            ${licenseInput('Credits', 'credits', Number(license.credits || 0), 'number')}
                            ${licenseInput('Package', 'package_name', license.package_name)}
                            ${licenseInput('Price paid', 'price_paid', license.price_paid)}
                            ${licenseInput('Date paid', 'date_paid', license.date_paid, 'date')}
                            ${licenseInput('M3U URL', 'm3u_url_8k', license.m3u_url_8k, 'url', 'is-wide')}
                            ${licenseInput('EPG URL', 'epg_url_8k', license.epg_url_8k, 'url')}
                            ${licenseInput('EPGenius key', 'epgenius_key', license.epgenius_key)}
                            ${licenseInput('EPGenius URL', 'epgenius_url', license.epgenius_url, 'url', 'is-wide')}
                        </div>
                        <p class="user-license-validation" data-license-validation="${escapeAttribute(license.id)}"></p>
                    </div>
                </article>`;
        }).join('');
    }

    function licenseCopyRow(label, value) {
        if (!String(value || '').trim()) return '';
        return `
            <button type="button" class="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left" data-license-copy-value="${escapeAttribute(value)}">
                <span class="min-w-0"><span class="block text-[11px] font-bold text-slate-500">${escapeHtml(label)}</span><span class="block break-all font-mono text-xs text-slate-800">${escapeHtml(value)}</span></span>
                <i class="fa-regular fa-copy shrink-0 text-xs text-slate-400" aria-hidden="true"></i>
            </button>`;
    }

    function licenseInput(label, field, value, type = 'text', extraClass = '') {
        return `<label class="${extraClass}"><span class="user-profile-field-label">${escapeHtml(label)}</span><input type="${escapeAttribute(type)}" class="user-profile-field" value="${escapeAttribute(value ?? '')}" data-license-field="${escapeAttribute(field)}"></label>`;
    }

    function licenseSelect(label, field, value, options) {
        return `<label><span class="user-profile-field-label">${escapeHtml(label)}</span><select class="user-profile-field" data-license-field="${escapeAttribute(field)}">${options.map(option => `<option value="${escapeAttribute(option)}" ${option === value ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select></label>`;
    }

    function licensePresentation(license = {}) {
        const status = String(license.status || '').trim().toLowerCase();
        const expiryValue = String(license.expiry_date || '').slice(0, 10);
        const expiry = /^\d{4}-\d{2}-\d{2}$/.test(expiryValue) ? new Date(`${expiryValue}T00:00:00`) : null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const daysRemaining = expiry ? Math.ceil((expiry.getTime() - today.getTime()) / 86400000) : null;
        if (status === 'expired' || (daysRemaining !== null && daysRemaining < 0)) {
            return { label: 'Expired', className: 'bg-rose-100 text-rose-800', accent: '#e11d48' };
        }
        if (daysRemaining !== null && daysRemaining <= 30) {
            return { label: `${Math.max(daysRemaining, 0)} days left`, className: 'bg-amber-100 text-amber-900', accent: '#d97706' };
        }
        if (status === 'active') {
            return { label: 'Active', className: 'bg-emerald-100 text-emerald-800', accent: '#10b981' };
        }
        return { label: license.status || 'Status unknown', className: 'bg-slate-100 text-slate-700', accent: '#94a3b8' };
    }

    async function handleLicenseClick(event) {
        const copyButton = event.target.closest('[data-license-copy-value]');
        if (copyButton) {
            await copyValue(copyButton.dataset.licenseCopyValue);
            return;
        }

        const copyAllButton = event.target.closest('[data-license-copy-all]');
        if (copyAllButton) {
            const license = state.currentLicenses.find(item => item.id === copyAllButton.dataset.licenseCopyAll);
            if (!license) return;
            const lines = [
                license.label ? `Label: ${license.label}` : '',
                license.username_8k ? `Username: ${license.username_8k}` : '',
                license.password_8k ? `Password: ${license.password_8k}` : '',
                license.m3u_url_8k ? `M3U: ${license.m3u_url_8k}` : '',
                license.epg_url_8k ? `EPG: ${license.epg_url_8k}` : '',
                license.epgenius_url ? `EPGenius: ${license.epgenius_url}` : '',
                license.expiry_date ? `Expiry: ${license.expiry_date}` : ''
            ].filter(Boolean);
            await copyValue(lines.join('\n'));
            return;
        }

        const editButton = event.target.closest('[data-license-edit]');
        if (editButton) {
            local.expandedLicenseId = local.expandedLicenseId === editButton.dataset.licenseEdit ? '' : editButton.dataset.licenseEdit;
            renderLicenses();
            return;
        }

        const removeButton = event.target.closest('[data-license-remove]');
        if (removeButton) await removeLicense(removeButton.dataset.licenseRemove);
    }

    async function copyValue(value) {
        try {
            await copyTextToClipboard(value || '');
            showToast('Copied to clipboard');
        } catch (error) {
            console.error('Unable to copy license value', error);
            showToast('Copy failed. Select the value and copy it manually.', 'error');
        }
    }

    function handleLicenseInput(event) {
        const input = event.target.closest('[data-license-field]');
        if (!input) return;
        const card = input.closest('[data-license-id]');
        const licenseId = card?.dataset.licenseId;
        const license = state.currentLicenses.find(item => item.id === licenseId);
        if (!license) return;
        const field = input.dataset.licenseField;
        const value = field === 'credits' ? Number(input.value || 0) : input.value;
        license[field] = value;
        local.pendingLicensePatches[licenseId] = {
            ...(local.pendingLicensePatches[licenseId] || {}),
            [field]: value
        };

        const validation = validateLicense(license);
        const validationNode = card.querySelector('[data-license-validation]');
        if (validationNode) validationNode.textContent = validation;
        if (validation) {
            setAutosaveStatus('error', 'Fix license fields', false);
            return;
        }

        let retryPatch = null;
        scheduleAutosave(`license:${licenseId}`, async () => {
            if (!retryPatch) {
                retryPatch = { ...(local.pendingLicensePatches[licenseId] || {}) };
                delete local.pendingLicensePatches[licenseId];
            }
            await patchLicense(local.activeUserId, licenseId, retryPatch);
            retryPatch = null;
        });
    }

    function validateLicense(license) {
        const missing = [
            !String(license.username_8k || '').trim() ? 'username' : '',
            !String(license.password_8k || '').trim() ? 'license password' : '',
            !String(license.expiry_date || '').trim() ? 'expiry' : ''
        ].filter(Boolean);
        return missing.length ? `Required: ${missing.join(', ')}.` : '';
    }

    async function patchLicense(userId, licenseId, patch) {
        if (!Object.keys(patch).length) return;
        await runTransaction(db, async transaction => {
            const profileRef = doc(db, 'strong8k_profiles', userId);
            const snapshot = await transaction.get(profileRef);
            const licenses = snapshot.exists() && Array.isArray(snapshot.data().licenses)
                ? snapshot.data().licenses
                : [];
            const index = licenses.findIndex(license => license.id === licenseId);
            if (index < 0) throw new Error('The license no longer exists. Reload the profile and try again.');
            licenses[index] = { ...licenses[index], ...patch };
            transaction.set(profileRef, { licenses, updated_at: new Date().toISOString() }, { merge: true });
        });
    }

    function openNewLicenseForm() {
        const form = byId('new-license-form');
        form.hidden = false;
        form.reset();
        byId('new-license-status').value = 'Active';
        byId('new-license-credits').value = '0';
        byId('new-license-error').textContent = '';
        byId('new-license-label').focus({ preventScroll: true });
        window.requestAnimationFrame(() => scrollEditorFormIntoView(form));
    }

    function closeNewLicenseForm() {
        const form = byId('new-license-form');
        if (!form) return;
        form.hidden = true;
        form.reset();
        byId('new-license-error').textContent = '';
    }

    async function createLicense(event) {
        event.preventDefault();
        const license = {
            id: crypto.randomUUID(),
            label: byId('new-license-label').value.trim(),
            status: byId('new-license-status').value,
            expiry_date: byId('new-license-expiry').value,
            username_8k: byId('new-license-username').value.trim(),
            password_8k: byId('new-license-password').value,
            credits: Number(byId('new-license-credits').value || 0),
            package_name: byId('new-license-package').value.trim(),
            price_paid: byId('new-license-price').value.trim(),
            date_paid: byId('new-license-date-paid').value,
            m3u_url_8k: byId('new-license-m3u').value.trim(),
            epg_url_8k: byId('new-license-epg').value.trim(),
            epgenius_key: byId('new-license-epgenius-key').value.trim(),
            epgenius_url: byId('new-license-epgenius-url').value.trim(),
            history: [],
            created_at: new Date().toISOString()
        };
        const validation = validateLicense(license);
        if (validation) {
            byId('new-license-error').textContent = validation;
            return;
        }
        if (!window.confirm(`Create ${license.label || license.username_8k} as a new Strong8K license?`)) return;

        const userId = local.activeUserId;
        try {
            await runTransaction(db, async transaction => {
                const profileRef = doc(db, 'strong8k_profiles', userId);
                const snapshot = await transaction.get(profileRef);
                const licenses = snapshot.exists() && Array.isArray(snapshot.data().licenses)
                    ? [...snapshot.data().licenses]
                    : [];
                licenses.push(license);
                transaction.set(profileRef, { licenses, updated_at: new Date().toISOString() }, { merge: true });
            });
            state.currentLicenses.push(license);
            state.strong8kProfiles[userId] = {
                ...(state.strong8kProfiles[userId] || normalizeStrong8kProfile({}, {})),
                licenses: state.currentLicenses
            };
            closeNewLicenseForm();
            renderLicenses();
            showToast('License created');
        } catch (error) {
            console.error('Unable to create license', error);
            byId('new-license-error').textContent = error.message || 'The license could not be created.';
        }
    }

    async function removeLicense(licenseId) {
        const license = state.currentLicenses.find(item => item.id === licenseId);
        if (!license) return;
        if (!window.confirm(`Remove ${license.label || license.username_8k || 'this license'} from the customer profile? This does not cancel it with Strong8K.`)) return;
        const userId = local.activeUserId;
        try {
            await runTransaction(db, async transaction => {
                const profileRef = doc(db, 'strong8k_profiles', userId);
                const snapshot = await transaction.get(profileRef);
                const licenses = snapshot.exists() && Array.isArray(snapshot.data().licenses)
                    ? snapshot.data().licenses.filter(item => item.id !== licenseId)
                    : [];
                transaction.set(profileRef, { licenses, updated_at: new Date().toISOString() }, { merge: true });
            });
            state.currentLicenses = state.currentLicenses.filter(item => item.id !== licenseId);
            state.strong8kProfiles[userId].licenses = state.currentLicenses;
            renderLicenses();
            showToast('License removed');
        } catch (error) {
            console.error('Unable to remove license', error);
            showToast(error.message || 'The license could not be removed.', 'error');
        }
    }

    function openSupportEventForm() {
        const form = byId('support-event-form');
        form.hidden = false;
        form.reset();
        byId('support-event-occurred').value = toLocalDateTimeValue(new Date());
        byId('support-event-kind').value = 'setup';
        byId('support-event-visibility').value = 'internal';
        byId('support-event-error').textContent = '';
        byId('support-event-summary').focus({ preventScroll: true });
        window.requestAnimationFrame(() => scrollEditorFormIntoView(form));
    }

    function closeSupportEventForm() {
        const form = byId('support-event-form');
        if (!form) return;
        form.hidden = true;
        form.reset();
        byId('support-event-error').textContent = '';
    }

    function scrollEditorFormIntoView(form) {
        const stickyOffset = window.matchMedia('(max-width: 720px)').matches ? 220 : 112;
        const top = form.getBoundingClientRect().top + window.scrollY - stickyOffset;
        window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
    }

    async function createSupportEvent(event) {
        event.preventDefault();
        const occurredValue = byId('support-event-occurred').value;
        const summary = byId('support-event-summary').value.trim();
        if (!occurredValue || !summary) {
            byId('support-event-error').textContent = 'Date and summary are required.';
            return;
        }
        const record = {
            occurred_at: new Date(occurredValue).toISOString(),
            created_at: new Date().toISOString(),
            created_by: auth.currentUser?.uid || '',
            kind: byId('support-event-kind').value,
            visibility: byId('support-event-visibility').value,
            summary,
            details: byId('support-event-details').value.trim(),
            source_text: byId('support-event-source').value.trim()
        };
        try {
            const reference = await addDoc(collection(db, 'strong8k_profiles', local.activeUserId, 'support_events'), record);
            local.supportEvents.unshift({ id: reference.id, profile_id: local.activeUserId, ...record });
            local.supportEvents.sort((left, right) => String(right.occurred_at || '').localeCompare(String(left.occurred_at || '')));
            closeSupportEventForm();
            renderSupportTimeline();
            showToast('Support interaction added');
        } catch (error) {
            console.error('Unable to add support event', error);
            byId('support-event-error').textContent = error.message || 'The interaction could not be saved.';
        }
    }

    function renderSupportTimeline() {
        const container = byId('user-support-timeline');
        if (!local.supportEvents.length) {
            container.innerHTML = '<div class="user-timeline-empty">No dated interactions yet. Add the first setup, troubleshooting, renewal, or communication note above.</div>';
            return;
        }
        container.innerHTML = local.supportEvents.map(event => {
            const source = String(event.source_text || '').trim();
            return `
                <article class="user-timeline-item">
                    <time class="user-timeline-date" datetime="${escapeAttribute(event.occurred_at || '')}">${escapeHtml(formatDateTime(event.occurred_at))}</time>
                    <div>
                        <div class="user-timeline-title">${escapeHtml(event.summary || 'Support interaction')}</div>
                        ${event.details ? `<div class="user-timeline-copy">${escapeHtml(event.details)}</div>` : ''}
                        <div class="user-timeline-tags">
                            <span class="user-timeline-tag">${escapeHtml(SUPPORT_KINDS[event.kind] || 'Other')}</span>
                            <span class="user-timeline-tag ${event.visibility === 'shared' ? 'is-shared' : ''}">${event.visibility === 'shared' ? 'Shared with customer' : 'Internal'}</span>
                        </div>
                        ${source ? `<details class="mt-3"><summary class="cursor-pointer text-xs font-bold text-slate-600">View source text</summary><pre class="mt-2 whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">${escapeHtml(source)}</pre></details>` : ''}
                    </div>
                </article>`;
        }).join('');
    }

    function renderAccessEditor(user) {
        const memberships = state.membershipsByUser[user.id] || {};
        const strong = memberships[appIds.STRONG8K];
        const playoff = memberships[appIds.PLAYOFF];
        byId('member-strong8k-enabled').checked = Boolean(strong);
        byId('member-strong8k-role').value = strong?.role || 'member';
        byId('member-strong8k-status').value = strong?.status || 'active';
        byId('member-playoff-enabled').checked = Boolean(playoff);
        byId('member-playoff-role').value = playoff?.role || 'member';
        byId('member-playoff-status').value = playoff?.status || 'active';
        byId('member-playoff-pools').innerHTML = state.pools.length
            ? state.pools.map(pool => `
                <label class="user-pool-option">
                    <input type="checkbox" value="${escapeAttribute(pool.id)}" ${playoff?.pool_ids?.includes(pool.id) ? 'checked' : ''}>
                    <span>${escapeHtml(pool.name || pool.id)}${pool.status ? ` / ${escapeHtml(pool.status)}` : ''}</span>
                </label>`).join('')
            : '<p class="text-xs text-slate-500">No playoff pools are available.</p>';
        toggleAccessPanels();
        local.accessBaseline = JSON.stringify(collectAccessDraft());
        updateAccessDraft();
    }

    function collectAccessDraft() {
        return {
            strong8k: {
                enabled: byId('member-strong8k-enabled').checked,
                role: byId('member-strong8k-role').value,
                status: byId('member-strong8k-status').value
            },
            playoff: {
                enabled: byId('member-playoff-enabled').checked,
                role: byId('member-playoff-role').value,
                status: byId('member-playoff-status').value,
                pool_ids: [...byId('member-playoff-pools').querySelectorAll('input:checked')].map(input => input.value).sort()
            }
        };
    }

    function toggleAccessPanels() {
        byId('strong8k-membership-panel').classList.toggle('hidden', !byId('member-strong8k-enabled').checked);
        byId('playoff-membership-panel').classList.toggle('hidden', !byId('member-playoff-enabled').checked);
    }

    function updateAccessDraft() {
        toggleAccessPanels();
        const draft = JSON.stringify(collectAccessDraft());
        const changed = Boolean(local.accessBaseline && draft !== local.accessBaseline);
        byId('user-access-apply').disabled = !changed;
        byId('user-access-summary').textContent = changed
            ? 'Access changes are waiting for review. Nothing has been applied yet.'
            : 'No access changes waiting.';
    }

    async function applyAccessChanges() {
        const user = state.users.find(item => item.id === local.activeUserId);
        if (!user) return;
        const draft = collectAccessDraft();
        const previousMemberships = state.membershipsByUser[user.id] || {};
        const summary = [
            `Strong8K: ${draft.strong8k.enabled ? `${draft.strong8k.status}, ${draft.strong8k.role}` : 'disabled'}`,
            `Playoff Pool: ${draft.playoff.enabled ? `${draft.playoff.status}, ${draft.playoff.role}, ${draft.playoff.pool_ids.length} pool(s)` : 'disabled'}`
        ].join('\n');
        if (!window.confirm(`Apply these access changes for ${user.full_name || user.email}?\n\n${summary}`)) return;

        const button = byId('user-access-apply');
        button.disabled = true;
        button.textContent = 'Applying...';
        try {
            await flushAutosaves();
            await syncMembership(user.id, appIds.STRONG8K, draft.strong8k.enabled, {
                app_id: appIds.STRONG8K,
                role: draft.strong8k.role,
                status: draft.strong8k.status,
                pool_ids: [],
                invite_code_used: previousMemberships[appIds.STRONG8K]?.invite_code_used || '',
                created_at: previousMemberships[appIds.STRONG8K]?.created_at || new Date().toISOString()
            });
            await syncMembership(user.id, appIds.PLAYOFF, draft.playoff.enabled, {
                app_id: appIds.PLAYOFF,
                role: draft.playoff.role,
                status: draft.playoff.status,
                pool_ids: draft.playoff.pool_ids,
                invite_code_used: previousMemberships[appIds.PLAYOFF]?.invite_code_used || '',
                created_at: previousMemberships[appIds.PLAYOFF]?.created_at || new Date().toISOString()
            });
            await syncPoolMembers(
                user.id,
                user,
                previousMemberships[appIds.PLAYOFF]?.pool_ids || [],
                draft.playoff.enabled ? draft.playoff.pool_ids : []
            );
            if (draft.strong8k.enabled) {
                await setDoc(doc(db, 'strong8k_profiles', user.id), {
                    status: draft.strong8k.status,
                    updated_at: new Date().toISOString()
                }, { merge: true });
            }
            showToast('Access changes applied');
            await reloadAdminData();
        } catch (error) {
            console.error('Unable to apply access changes', error);
            showToast(error.message || 'Access changes could not be applied.', 'error');
            button.disabled = false;
        } finally {
            button.textContent = 'Review and apply';
        }
    }

    async function migrateLegacyPrivateNote(profileId, legacyValue) {
        const legacyNotes = String(legacyValue || '').trim();
        if (!legacyNotes) return false;
        const privateRef = doc(db, 'strong8k_private', profileId);
        const privateSnapshot = await getDoc(privateRef);
        const existingNotes = privateSnapshot.exists() ? String(privateSnapshot.data().internal_notes || '').trim() : '';
        const nextNotes = existingNotes.includes(legacyNotes)
            ? existingNotes
            : [existingNotes, existingNotes ? `Legacy profile note:\n${legacyNotes}` : legacyNotes].filter(Boolean).join('\n\n');

        await setDoc(privateRef, {
            internal_notes: nextNotes,
            migrated_at: new Date().toISOString(),
            updated_by: auth.currentUser?.uid || ''
        }, { merge: true });
        const verification = await getDoc(privateRef);
        if (!verification.exists() || !String(verification.data().internal_notes || '').includes(legacyNotes)) {
            throw new Error(`Private note verification failed for ${profileId}.`);
        }
        await updateDoc(doc(db, 'strong8k_profiles', profileId), { internal_notes: deleteField() });
        if (state.strong8kProfiles[profileId]) delete state.strong8kProfiles[profileId].internal_notes;
        return true;
    }

    async function migrateAllPrivateNotes() {
        const button = byId('private-notes-migration-btn');
        const result = byId('private-notes-migration-result');
        const candidates = Object.entries(state.strong8kProfiles)
            .filter(([, profile]) => String(profile.internal_notes || '').trim());
        if (!candidates.length) {
            result.textContent = 'No legacy private notes need migration.';
            return;
        }
        if (!window.confirm(`Move ${candidates.length} legacy private note${candidates.length === 1 ? '' : 's'} into admin-only storage?`)) return;
        button.disabled = true;
        result.textContent = 'Migration in progress...';
        let migrated = 0;
        const failures = [];
        for (const [profileId, profile] of candidates) {
            try {
                if (await migrateLegacyPrivateNote(profileId, profile.internal_notes)) migrated += 1;
            } catch (error) {
                console.error(`Private note migration failed for ${profileId}`, error);
                failures.push(profileId);
            }
        }
        result.textContent = failures.length
            ? `${migrated} migrated. ${failures.length} failed and were left in place for retry.`
            : `${migrated} private note${migrated === 1 ? '' : 's'} migrated and verified.`;
        button.disabled = false;
    }

    function openNewUserModal() {
        const modal = byId('new-user-modal');
        modal.hidden = false;
        byId('new-user-form').reset();
        byId('new-user-error').textContent = '';
        document.body.classList.add('overflow-hidden');
        window.setTimeout(() => byId('new-user-name').focus(), 0);
    }

    function closeNewUserModal() {
        byId('new-user-modal').hidden = true;
        document.body.classList.remove('overflow-hidden');
    }

    async function createUserShell(event) {
        event.preventDefault();
        const name = byId('new-user-name').value.trim();
        const email = byId('new-user-email').value.trim().toLowerCase();
        const errorNode = byId('new-user-error');
        const submit = byId('new-user-submit');
        if (!name || !email || !byId('new-user-email').checkValidity()) {
            errorNode.textContent = 'A name and valid email address are required.';
            return;
        }

        submit.disabled = true;
        submit.textContent = 'Creating...';
        try {
            let existing = state.users.find(user => String(user.email || '').trim().toLowerCase() === email) || null;
            if (!existing) {
                const snapshot = await getDocs(query(collection(db, 'users'), where('email', '==', email)));
                const existingDoc = snapshot.docs[0];
                if (existingDoc) existing = { id: existingDoc.id, ...existingDoc.data() };
            }
            if (existing) {
                if (existing.deleted) {
                    if (!window.confirm('A profile with this email is archived. Restore and open it?')) return;
                    await updateDoc(doc(db, 'users', existing.id), {
                        deleted: false,
                        full_name: name || existing.full_name || '',
                        email,
                        restored_at: new Date().toISOString()
                    });
                    await reloadAdminData();
                }
                closeNewUserModal();
                showToast('Existing profile opened');
                open(existing.id);
                return;
            }

            const reference = await addDoc(collection(db, 'users'), {
                ...defaultSharedUser(email),
                full_name: name,
                email,
                created_by_admin: true
            });
            closeNewUserModal();
            await reloadAdminData();
            open(reference.id);
            showToast('Customer profile created');
        } catch (error) {
            console.error('Unable to create user profile', error);
            errorNode.textContent = error.message || 'The profile could not be created.';
        } finally {
            submit.disabled = false;
            submit.textContent = 'Create profile';
        }
    }

    async function archiveActiveUser() {
        const user = state.users.find(item => item.id === local.activeUserId);
        if (!user) return;
        if (!window.confirm(`Archive ${user.full_name || user.email}? This hides the profile but does not delete their Firebase Auth account or cancel any Strong8K license.`)) return;
        try {
            await flushAutosaves();
            await updateDoc(doc(db, 'users', user.id), {
                deleted: true,
                archived_at: new Date().toISOString()
            });
            window.location.hash = '#people';
            await reloadAdminData();
            showToast('Customer profile archived');
        } catch (error) {
            console.error('Unable to archive user', error);
            showToast(error.message || 'The profile could not be archived.', 'error');
        }
    }

    async function navigateToPeople() {
        await flushAutosaves();
        if (local.autosave.failed && !window.confirm('A profile change could not be saved. Leave the profile anyway?')) return;
        window.location.hash = '#people';
    }

    function trapModalFocus(event) {
        if (event.key !== 'Tab') return;
        const modal = byId('new-user-modal');
        const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function toLocalDateTimeValue(date) {
        const offset = date.getTimezoneOffset();
        return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
    }

    function formatDateTime(value) {
        if (!value) return 'Date not recorded';
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return value;
        return new Intl.DateTimeFormat('en-CA', {
            dateStyle: 'medium',
            timeStyle: 'short'
        }).format(parsed);
    }

    function escapeAttribute(value) {
        return escapeHtml(String(value ?? '')).replace(/`/g, '&#96;');
    }

    return {
        bind,
        handleDataLoaded,
        open
    };
}
