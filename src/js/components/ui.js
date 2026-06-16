import { formatDelay } from '../utils/helpers.js';

/**
 * Renders the passenger editing table.
 */
export function renderPassengerTable(passengers, onRemove, onUpdate) {
    const tbody = document.getElementById('passengersBody');
    tbody.innerHTML = '';

    passengers.forEach((passenger, index) => {
        const tr = document.createElement('tr');
        if (passenger.status === 'error') tr.classList.add('passenger-error');

        tr.innerHTML = `
            <td>
                <input type="text" value="${escapeHtml(passenger.name)}" 
                       data-index="${index}" data-field="name">
            </td>
            <td>
                <input type="tel" value="${escapeHtml(passenger.phone)}" 
                       data-index="${index}" data-field="phone">
            </td>
            <td>
                <input type="text" value="${escapeHtml(passenger.address)}" 
                       data-index="${index}" data-field="address">
            </td>
            <td style="text-align: center;">
                <input type="checkbox" ${passenger.isSpecial ? 'checked' : ''} 
                       data-index="${index}" data-field="isSpecial">
            </td>
            <td>
                <div class="exception-time-cell">
                    <input type="time" value="${passenger.arrivalTime}" 
                           data-index="${index}" data-field="arrivalTime">
                    <button class="btn-clear-time ${passenger.arrivalTime ? '' : 'hidden'}" 
                            data-action="clearTime" data-index="${index}" title="Clear arrival time">✕</button>
                </div>
            </td>
            <td style="text-align: center;">
                <button class="btn-danger" data-action="remove" data-index="${index}">
                    Remove
                </button>
            </td>
        `;

        const inputs = tr.querySelectorAll('input');
        inputs.forEach(input => {
            input.addEventListener('change', () => {
                const field = input.dataset.field;
                const value = field === 'isSpecial' ? input.checked : input.value;
                onUpdate(index, field, value);

                if (field === 'arrivalTime') {
                    const clearBtn = tr.querySelector('[data-action="clearTime"]');
                    clearBtn.classList.toggle('hidden', !value);
                }
            });
        });

        const clearTimeBtn = tr.querySelector('[data-action="clearTime"]');
        clearTimeBtn.addEventListener('click', () => {
            const timeInput = tr.querySelector('[data-field="arrivalTime"]');
            timeInput.value = '';
            onUpdate(index, 'arrivalTime', '');
            clearTimeBtn.classList.add('hidden');
        });

        const removeBtn = tr.querySelector('[data-action="remove"]');
        removeBtn.addEventListener('click', () => onRemove(index));

        tbody.appendChild(tr);
    });

    document.getElementById('editSection').classList.remove('hidden');
}

/**
 * Renders taxi result cards with merge and separate capabilities.
 */
let mergeSelectedTaxiId = null;

