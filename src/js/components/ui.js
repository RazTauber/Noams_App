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
                <input type="text" value="${escapeHtml(passenger.address)}" 
                       data-index="${index}" data-field="address">
            </td>
            <td style="text-align: center;">
                <input type="checkbox" ${passenger.isSpecial ? 'checked' : ''} 
                       data-index="${index}" data-field="isSpecial">
            </td>
            <td>
                <div class="exception-time-cell">
                    <input type="time" value="${passenger.exceptionTime}" 
                           data-index="${index}" data-field="exceptionTime">
                    <button class="btn-clear-time ${passenger.exceptionTime ? '' : 'hidden'}" 
                            data-action="clearTime" data-index="${index}" title="Clear exception time">✕</button>
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

                if (field === 'exceptionTime') {
                    const clearBtn = tr.querySelector('[data-action="clearTime"]');
                    clearBtn.classList.toggle('hidden', !value);
                }
            });
        });

        const clearTimeBtn = tr.querySelector('[data-action="clearTime"]');
        clearTimeBtn.addEventListener('click', () => {
            const timeInput = tr.querySelector('[data-field="exceptionTime"]');
            timeInput.value = '';
            onUpdate(index, 'exceptionTime', '');
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

        const statusTag = taxi.isSpecial ? ' (Special)' : taxi.hasError ? ' (Error - Address)' : taxiHasEstimates ? ' (~Estimated)' : '';
        const canMerge = !taxi.isSpecial && !taxi.hasError;
        const isMergeTarget = mergeSelectedTaxiId && mergeSelectedTaxiId !== taxi.id && canMerge;

        const passengersHtml = taxi.passengers.map(p => {
            const delayClass = p.delay === null ? '' : p.delay <= 10 ? 'delay-ok' : 'delay-warning';
            const delayText = p.delay === null ? '—' : formatDelay(p.delay);
            const pickupTimeText = p.isEstimated ? `~${p.pickupTime || '—'}` : (p.pickupTime || '—');
            const showSeparate = taxi.passengers.length > 1 && !taxi.isSpecial;

            return `
                <div class="taxi-passenger${p.isEstimated ? ' taxi-passenger-estimated' : ''}">
                    <div class="taxi-passenger-info">
                        <div class="taxi-passenger-name">${escapeHtml(p.name)}</div>
                        <div class="taxi-passenger-address">${escapeHtml(p.address)}</div>
                    </div>
                    <span class="taxi-passenger-pickup">${pickupTimeText}</span>
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

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