export function renderTaxiCards(taxis, onSeparate, onMerge, onRefine) {
    const grid = document.getElementById('taxiCardsGrid');
    grid.innerHTML = '';

    const hasAnyEstimates = taxis.some(t => t.passengers.some(p => p.isEstimated));

    for (const taxi of taxis) {
        const card = document.createElement('div');
        card.classList.add('taxi-card');
        card.dataset.taxiId = taxi.id;
        const taxiHasEstimates = taxi.passengers.some(p => p.isEstimated);
        if (taxi.hasError) card.style.borderColor = 'var(--danger-color)';
        else if (taxi.isSpecial) card.style.borderColor = 'var(--warning-color)';
        else if (taxiHasEstimates) card.style.borderColor = 'var(--warning-color)';
        if (mergeSelectedTaxiId === taxi.id) card.classList.add('taxi-card-merge-selected');

        const taxiHasNoTraffic = taxi.passengers.length > 1 && taxi.passengers.some(p => p.noTrafficData);
        const statusTag = taxi.isSpecial ? ' (Special)' : taxi.hasError ? ' (Error - Address)' : taxiHasEstimates ? ' (~Estimated)' : '';
        const canMerge = !taxi.isSpecial && !taxi.hasError;
        const isMergeTarget = mergeSelectedTaxiId && mergeSelectedTaxiId !== taxi.id && canMerge;

        const passengersHtml = taxi.passengers.map((p, pIdx) => {
            const delayClass = p.delay === null ? '' : p.delay <= 5 ? 'delay-ok' : p.delay <= 12 ? 'delay-warning' : 'delay-danger';
            const isShared = taxi.passengers.length > 1 && !taxi.isSpecial;
            const isLastPickup = pIdx === taxi.passengers.length - 1;
            const delayText = p.delay === null ? '—' : formatDelay(p.delay, { isSharedNonLast: isShared && !isLastPickup });
            const pickupTimeText = p.isEstimated ? `~${p.pickupTime || '—'}` : (p.pickupTime || '—');
            const showSeparate = taxi.passengers.length > 1 && !taxi.isSpecial;

            return `
                <div class="taxi-passenger${p.isEstimated ? ' taxi-passenger-estimated' : ''}">
                    <div class="taxi-passenger-info">
                        <div class="taxi-passenger-name">${escapeHtml(p.name)}${p.phone ? ` <span class="taxi-passenger-phone">${escapeHtml(p.phone)}</span>` : ''}</div>
                        <div class="taxi-passenger-address">${escapeHtml(p.address)}</div>
                    </div>
                    <span class="taxi-passenger-pickup" ${p.noTrafficData ? 'title="Pickup time estimated via Distance Matrix (no live route traffic)"' : ''}>${pickupTimeText}${p.noTrafficData ? ' *' : ''}</span>
                    <span class="taxi-passenger-delay ${delayClass}">${delayText}</span>
                    ${showSeparate ? `<button class="btn-danger btn-separate" data-taxi="${taxi.id}" data-passenger="${p.id}">Separate</button>` : ''}
                </div>
            `;
        }).join('');

        let mergeButtonHtml = '';
        if (canMerge) {
            if (mergeSelectedTaxiId === taxi.id) {
                mergeButtonHtml = `<button class="btn-merge btn-merge-cancel" data-merge-taxi="${taxi.id}">Cancel</button>`;
            } else if (isMergeTarget) {
                mergeButtonHtml = `<button class="btn-merge btn-merge-confirm" data-merge-taxi="${taxi.id}">Merge Here</button>`;
            } else {
                mergeButtonHtml = `<button class="btn-merge" data-merge-taxi="${taxi.id}">Merge</button>`;
            }
        }

        card.innerHTML = `
            <div class="taxi-card-header">
                <span class="taxi-card-number">Taxi #${taxi.number}${statusTag}</span>
                <div class="taxi-card-actions">
                    ${mergeButtonHtml}
                    <span class="taxi-card-count">${taxi.passengers.length} passengers</span>
                </div>
            </div>
            ${passengersHtml}
        `;

        const separateBtns = card.querySelectorAll('.btn-separate');
        separateBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                onSeparate(btn.dataset.taxi, btn.dataset.passenger);
            });
        });

        const mergeBtn = card.querySelector('[data-merge-taxi]');
        if (mergeBtn) {
            mergeBtn.addEventListener('click', () => {
                const clickedTaxiId = mergeBtn.dataset.mergeTaxi;

                if (mergeSelectedTaxiId === clickedTaxiId) {
                    mergeSelectedTaxiId = null;
                    renderTaxiCards(taxis, onSeparate, onMerge, onRefine);
                } else if (mergeSelectedTaxiId && clickedTaxiId !== mergeSelectedTaxiId) {
                    const id1 = mergeSelectedTaxiId;
                    mergeSelectedTaxiId = null;
                    onMerge(id1, clickedTaxiId);
                } else {
                    mergeSelectedTaxiId = clickedTaxiId;
                    renderTaxiCards(taxis, onSeparate, onMerge, onRefine);
                }
            });
        }

        grid.appendChild(card);
    }

    if (hasAnyEstimates && onRefine) {
        const refineBtn = document.createElement('button');
        refineBtn.className = 'btn-primary btn-refine';
        refineBtn.textContent = 'Refine Routes';
        refineBtn.addEventListener('click', onRefine);
        grid.insertBefore(refineBtn, grid.firstChild);
    }

    document.getElementById('resultsSection').classList.add('visible');
    document.getElementById('exportSection').classList.add('visible');
}

export function resetMergeSelection() {
    mergeSelectedTaxiId = null;
}

/**
 * Show a status message.
 */
export function showStatus(elementId, message, type = 'loading') {
    const el = document.getElementById(elementId);
    el.textContent = message;
    el.className = `status-message visible status-${type}`;
}

/**
 * Hide a status message.
 */
export function hideStatus(elementId) {
    const el = document.getElementById(elementId);
    el.className = 'status-message';
}

// ── API cost toast notifications ──────────────────────────────────────────────

let _toastContainer = null;

function getToastContainer() {
    if (!_toastContainer) {
        _toastContainer = document.createElement('div');
        _toastContainer.id = 'api-toast-container';
        document.body.appendChild(_toastContainer);
    }
    return _toastContainer;
}

/**
 * Show a dismissible toast alert for API cost/call milestones.
 * @param {'cost'|'calls'} type
 * @param {number} cost   - cumulative estimated cost in USD
 * @param {number} calls  - total API call count
 */
export function showApiAlert(type, cost, calls) {
    const container = getToastContainer();

    const toast = document.createElement('div');
    toast.className = 'api-toast';

    const icon  = type === 'cost' ? '💳' : '📡';
    const title = type === 'cost'
        ? `~$${cost.toFixed(2)} in Maps API costs this session`
        : `${calls} Maps API calls this session`;
    const sub   = type === 'cost'
        ? `${calls} requests · ~$${cost.toFixed(3)} estimated`
        : `~$${cost.toFixed(3)} estimated cost`;

    toast.innerHTML = `
        <span class="api-toast-icon">${icon}</span>
        <div class="api-toast-body">
            <div class="api-toast-title">${title}</div>
            <div class="api-toast-sub">${sub}</div>
        </div>
        <button class="api-toast-close" aria-label="Dismiss">✕</button>
    `;

    toast.querySelector('.api-toast-close').addEventListener('click', () => dismissToast(toast));

    container.appendChild(toast);
    // Trigger CSS enter animation
    requestAnimationFrame(() => toast.classList.add('api-toast-visible'));

    // Auto-dismiss after 8 s
    setTimeout(() => dismissToast(toast), 8000);
}

function dismissToast(toast) {
    toast.classList.remove('api-toast-visible');
    toast.classList.add('api-toast-leaving');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
